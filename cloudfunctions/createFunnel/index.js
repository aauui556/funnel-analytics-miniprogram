const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COLLECTION = 'funnels';

// 与 miniprogram/utils/scenarios.js 保持一致。
// 服务端必须重新校验一遍：前端校验只是体验，任何人都能直接构造一次 callFunction 请求。
const ALLOWED_SCENARIOS = ['operations', 'sales', 'training'];
const STAGE_MIN = 3;
const STAGE_MAX = 7;
const NAME_MAX = 40;
const STAGE_NAME_MAX = 12;

function fail(code, message) {
  return { ok: false, code, message };
}

exports.main = async (event) => {
  // ADR-0003：云函数以管理员身份运行，会绕过数据库安全规则。
  // 因此 _openid 必须由服务端从调用上下文里取，**绝不能接受客户端传入的值**——
  // 否则任何人都能把自己伪装成别人，隔离规则形同虚设。
  const { OPENID } = cloud.getWXContext();

  if (!OPENID) {
    return fail('NO_OPENID', '无法获取用户身份，请重新进入小程序');
  }

  const name = (typeof event.name === 'string' ? event.name : '').trim();
  const scenario = typeof event.scenario === 'string' ? event.scenario : '';
  const rawStages = Array.isArray(event.stages) ? event.stages : null;

  if (!name) return fail('NAME_REQUIRED', '漏斗名称不能为空');
  if (name.length > NAME_MAX) return fail('NAME_TOO_LONG', '漏斗名称不能超过 ' + NAME_MAX + ' 个字符');
  if (ALLOWED_SCENARIOS.indexOf(scenario) === -1) return fail('SCENARIO_INVALID', '场景模板不合法');
  if (!rawStages) return fail('STAGES_INVALID', '阶段列表格式不正确');

  if (rawStages.length < STAGE_MIN || rawStages.length > STAGE_MAX) {
    return fail('STAGE_COUNT', '阶段数量必须在 ' + STAGE_MIN + '–' + STAGE_MAX + ' 段之间');
  }

  // 阶段按顺序处理，下标即身份（ADR-0002）——这一点在创建时定下，之后就锁定了。
  const stages = [];
  for (let i = 0; i < rawStages.length; i++) {
    const item = rawStages[i];
    if (typeof item !== 'string') {
      return fail('STAGE_INVALID', '第 ' + (i + 1) + ' 个阶段名称格式不正确');
    }

    const trimmed = item.trim();
    if (!trimmed) return fail('STAGE_EMPTY', '第 ' + (i + 1) + ' 个阶段名称为空');
    if (trimmed.length > STAGE_NAME_MAX) {
      return fail('STAGE_TOO_LONG', '第 ' + (i + 1) + ' 个阶段名称不能超过 ' + STAGE_NAME_MAX + ' 个字符');
    }

    stages.push(trimmed);
  }

  // D5：同一漏斗内阶段名称唯一。导入数据时按名称匹配阶段，重名会让匹配无法判定。
  if (new Set(stages).size !== stages.length) {
    return fail('STAGE_DUPLICATE', '阶段名称不能重复');
  }

  const now = Date.now();

  try {
    const res = await db.collection(COLLECTION).add({
      data: {
        // ADR-0003：显式写入 _openid。
        // 这也是 ADR-0006 里 fail-closed 性质的前提：漏写这一行，客户端就**读不到自己的数据**
        // （一眼可测），而不是静默读到别人的数据。失败方式被设计成可察觉的那一种。
        _openid: OPENID,
        name,
        scenario,
        stages,
        // 用毫秒时间戳而不是 ServerDate 对象：列表要按它倒序排，客户端还要直接格式化显示，
        // 数字比 Date 对象少一层转换。云函数的时钟本身是可信的。
        createdAt: now,
        updatedAt: now
      }
    });

    return { ok: true, id: res._id };
  } catch (err) {
    console.error('[createFunnel] 写入 funnels 失败', err);
    return fail('DB_ERROR', '写入数据库失败，请稍后重试');
  }
};
