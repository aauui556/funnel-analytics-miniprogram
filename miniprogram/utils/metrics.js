/**
 * 纯前端计算引擎（D10 / D11 / D12 / D13 / D14 / D21 / D24）。
 *
 * ADR-0006：这里的所有计算都在前端完成，不经过云函数。
 * 本模块刻意不依赖任何小程序 API，因而可以用 Node.js 直接跑用例——
 * 转化率口径、除零、环比、异常判定这些规则一旦写错，图表看起来仍然"很正常"，
 * 所以它们必须能被测试，而不是靠肉眼确认。
 */

// D21：相对阈值 30%。这是初始猜测值，不是从数据推算出来的，上线后需用真实数据校准。
const THRESHOLD = 0.3;

// D21：参与判定的样本量低于 20 时不判定。
const MIN_SAMPLE = 20;

// D26：图表最多展示最近 30 天。
const MAX_WINDOW = 30;

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 用 UTC 做日期加减，避开本地时区把日期推错一天。 */
function addDays(dateText, delta) {
  const parts = dateText.split('-');
  const base = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  const d = new Date(base + delta * 86400000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** 生成 [start, end] 之间的连续日期（升序），含两端。 */
function listDates(start, end) {
  const out = [];
  let cursor = start;
  // 上限保护：避免传入异常范围时构造出天量数组
  for (let guard = 0; guard < 400 && cursor <= end; guard++) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * D11 的逐步转化率。返回值有三种 kind：
 *   ok            —— 可计算（含"上一阶段 > 0 且本阶段 = 0"，那正是真实的 0%）
 *   undefined     —— 上一阶段 = 0 且本阶段 = 0：0/0 没有数学定义
 *   contradictory —— 上一阶段 = 0 但本阶段 > 0：人数不可能凭空增加，必然是录入错误
 */
function stepRate(prev, curr) {
  const p = Number(prev);
  const c = Number(curr);

  if (!Number.isFinite(p) || !Number.isFinite(c)) return { kind: 'undefined', value: null };
  if (p === 0) {
    return c > 0 ? { kind: 'contradictory', value: null } : { kind: 'undefined', value: null };
  }
  return { kind: 'ok', value: c / p };
}

/** 把转化率渲染成给使用者看的文本。D11：不可计算一律用 —，绝不填 0%。 */
function rateText(rate) {
  if (!rate) return '—';
  if (rate.kind === 'ok') return (rate.value * 100).toFixed(1) + '%';
  if (rate.kind === 'contradictory') return '—'; // 数值旁边另有"矛盾数据"标记
  return '—';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 计算某个日期区间的各阶段合计。
 * 只统计"当天确实有记录"的日子——没有记录的日子不参与，也绝不当成 0（D9 的语义延续）。
 */
function totalsFor(dates, byDate, stageCount) {
  const totals = new Array(stageCount).fill(0);
  let daysWithData = 0;

  dates.forEach((date) => {
    const counts = byDate[date];
    if (!counts) return;
    daysWithData += 1;
    for (let i = 0; i < stageCount; i++) {
      totals[i] += num(counts[i]);
    }
  });

  return { totals, daysWithData };
}

/** 均值（只对有效数字求平均），没有任何有效值时返回 null。 */
function mean(values) {
  let sum = 0;
  let n = 0;
  values.forEach((v) => {
    if (Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  });
  return n === 0 ? null : sum / n;
}

/**
 * D12 的环比比较。
 * 样本量门槛在这里同样适用：P1 原则要求"数据不足时拒绝给结论"，而环比本身就是一个结论。
 */
function compareRates(previousRate, currentRate, sampleSize) {
  if (sampleSize < MIN_SAMPLE) {
    return {
      available: false,
      reason: '样本过小（' + sampleSize + ' < ' + MIN_SAMPLE + '），暂不给结论'
    };
  }
  if (!previousRate || previousRate.kind !== 'ok') {
    return { available: false, reason: '上一周期不可计算' };
  }
  if (previousRate.value === 0) {
    return { available: false, reason: '上一周期为 0，比值无意义' };
  }
  if (!currentRate || currentRate.kind !== 'ok') {
    return { available: false, reason: '当前周期不可计算' };
  }

  const change = (currentRate.value - previousRate.value) / previousRate.value;
  return {
    available: true,
    previous: previousRate.value,
    current: currentRate.value,
    change,
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat'
  };
}

/** D13 / D17：异常的判定依据必须是一句人能读懂、也能反驳的话。 */
function buildAnomalyReason(label, change, threshold) {
  const percent = Math.round(Math.abs(change) * 100);
  const direction = change < 0 ? '下降' : '上升';
  return label + '较上期' + direction + ' ' + percent + '%，超过 ' + Math.round(threshold * 100) + '% 阈值';
}

/**
 * 计算整页所需的全部指标。
 *
 * @param {{stages: string[]}} funnel
 * @param {Array<{date: string, counts: number[]}>} records  已按 app 拉取的全部记录（可多于窗口）
 * @param {number} windowSize  D12 的窗口长度（7 / 14 / 30）
 */
function calculateMetrics(funnel, records, windowSize) {
  const size = Math.min(Math.max(Number(windowSize) || 7, 1), MAX_WINDOW);
  const stages = Array.isArray(funnel && funnel.stages) ? funnel.stages : [];

  const rows = (Array.isArray(records) ? records : [])
    .filter((r) => r && typeof r.date === 'string' && Array.isArray(r.counts))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const byDate = {};
  rows.forEach((r) => {
    byDate[r.date] = r.counts;
  });

  const result = {
    stages,
    windowSize: size,
    threshold: THRESHOLD,
    minSample: MIN_SAMPLE,
    // D24：锚在**最新一条记录的日期**，不是今天。
    // 使用者的数据最新日期几乎不会是今天，锚在今天会让图表大部分时候空着。
    anchorDate: rows.length ? rows[rows.length - 1].date : null,
    hasData: rows.length > 0 && stages.length > 0,
    windowDates: [],
    windowTotals: [],
    windowDaysWithData: 0,
    previousWindowDaysWithData: 0,
    funnelRows: [],
    overall: { kind: 'undefined', value: null },
    overallText: '—',
    daily: [],
    entrySeries: [],
    lineSeries: { overall: [], steps: [] },
    comparison: { available: false, reason: '还没有数据', overall: null, steps: [], entry: null },
    anomalies: []
  };

  if (!result.hasData) return result;

  const anchorDate = result.anchorDate;
  // 当前窗口与上一窗口各自是 size 个**自然日**（D24：向前推窗口长度）
  const windowDates = listDates(addDays(anchorDate, -(size - 1)), anchorDate);
  const previousDates = listDates(addDays(anchorDate, -(2 * size - 1)), addDays(anchorDate, -size));

  const current = totalsFor(windowDates, byDate, stages.length);
  const previous = totalsFor(previousDates, byDate, stages.length);

  result.windowDates = windowDates;
  result.windowTotals = current.totals;
  result.windowDaysWithData = current.daysWithData;
  result.previousWindowDaysWithData = previous.daysWithData;

  // 漏斗图用的是**窗口内合计**（"最近 7 天的漏斗"），这也是顶部整体转化率的来源。
  // 口径（各阶段人数之比、不做同批人去重）会由页面显式声明，见 D2。
  const maxCount = current.totals.reduce((m, v) => Math.max(m, v), 0);
  result.funnelRows = stages.map((name, index) => {
    const count = current.totals[index];
    return {
      index,
      name,
      count,
      // D19：宽度严格按人数比例。这里以窗口内最大值为基准，
      // 若数据异常导致后段大于首段也不会画出超界的图形。
      widthRatio: maxCount > 0 ? count / maxCount : 0,
      step: index === 0 ? { kind: 'baseline', value: 1 } : stepRate(current.totals[index - 1], count)
    };
  });

  result.overall = stepRate(current.totals[0], current.totals[stages.length - 1]);
  result.overallText = rateText(result.overall);

  // 每日明细：折线图与异常检测都基于它
  result.daily = windowDates.map((date) => {
    const counts = byDate[date] || null;
    const steps = [];
    if (counts) {
      for (let i = 1; i < stages.length; i++) {
        steps.push(stepRate(counts[i - 1], counts[i]));
      }
    }
    return {
      date,
      hasData: !!counts,
      counts,
      entry: counts ? num(counts[0]) : null,
      steps,
      overall: counts ? stepRate(counts[0], counts[counts.length - 1]) : { kind: 'undefined', value: null }
    };
  });

  // D14 / D6：入口人数单独一条序列，不与转化率共图（量纲不同，共轴会互相失真）
  result.entrySeries = result.daily.map((day) => ({ date: day.date, value: day.entry }));

  // D16：折线图默认整体转化率，可切换到任一步的逐步转化率；不做多线叠加
  result.lineSeries.overall = result.daily.map((day) => ({ date: day.date, rate: day.overall }));
  result.lineSeries.steps = stages.slice(1).map((name, i) => ({
    index: i + 1,
    name,
    points: result.daily.map((day) => ({
      date: day.date,
      rate: day.hasData ? day.steps[i] : { kind: 'undefined', value: null }
    }))
  }));

  // ---- D12 环比 ----
  const comparison = {
    available: false,
    reason: '',
    overall: null,
    steps: [],
    entry: null
  };

  // D12：数据不足以凑齐一个完整周期时，环比显示 —
  if (current.daysWithData < size) {
    comparison.reason = '当前周期只有 ' + current.daysWithData + ' 天有数据，不足 ' + size + ' 天';
  } else if (previous.daysWithData < size) {
    comparison.reason = '上一周期只有 ' + previous.daysWithData + ' 天有数据，不足 ' + size + ' 天';
  } else {
    comparison.available = true;

    comparison.overall = compareRates(
      stepRate(previous.totals[0], previous.totals[stages.length - 1]),
      stepRate(current.totals[0], current.totals[stages.length - 1]),
      previous.totals[0]
    );

    comparison.steps = stages.slice(1).map((name, i) => {
      const index = i + 1;
      const item = compareRates(
        stepRate(previous.totals[index - 1], previous.totals[index]),
        stepRate(current.totals[index - 1], current.totals[index]),
        previous.totals[index - 1]
      );
      item.stageIndex = index;
      item.stageName = name;
      return item;
    });

    // 两个窗口都有完整 size 天数据，所以直接比合计即可（同口径）
    const entryPrev = previous.totals[0];
    const entryCurr = current.totals[0];
    if (entryPrev < MIN_SAMPLE) {
      comparison.entry = {
        available: false,
        reason: '样本过小（' + entryPrev + ' < ' + MIN_SAMPLE + '），暂不给结论'
      };
    } else {
      const change = (entryCurr - entryPrev) / entryPrev;
      comparison.entry = {
        available: true,
        previous: entryPrev,
        current: entryCurr,
        change,
        direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat'
      };
    }
  }

  result.comparison = comparison;

  // ---- D13 / D14 / D21 异常检测 ----
  // 规则式：当日值 vs 上一周期的日均值，相对变化超过阈值即标记。
  // 不用统计方法——n 很小时标准差会吞掉异常值本身，给出虚假的确定性。
  // 基线要求上一周期完整：D13 规定数据不足以构成完整窗口时不产生异常点。
  const anomalies = [];

  if (previous.daysWithData >= size) {
    const previousDays = previousDates.map((d) => byDate[d]).filter(Boolean);

    const entryBaseline = mean(previousDays.map((c) => num(c[0])));

    const stepBaselines = [];
    for (let i = 1; i < stages.length; i++) {
      const values = previousDays
        .map((c) => stepRate(c[i - 1], c[i]))
        .filter((r) => r.kind === 'ok')
        .map((r) => r.value);
      stepBaselines.push(mean(values));
    }

    result.daily.forEach((day) => {
      if (!day.hasData) return;
      const counts = day.counts;

      // D14：入口人数（环境信号）——回答"流量本身是否变化"
      if (entryBaseline !== null && entryBaseline > 0 && day.entry >= MIN_SAMPLE) {
        const change = (day.entry - entryBaseline) / entryBaseline;
        if (Math.abs(change) >= THRESHOLD) {
          anomalies.push({
            date: day.date,
            kind: 'entry',
            stageIndex: 0,
            stageName: stages[0],
            value: day.entry,
            baseline: entryBaseline,
            change,
            direction: change < 0 ? 'down' : 'up',
            sampleSize: day.entry,
            reasonText: buildAnomalyReason('入口人数', change, THRESHOLD)
          });
        }
      }

      // D14：各步逐步转化率（过程信号）——回答"哪一环出了问题"
      for (let i = 1; i < stages.length; i++) {
        const baseline = stepBaselines[i - 1];
        if (baseline === null || baseline <= 0) continue;

        const rate = stepRate(counts[i - 1], counts[i]);
        const sampleSize = num(counts[i - 1]);

        // D21：样本量不足不判定，绝不为了"看起来有功能"而放宽门槛
        if (rate.kind !== 'ok' || sampleSize < MIN_SAMPLE) continue;

        const change = (rate.value - baseline) / baseline;
        if (Math.abs(change) >= THRESHOLD) {
          anomalies.push({
            date: day.date,
            kind: 'step',
            stageIndex: i,
            stageName: stages[i],
            value: rate.value,
            baseline,
            change,
            direction: change < 0 ? 'down' : 'up',
            sampleSize,
            reasonText:
              buildAnomalyReason(
                '「' + stages[i - 1] + '→' + stages[i] + '」转化率',
                change,
                THRESHOLD
              )
          });
        }
      }
    });
  }

  result.anomalies = anomalies;

  return result;
}

module.exports = {
  THRESHOLD,
  MIN_SAMPLE,
  MAX_WINDOW,
  addDays,
  listDates,
  stepRate,
  rateText,
  calculateMetrics
};
