const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const FUNNELS = 'funnels';
const RECORDS = 'records';

// 服务端单次查询上限 100 条（ADR-0002 的另一个上限，与小程序端的 20 条不同）
const BATCH = 100;

/**
 * 按 funnelId 清空记录。
 * 服务端的 where().remove() 有单次上限，所以用"查到一批删一批"的循环，
 * 并且每批并行删除，避免一次几百条串行等待。
 */
async function removeAllRecords(funnelId) {
  let removed = 0;

  for (let guard = 0; guard < 100; guard++) {
    const res = await db
      .collection(RECORDS)
      .where({ funnelId })
      .field({ _id: true })
      .limit(BATCH)
      .get();

    if (res.data.length === 0) break;

    await Promise.all(
      res.data.map((doc) => db.collection(RECORDS).doc(doc._id).remove())
    );

    removed += res.data.length;
    if (res.data.length < BATCH) break;
  }

  return removed;
}

exports.main = async (event) => {
  // ADR-0003：_openid 只能由服务端从调用上下文取
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, code: 'NO_OPENID', message: '无法获取用户身份' };

  const funnelId = typeof event.funnelId === 'string' ? event.funnelId.trim() : '';
  if (!funnelId) return { ok: false, code: 'FUNNEL_ID_REQUIRED', message: '缺少 funnelId' };

  // ADR-0003：云函数绕过安全规则，必须自己做归属校验。
  // 少了这一步，任何人都能清空别人的漏斗数据。
  let funnel;
  try {
    funnel = (await db.collection(FUNNELS).doc(funnelId).get()).data;
  } catch (err) {
    return { ok: false, code: 'FUNNEL_NOT_FOUND', message: '找不到该漏斗，或它不属于你' };
  }

  if (!funnel || funnel._openid !== OPENID) {
    return { ok: false, code: 'FUNNEL_FORBIDDEN', message: '该漏斗不属于当前用户，拒绝操作' };
  }

  try {
    const removed = await removeAllRecords(funnelId);
    return { ok: true, removed };
  } catch (err) {
    console.error('[clearRecords] 删除失败', err);
    return { ok: false, code: 'DB_ERROR', message: '清空失败，请稍后重试' };
  }
};
