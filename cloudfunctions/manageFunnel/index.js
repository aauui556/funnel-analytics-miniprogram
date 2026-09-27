const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const FUNNELS = 'funnels';
const RECORDS = 'records';

const NAME_MAX = 40;
const STAGE_NAME_MAX = 12;
const BATCH = 100;

function fail(code, message) {
  return { ok: false, code, message };
}

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

    await Promise.all(res.data.map((doc) => db.collection(RECORDS).doc(doc._id).remove()));

    removed += res.data.length;
    if (res.data.length < BATCH) break;
  }

  return removed;
}

exports.main = async (event) => {
  // ADR-0003：_openid 只能由服务端从调用上下文取
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_OPENID', '无法获取用户身份');

  const funnelId = typeof event.funnelId === 'string' ? event.funnelId.trim() : '';
  const action = typeof event.action === 'string' ? event.action : '';
  if (!funnelId) return fail('FUNNEL_ID_REQUIRED', '缺少 funnelId');

  // ADR-0003：云函数以管理员身份运行、绕过安全规则，归属校验必须自己来。
  let funnel;
  try {
    funnel = (await db.collection(FUNNELS).doc(funnelId).get()).data;
  } catch (err) {
    return fail('FUNNEL_NOT_FOUND', '找不到该漏斗，或它不属于你');
  }

  if (!funnel || funnel._openid !== OPENID) {
    return fail('FUNNEL_FORBIDDEN', '该漏斗不属于当前用户，拒绝操作');
  }

  const now = Date.now();
  const stages = Array.isArray(funnel.stages) ? funnel.stages : [];

  try {
    if (action === 'rename') {
      const name = (typeof event.name === 'string' ? event.name : '').trim();
      if (!name) return fail('NAME_REQUIRED', '漏斗名称不能为空');
      if (name.length > NAME_MAX) return fail('NAME_TOO_LONG', '漏斗名称不能超过 ' + NAME_MAX + ' 个字符');

      await db.collection(FUNNELS).doc(funnelId).update({ data: { name, updatedAt: now } });
      return { ok: true, name };
    }

    if (action === 'renameStage') {
      const stageIndex = Number(event.stageIndex);
      const name = (typeof event.name === 'string' ? event.name : '').trim();

      if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= stages.length) {
        return fail('STAGE_INDEX_INVALID', '阶段序号不合法');
      }
      if (!name) return fail('STAGE_NAME_REQUIRED', '阶段名称不能为空');
      if (name.length > STAGE_NAME_MAX) {
        return fail('STAGE_NAME_TOO_LONG', '阶段名称不能超过 ' + STAGE_NAME_MAX + ' 个字符');
      }

      // D5：同一漏斗内阶段名称必须唯一，否则导入时按名称匹配会无法判定
      const duplicated = stages.some((s, i) => i !== stageIndex && s === name);
      if (duplicated) return fail('STAGE_NAME_DUPLICATED', '已有同名阶段');

      const nextStages = stages.slice();
      nextStages[stageIndex] = name;

      /**
       * 只改名称，**不动 records**。
       * ADR-0002：阶段身份由下标决定，counts 按下标与 stages 对齐，
       * 所以改名是原位替换，历史数据依然正确——这也正是当初选择按下标对齐的收益。
       * 如果去重写历史记录里的人数，反而会引入不必要的迁移风险。
       */
      await db
        .collection(FUNNELS)
        .doc(funnelId)
        .update({ data: { stages: nextStages, updatedAt: now } });

      return { ok: true, stages: nextStages };
    }

    if (action === 'delete') {
      // D25：删除漏斗必须连带删掉它的记录，否则会留下永远读不到的孤儿数据
      const removed = await removeAllRecords(funnelId);
      await db.collection(FUNNELS).doc(funnelId).remove();
      return { ok: true, removedRecords: removed };
    }
  } catch (err) {
    console.error('[manageFunnel] 操作失败', action, err);
    return fail('DB_ERROR', '操作失败，请稍后重试');
  }

  return fail('ACTION_UNKNOWN', '不支持的操作：' + action);
};
