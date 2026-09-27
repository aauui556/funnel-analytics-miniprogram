const { calculateMetrics, rateText, MAX_WINDOW } = require('../../utils/metrics');
const { buildFunnelLayout, buildLineLayout, buildColumnLayout } = require('../../utils/chart-geometry');

// 小程序端单次查询上限（ADR-0002 / ADR-0006）
const PAGE_SIZE = 20;

const COLOR_LINE = '#0f766e';
const COLOR_ANOMALY = '#b42318';
const COLOR_BAR = '#7c9cbf';
const FUNNEL_COLORS = ['#0f766e', '#159a8f', '#3fb0a4', '#6cc3b9', '#96d5ce', '#bfe6e2', '#e0f2f1'];

Page({
  data: {
    funnelId: '',
    funnelName: '',
    stages: [],

    loading: true,
    loadError: '',
    emptyHint: '',

    windowOptions: [7, 14, 30],
    windowSize: 7,

    // D16：默认整体转化率；可切换到任一步的逐步转化率
    metricOptions: [],
    metricKey: 'overall',

    overallText: '—',
    overallNote: '',          // D11 的不可计算 / 矛盾数据说明
    disclaimer: '口径：各阶段人数之比，不做同批人去重',   // D2
    windowLabel: '',
    comparisonLabel: '',
    comparisonValue: '—',
    comparisonReason: '',
    anomalySummary: '',
    anomalyItems: [],
    hasAnomalies: false,

    // 从导入页跳转过来时的回执（D26）
    banner: '',
    showBanner: false
  },

  _funnel: null,
  _records: [],
  _metrics: null,
  _lineLayout: null,
  _lineRect: null,

  onLoad(options) {
    const opts = options || {};
    const funnelId = opts.funnelId || '';

    if (!funnelId) {
      this.setData({
        loading: false,
        loadError: '缺少漏斗参数。请从首页某个漏斗进入。'
      });
      return;
    }

    // D26：导入成功后要在页面顶部如实交代"存了多少、能看到多少"
    if (opts.saved) {
      this.setData({
        showBanner: true,
        banner:
          '已保存 ' + opts.saved + ' 天，当前展示最近 ' + (opts.display || opts.saved) + ' 天'
      });
    }

    this.setData({ funnelId });
    this.bootstrap(funnelId);
  },

  onWindowChange(e) {
    const size = Number(e.currentTarget.dataset.size);
    if (size === this.data.windowSize) return;
    this.setData({ windowSize: size }, () => this.bootstrap(this.data.funnelId));
  },

  onMetricChange(e) {
    this.setData({ metricKey: e.detail.value }, () => this.renderAll());
  },

  /**
   * ADR-0006：读取走客户端直查，不经过云函数。
   * ADR-0003：隔离由安全规则「仅创建者可读写」保证，这里不手写 _openid 过滤条件。
   */
  bootstrap(funnelId) {
    this.setData({ loading: true, loadError: '' });

    wx.cloud
      .database()
      .collection('funnels')
      .doc(funnelId)
      .get()
      .then((res) => {
        const funnel = res.data || {};
        this._funnel = funnel;
        const stages = Array.isArray(funnel.stages) ? funnel.stages : [];

        const metricOptions = [{ key: 'overall', label: '整体转化率' }].concat(
          stages.slice(1).map((name, i) => ({
            key: 'step' + (i + 1),
            label: stages[i] + '→' + name
          }))
        );

        this.setData({
          funnelName: funnel.name || '',
          stages,
          metricOptions,
          // 切换窗口后如果原先选的步数不存在了，退回整体
          metricKey: metricOptions.some((m) => m.key === this.data.metricKey)
            ? this.data.metricKey
            : 'overall'
        });

        if (funnel.name) wx.setNavigationBarTitle({ title: funnel.name });

        return this.loadRecords(funnelId);
      })
      .catch((err) => {
        console.error('[funnel-detail] 读取漏斗失败', err);
        this.setData({
          loading: false,
          loadError:
            '读取漏斗失败：' + (err.errMsg || err.message || '未知错误')
        });
      });
  },

  /**
   * 分批拉取记录。
   * 小程序端单次查询上限 20 条（ADR-0002），而环比需要"当前窗口 + 上一窗口"共 2×窗口 天，
   * 所以 30 天窗口要取 60 天数据，必须翻页。这里用 async 循环把翻页收口在一个函数里。
   */
  async loadRecords(funnelId) {
    const db = wx.cloud.database();
    const _ = db.command;
    const span = this.data.windowSize * 2;

    try {
      // D24：先确定锚点——最新一条记录的日期，而不是今天
      const latest = await db
        .collection('records')
        .where({ funnelId })
        .orderBy('date', 'desc')
        .limit(1)
        .get();

      const anchor = latest.data && latest.data[0] ? latest.data[0].date : null;
      if (!anchor) {
        this._records = [];
        this.setData({ loading: false, emptyHint: '这个漏斗还没有数据，先去「录入数据」贴一份。' });
        return;
      }

      const start = shiftDate(anchor, -(span - 1));
      const collected = [];
      let skip = 0;

      for (let guard = 0; guard < 20; guard++) {
        const res = await db
          .collection('records')
          .where({ funnelId, date: _.gte(start).and(_.lte(anchor)) })
          .orderBy('date', 'asc')
          .skip(skip)
          .limit(PAGE_SIZE)
          .get();

        collected.push.apply(collected, res.data);
        if (res.data.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
      }

      this._records = collected;
      this.setData({ loading: false, emptyHint: '' });
      this.renderAll();
    } catch (err) {
      console.error('[funnel-detail] 读取记录失败', err);
      this.setData({
        loading: false,
        loadError:
          '读取数据失败：' + (err.errMsg || err.message || '未知错误') +
          '（请确认 records 集合权限为「仅创建者可读写」）'
      });
    }
  },

  // ---- 计算与渲染 ----

  renderAll() {
    const metrics = calculateMetrics(this._funnel, this._records, this.data.windowSize);
    this._metrics = metrics;

    if (!metrics.hasData) {
      this.setData({
        overallText: '—',
        overallNote: '',
        windowLabel: '',
        comparisonValue: '—',
        comparisonReason: '还没有数据',
        anomalySummary: '',
        hasAnomalies: false,
        anomalyItems: []
      });
      this.drawAll();
      return;
    }

    // D11：不可计算与矛盾数据要在整体转化率旁边说清楚，不能只给一个 —
    let overallNote = '';
    if (metrics.overall.kind === 'contradictory') {
      overallNote = '矛盾数据：首阶段为 0 人，末阶段却有人';
    } else if (metrics.overall.kind === 'undefined') {
      overallNote = '不可计算：首阶段为 0 人';
    }

    const comparison = metrics.comparison;
    let comparisonValue = '—';
    if (comparison.available && comparison.overall && comparison.overall.available) {
      comparisonValue = formatChange(comparison.overall.change);
    }

    // D17：跨图表的异常摘要——入口人数的异常不在折线图上，所以必须在这里汇总
    const anomalies = metrics.anomalies.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const anomalyItems = anomalies.map((item) => ({
      id: item.date + '_' + item.kind + '_' + item.stageIndex,
      date: item.date,
      reasonText: item.reasonText
    }));

    this.setData({
      overallText: metrics.overallText,
      overallNote,
      windowLabel:
        metrics.windowDates[0] + ' → ' + metrics.windowDates[metrics.windowDates.length - 1] +
        '（有数据 ' + metrics.windowDaysWithData + '/' + metrics.windowSize + ' 天）',
      comparisonValue,
      comparisonReason: comparison.available
        ? (comparison.overall && comparison.overall.available ? '' : (comparison.overall && comparison.overall.reason) || '')
        : comparison.reason,
      anomalySummary: anomalies.length
        ? '最近 ' + metrics.windowSize + ' 天有 ' + anomalies.length + ' 个异常点，点击查看判定依据'
        : '最近 ' + metrics.windowSize + ' 天没有异常点',
      hasAnomalies: anomalies.length > 0,
      anomalyItems
    });

    this.drawAll();
  },

  drawAll() {
    this.drawFunnel();
    this.drawLine();
    this.drawColumn();
  },

  /**
   * D18/D19/D20：梯形漏斗。
   * 几何全部由 chart-geometry 计算（严格按比例、无最小宽度、0 值虚线标记、标签内嵌/侧置），
   * 这里只负责把算好的坐标画到画布上。
   */
  drawFunnel() {
    const metrics = this._metrics;
    if (!metrics) return;

    withCanvas(this, '#funnelCanvas', (ctx, width, height) => {
      // 底部说明文字要占一行，必须先把它从绘图区高度里扣掉。
      // 否则梯形会铺满整个画布，说明文字压在最后一段上、又贴着下沿被裁。
      const CAPTION_HEIGHT = 22;

      // D10：第一阶段的逐步转化率是基准，显示 100%。
      // 这里必须显式判断 kind === 'baseline'：rateText 的兜底分支只认识
      // ok / contradictory / undefined，baseline 会掉进兜底返回「—」——
      // 那是「不可计算」的符号，挂在首段上会被当成数据有问题。
      const rows = metrics.funnelRows.map((row) => ({
        name: row.name,
        count: row.count,
        label:
          row.name +
          '  ' +
          formatCount(row.count) +
          '  ' +
          (row.step && row.step.kind === 'baseline' ? '100%' : rateText(row.step))
      }));

      const layout = buildFunnelLayout(rows, {
        width,
        // 漏斗只用扣掉说明行之后的高度，几何逻辑本身不变
        height: Math.max(height - CAPTION_HEIGHT, 40),
        bandGap: 6,
        fontSize: 12,
        sideGap: 10,
        markerHalf: 12,
        measure: (text, size) => measureText(ctx, text, size)
      });

      layout.bands.forEach((band, index) => {
        const centerX = layout.centerX;

        if (band.count === 0) {
          // D20：宽度为 0 的阶段画不出形状，但必须让人知道"这一段存在"。
          // 极细虚线不对数值做任何声张——这与"最小宽度"是两回事。
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#98a2b3';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(band.marker.x1, band.marker.y);
          ctx.lineTo(band.marker.x2, band.marker.y);
          ctx.stroke();
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.moveTo(centerX - band.topHalf, band.top);
          ctx.lineTo(centerX + band.topHalf, band.top);
          ctx.lineTo(centerX + band.bottomHalf, band.bottom);
          ctx.lineTo(centerX - band.bottomHalf, band.bottom);
          ctx.closePath();
          ctx.fillStyle = FUNNEL_COLORS[index % FUNNEL_COLORS.length];
          ctx.fill();
        }

        // D19：宽段标签内嵌居中；窄段移到右侧空白区，与该段垂直对齐（同高即同段，无需引导线）
        ctx.fillStyle = band.labelInside ? '#ffffff' : '#172026';
        ctx.textAlign = band.labelInside ? 'center' : 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '12px sans-serif';
        ctx.fillText(band.label, band.labelX, band.centerY);
      });

      // 底部说明：形状只负责说真话，宽度严格按人数比例。
      // textBaseline 改成 bottom（上面的段标签用的是 middle，会向下溢出画布），
      // 并把下沿留出 4px，保证笔画完整、不触底。
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#98a2b3';
      ctx.font = '11px sans-serif';
      ctx.fillText('宽度严格按人数比例，不设最小宽度；虚线表示该阶段人数为 0', 8, height - 4);
    });
  },

  /** D16/D17：折线图只画一条线（整体或某一步），异常当天打点。 */
  drawLine() {
    const metrics = this._metrics;
    if (!metrics) return;

    const series = this.currentLineSeries(metrics);
    if (!series) return;

    withCanvas(this, '#lineCanvas', (ctx, width, height) => {
      const layout = buildLineLayout(series.points, {
        width,
        height: height - 6,
        paddingTop: 14,
        paddingBottom: 22
      });

      this._lineLayout = layout;

      if (layout.points.length === 0) {
        ctx.fillStyle = '#98a2b3';
        ctx.font = '12px sans-serif';
        ctx.fillText('这段窗口内的转化率不可计算（分母为 0）', 8, height / 2);
        return;
      }

      // 顶部/底部的量级参考线
      ctx.strokeStyle = '#eef2f7';
      ctx.lineWidth = 1;
      [layout.min, layout.max].forEach((value) => {
        const y = layout.yOf(value);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      });

      ctx.fillStyle = '#98a2b3';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText((layout.max * 100).toFixed(1) + '%', 2, layout.yOf(layout.max) - 3);
      ctx.fillText((layout.min * 100).toFixed(1) + '%', 2, layout.yOf(layout.min) + 11);

      // 折线：只在相邻且都可计算的点之间连线，断点处留空（D24 禁止把不相邻的日期连起来）
      ctx.strokeStyle = COLOR_LINE;
      ctx.lineWidth = 2;
      layout.segments.forEach((seg) => {
        ctx.beginPath();
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();
      });

      // 普通点
      ctx.fillStyle = COLOR_LINE;
      layout.points.forEach((point) => {
        if (point.y === null) return;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
        ctx.fill();
      });

      // D17：异常点只在异常发生的那一天打点
      const anomalyDates = {};
      metrics.anomalies.forEach((item) => {
        if (this.matchesCurrentMetric(item)) anomalyDates[item.date] = true;
      });

      ctx.fillStyle = COLOR_ANOMALY;
      layout.points.forEach((point) => {
        if (point.y === null || !anomalyDates[point.date]) return;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
      });

      // 横轴首尾日期：D24 要求显式标注起止，因为锚点不是今天
      ctx.fillStyle = '#98a2b3';
      ctx.font = '10px sans-serif';
      if (layout.points.length) {
        ctx.textAlign = 'left';
        ctx.fillText(layout.points[0].date.slice(5), 2, height - 4);
        ctx.textAlign = 'right';
        ctx.fillText(layout.points[layout.points.length - 1].date.slice(5), width - 2, height - 4);
      }
    });
  },

  /** D6/D14：入口人数的独立柱状图，与折线图上下并列。 */
  drawColumn() {
    const metrics = this._metrics;
    if (!metrics) return;

    withCanvas(this, '#columnCanvas', (ctx, width, height) => {
      const layout = buildColumnLayout(metrics.entrySeries, {
        width,
        height: height - 4,
        paddingTop: 10,
        paddingBottom: 18
      });

      layout.bars.forEach((bar) => {
        if (bar.height <= 0) return;
        ctx.fillStyle = COLOR_BAR;
        ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
      });

      ctx.fillStyle = '#98a2b3';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('峰值 ' + formatCount(layout.max), 2, 10);

      if (metrics.entrySeries.length) {
        ctx.fillText(metrics.entrySeries[0].date.slice(5), 2, height - 4);
        ctx.textAlign = 'right';
        ctx.fillText(
          metrics.entrySeries[metrics.entrySeries.length - 1].date.slice(5),
          width - 2,
          height - 4
        );
      }
    });
  },

  currentLineSeries(metrics) {
    if (this.data.metricKey === 'overall') {
      return { name: '整体转化率', points: metrics.lineSeries.overall };
    }
    const index = Number(this.data.metricKey.replace('step', ''));
    const hit = metrics.lineSeries.steps.filter((s) => s.index === index)[0];
    return hit ? { name: hit.name, points: hit.points } : null;
  },

  matchesCurrentMetric(anomaly) {
    if (anomaly.kind === 'entry') return false; // 入口人数不在折线图上
    if (this.data.metricKey === 'overall') return false; // 整体转化率只按天算，不做异常判定
    return this.data.metricKey === 'step' + anomaly.stageIndex;
  },

  /** D17：点开异常点查看判定依据。 */
  onLineTap(e) {
    const layout = this._lineLayout;
    const rect = this._lineRect;
    if (!layout || !rect || !layout.points.length) return;

    const x = (e.detail && e.detail.x ? e.detail.x : 0) - rect.left;
    let nearest = layout.points[0];
    layout.points.forEach((point) => {
      if (Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point;
    });

    const metrics = this._metrics;
    const hits = metrics.anomalies.filter((item) => item.date === nearest.date && this.matchesCurrentMetric(item));

    if (hits.length) {
      wx.showModal({
        title: nearest.date + ' 异常',
        content: hits.map((h) => h.reasonText).join('\n'),
        showCancel: false
      });
      return;
    }

    wx.showToast({
      title: nearest.date + '　' + (nearest.value === null ? '不可计算' : (nearest.value * 100).toFixed(1) + '%'),
      icon: 'none'
    });
  },

  onAnomalySummaryTap() {
    const items = this.data.anomalyItems;
    if (!items.length) return;
    wx.showModal({
      title: '异常点判定依据',
      content: items.map((item) => item.date + '　' + item.reasonText).join('\n'),
      showCancel: false
    });
  },

  // ---- D25：漏斗管理 ----

  renameFunnel() {
    const that = this;
    wx.showModal({
      title: '重命名漏斗',
      editable: true,
      placeholderText: this.data.funnelName,
      success(res) {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) {
          wx.showToast({ title: '名称不能为空', icon: 'none' });
          return;
        }
        that.callManage({ action: 'rename', name }, '已重命名');
      }
    });
  },

  renameStage() {
    const that = this;
    const stages = this.data.stages;
    if (!stages.length) return;

    wx.showActionSheet({
      itemList: stages,
      success(res) {
        const stageIndex = res.tapIndex;
        wx.showModal({
          title: '修改阶段名称',
          editable: true,
          placeholderText: stages[stageIndex],
          success(modalRes) {
            if (!modalRes.confirm) return;
            const name = (modalRes.content || '').trim();
            if (!name) {
              wx.showToast({ title: '名称不能为空', icon: 'none' });
              return;
            }
            that.callManage({ action: 'renameStage', stageIndex, name }, '已修改阶段名称');
          }
        });
      }
    });
  },

  clearRecords() {
    const that = this;
    wx.showModal({
      title: '清空全部数据',
      content: '这会删除该漏斗下的所有每日记录，漏斗本身和阶段定义会保留。删掉的数据无法恢复。',
      confirmText: '确认清空',
      confirmColor: '#b42318',
      success(res) {
        if (!res.confirm) return;
        that.callFunctionAndReload('clearRecords', {}, '已清空全部数据');
      }
    });
  },

  deleteFunnel() {
    const that = this;
    wx.showModal({
      title: '删除漏斗',
      content: '这会删除漏斗本身以及它的全部每日记录，无法恢复。',
      confirmText: '确认删除',
      confirmColor: '#b42318',
      success(res) {
        if (!res.confirm) return;
        that.callFunctionAndReload('manageFunnel', { action: 'delete' }, '已删除漏斗', true);
      }
    });
  },

  callManage(payload, successTitle) {
    this.callFunctionAndReload('manageFunnel', payload, successTitle);
  },

  /** 管理动作统一走云函数（ADR-0006：写入只能走云函数；ADR-0003：_openid 由服务端取）。 */
  callFunctionAndReload(name, payload, successTitle, goBack) {
    const that = this;
    wx.showLoading({ title: '处理中' });

    wx.cloud.callFunction({
      name,
      data: Object.assign({ funnelId: this.data.funnelId }, payload),
      success(res) {
        const result = res.result || {};
        if (!result.ok) {
          wx.showToast({ title: result.message || '操作失败', icon: 'none' });
          return;
        }
        wx.showToast({ title: successTitle, icon: 'success' });
        if (goBack) {
          setTimeout(() => {
            wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) });
          }, 600);
          return;
        }
        that.bootstrap(that.data.funnelId);
      },
      fail(err) {
        wx.showToast({ title: (err && err.errMsg) || '云函数调用失败', icon: 'none' });
      },
      complete() {
        wx.hideLoading();
      }
    });
  }
});

// ---- 工具 ----

function shiftDate(dateText, delta) {
  const parts = dateText.split('-');
  const base = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  const d = new Date(base + delta * 86400000);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatChange(change) {
  const percent = (Math.abs(change) * 100).toFixed(1);
  if (change > 0) return '↑ ' + percent + '%';
  if (change < 0) return '↓ ' + percent + '%';
  return '持平';
}

/** canvas 2d 的取节点 + 尺寸 + dpr 缩放样板。 */
function withCanvas(page, selector, draw) {
  const query = wx.createSelectorQuery().in(page);
  query
    .select(selector)
    .fields({ node: true, size: true, rect: true })
    .exec((res) => {
      const info = res && res[0];
      if (!info || !info.node) return;

      const canvas = info.node;
      const dpr = getPixelRatio();
      canvas.width = info.width * dpr;
      canvas.height = info.height * dpr;

      const ctx = canvas.getContext('2d');

      // canvas.getContext('2d') 每次返回的是**同一个**上下文对象，状态会保留。
      // 不重置就再次 scale，第二次绘制（切换窗口、切换指标、管理操作后刷新）
      // 会以 dpr 的平方为比例作画，图形成倍放大、坐标全部错位。
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, info.width, info.height);

      if (selector === '#lineCanvas') {
        page._lineRect = { left: info.left, top: info.top, width: info.width, height: info.height };
      }

      draw(ctx, info.width, info.height);
    });
}

function getPixelRatio() {
  try {
    if (wx.getWindowInfo) return wx.getWindowInfo().pixelRatio || 2;
    return wx.getSystemInfoSync().pixelRatio || 2;
  } catch (err) {
    return 2;
  }
}

function measureText(ctx, text, size) {
  try {
    ctx.font = size + 'px sans-serif';
    return ctx.measureText(text).width;
  } catch (err) {
    return text.length * size;
  }
}
