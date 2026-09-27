const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const FUNNELS = 'funnels';
const RECORDS = 'records';

// D26：图表展示受窗口上限约束，最多 30 天。用它算"存了多少、能看到多少"。
const MAX_DISPLAY_DAYS = 30;

// 预查历史记录时的分批大小。服务端单次查询上限 100 条，取 50 留足余量。
const QUERY_CHUNK = 50;

// 错误列表的返回上限。仍然会给出 errorCount，不会假装问题比实际少。
const MAX_RETURNED_ERRORS = 50;

function fail(code, message, extra) {
  const payload = { ok: false, code, message };
  if (extra) {
    Object.keys(extra).forEach((key) => {
      payload[key] = extra[key];
    });
  }
  return payload;
}

/** D27 的日期校验：只接受规范化后的 YYYY-MM-DD，并且必须是真实存在的日期。 */
function isValidDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;

  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));

  // 年份下限是技术性护栏：JS 的 Date 会把 0-99 当成 19xx，不拦住会出现静默的年份漂移。
  if (year < 1000) return false;

  const probe = new Date(year, month - 1, day);
  return (
    probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
  );
}

/** ADR-0002 的确定性主键：一个漏斗的一天只可能有一个 _id。 */
function buildRecordId(funnelId, date) {
  // 去掉日期里的连字符，让 _id 只由字母数字和下划线组成，避开自定义 _id 的字符风险。
  return funnelId + '_' + date.split('-').join('');
}

exports.main = async (event) => {
  // ADR-0003：云函数以管理员身份运行，会绕过数据库安全规则。
  // _openid 只能由服务端从调用上下文取，绝不接受客户端传入——否则任何人都能伪造数据归属。
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return fail('NO_OPENID', '无法获取用户身份，请重新进入小程序');
  }

  const funnelId = typeof event.funnelId === 'string' ? event.funnelId.trim() : '';
  const rawRows = Array.isArray(event.parsedRows) ? event.parsedRows : null;

  // 客户端上报的 dateRange 只用于排查问题，不作为任何判断依据——
  // 真正的范围一律从 parsedRows 推导，不采信客户端算出来的元数据。
  if (event.dateRange) {
    console.log('[importRecords] 客户端上报的 dateRange（仅供参考）', event.dateRange);
  }

  if (!funnelId) return fail('FUNNEL_ID_REQUIRED', '缺少 funnelId');
  if (!rawRows || rawRows.length === 0) return fail('ROWS_EMPTY', '没有可导入的数据行');

  // ---- 归属校验：这是本函数最关键的一步 ----
  let funnel;
  try {
    funnel = (await db.collection(FUNNELS).doc(funnelId).get()).data;
  } catch (err) {
    // 文档不存在、或调用方没有权限，在这里是同一个结果：不让继续
    return fail('FUNNEL_NOT_FOUND', '找不到该漏斗，或它不属于你');
  }

  // ADR-0003：即便拿到文档，也要再核对归属。
  // 少了这一步，攻击者就能把数据写进别人的漏斗（记录会带着他的 _openid 落进受害者的漏斗里）。
  if (!funnel || funnel._openid !== OPENID) {
    return fail('FUNNEL_FORBIDDEN', '该漏斗不属于当前用户，拒绝写入');
  }

  const stages = Array.isArray(funnel.stages) ? funnel.stages : [];
  if (stages.length === 0) {
    return fail('FUNNEL_BROKEN', '该漏斗没有阶段定义，无法导入');
  }

  // ---- 服务端复核（D9 / D27）----
  // 前端已经校验过一次，但那只是体验层：任何人都能直接构造一次 callFunction 请求。
  // 这里把规则完整重跑一遍，并且同样**一次列全所有问题**，不是遇到第一个就返回。
  const errors = [];
  const normalized = [];
  const firstIndexByDate = {};

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i] || {};
    const label = '第 ' + (i + 1) + ' 条记录（按提交顺序）';
    const date = typeof row.date === 'string' ? row.date.trim() : '';
    const counts = Array.isArray(row.counts) ? row.counts : null;

    if (!isValidDate(date)) {
      errors.push(label + ' 的日期不合法：' + JSON.stringify(row.date));
      continue;
    }

    // ADR-0002：counts 的下标必须与漏斗的 stages 严格对齐，长度不符一律拒绝。
    if (!counts || counts.length !== stages.length) {
      errors.push(
        label +
          ' 的数值个数（' +
          (counts ? counts.length : 0) +
          '）与漏斗阶段数（' +
          stages.length +
          '）不一致'
      );
      continue;
    }

    let countError = false;
    for (let c = 0; c < counts.length; c++) {
      const value = counts[c];
      // D9：空白一律被拒绝在解析阶段，所以这里只应看到真实的非负整数。
      // null / 字符串 / 小数 / 负数 / 缺失，全部不合格。
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        errors.push(
          label +
            ' 的第 ' +
            (c + 1) +
            ' 个数值不合法：' +
            JSON.stringify(value) +
            '（必须是非负整数；0 是合法值，空白不是）'
        );
        countError = true;
      }
    }
    if (countError) continue;

    // D27：同一批里重复日期整批拒绝——两个矛盾的值无从判断哪个对。
    if (Object.prototype.hasOwnProperty.call(firstIndexByDate, date)) {
      errors.push(
        label + ' 的日期 ' + date + ' 与第 ' + firstIndexByDate[date] + ' 条重复'
      );
      continue;
    }

    firstIndexByDate[date] = i + 1;
    normalized.push({ date, counts });
  }

  if (errors.length > 0) {
    // D9：整批拒绝，一行都不写。
    return fail('VALIDATION_FAILED', '数据校验未通过，整批未写入', {
      errors: errors.slice(0, MAX_RETURNED_ERRORS),
      errorCount: errors.length
    });
  }

  // ---- 预查已存在的记录 ----
  // 目的有两个：① 覆盖写入时保留 createdAt（否则 createdAt 就等同于 updatedAt，没有意义）；
  // ② 给使用者一个"新增 X 天 / 覆盖 Y 天"的准确回执。
  // 这一步放在事务之外，是为了让事务里只剩写入操作，把事务窗口压到最短。
  const existingCreatedAt = {};
  const dates = normalized.map((row) => row.date);

  try {
    for (let i = 0; i < dates.length; i += QUERY_CHUNK) {
      const chunk = dates.slice(i, i + QUERY_CHUNK);
      const res = await db
        .collection(RECORDS)
        // 这里不需要再带 _openid：funnelId 已经过归属校验，该漏斗的数据全部属于当前用户。
        .where({ funnelId, date: _.in(chunk) })
        .field({ date: true, createdAt: true })
        .limit(chunk.length)
        .get();

      res.data.forEach((doc) => {
        existingCreatedAt[doc.date] = doc.createdAt;
      });
    }
  } catch (err) {
    console.error('[importRecords] 预查已有记录失败', err);
    return fail('PRECHECK_FAILED', '读取已有记录失败，整批未写入，请稍后重试');
  }

  const overwrittenDays = normalized.filter((row) =>
    Object.prototype.hasOwnProperty.call(existingCreatedAt, row.date)
  ).length;
  const createdDays = normalized.length - overwrittenDays;

  const now = Date.now();

  // ---- 原子写入（D9 + ADR-0002）----
  // 用 db.runTransaction 包住全部写入：任何一条失败，整批回滚，
  // 不会出现"前 10 天进去了、第 11 天失败"这种半截状态。
  try {
    await db.runTransaction(async (transaction) => {
      for (let i = 0; i < normalized.length; i++) {
        const row = normalized[i];
        const recordId = buildRecordId(funnelId, row.date);
        const existed = Object.prototype.hasOwnProperty.call(existingCreatedAt, row.date);

        // ADR-0002：「漏斗 + 日期」覆盖式写入。
        // 用确定性 _id + set()，让"同一天只有一条记录"由主键在数据库层面保证，
        // 而不是靠应用先查再写——后者在并发下会写出重复的一天。
        await transaction
          .collection(RECORDS)
          .doc(recordId)
          .set({
            data: {
              // ADR-0003：显式写入 _openid，客户端才能凭安全规则读到自己这份数据。
              // 这也是 ADR-0006 里 fail-closed 性质的前提：漏写会表现为"读不到"，
              // 而不是静默读到别人的数据——失败方式被设计成可察觉的那一种。
              _openid: OPENID,
              funnelId,
              date: row.date,
              counts: row.counts,
              // 覆盖时保留首次写入时间，createdAt 才有独立含义。
              createdAt: existed ? existingCreatedAt[row.date] : now,
              updatedAt: now
            }
          });
      }
    });
  } catch (err) {
    console.error('[importRecords] 事务写入失败', err);
    return fail(
      'WRITE_FAILED',
      '整批写入失败，数据库未发生任何变更（事务已回滚）。若一次导入的天数过多，请分批粘贴。'
    );
  }

  // ---- 回执（D26）----
  // 统计失败不应该让已经成功的导入看起来像失败了，所以这里容错并退回到本次导入天数。
  let totalDays = normalized.length;
  try {
    const countRes = await db.collection(RECORDS).where({ funnelId }).count();
    totalDays = countRes.total;
  } catch (err) {
    console.error('[importRecords] 统计记录总数失败，回退为本次导入天数', err);
  }

  const sortedDates = dates.slice().sort(); // YYYY-MM-DD 字符串排序即时间排序

  return {
    ok: true,
    savedDays: normalized.length,
    createdDays,
    overwrittenDays,
    totalDays,
    // D26：最多只能展示 30 天，所以必须把"存了多少、能看到多少"如实告诉使用者，
    // 否则他会以为数据丢了。
    displayDays: Math.min(totalDays, MAX_DISPLAY_DAYS),
    maxDisplayDays: MAX_DISPLAY_DAYS,
    dateRange: {
      start: sortedDates[0],
      end: sortedDates[sortedDates.length - 1]
    }
  };
};
