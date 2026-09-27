/**
 * 场景模板常量（对应 docs/solution-design.md 的 D23，术语见 CONTEXT.md 的「场景」）。
 *
 * 为什么单独抽一个文件：首页要把它映射成「运营/销售/教培」标签，创建页要用它填充默认阶段。
 * 两处各写一份，迟早会出现改了一处忘了另一处的情况。
 */

// D23：三套模板的默认阶段。这只是**默认起点**——按 D22，创建时允许在 3–7 段之间增删。
// 注意「运营」特指内容/增长型运营，不含电商运营（见 CONTEXT.md 的「场景」术语）。
const DEFAULT_STAGES = {
  operations: ['曝光', '点击', '注册', '激活', '留存'],
  sales: ['线索', '跟进', '报价', '成交'],
  training: ['试听', '报名', '到课', '续费']
};

// 顺序即创建页单选按钮的显示顺序；key 与数据库 funnels.scenario 字段的取值一致。
const SCENARIOS = [
  { key: 'operations', label: '运营' },
  { key: 'sales', label: '销售' },
  { key: 'training', label: '教培' }
];

// D3：阶段数量 3–7。下限 3 是因为少于 3 段不构成漏斗；上限 7 是手机屏上还能读清标签的极限。
const STAGE_MIN = 3;
const STAGE_MAX = 7;

// 阶段名长度上限，需与 cloudfunctions/createFunnel 中的同名常量保持一致。
const STAGE_NAME_MAX = 12;

function scenarioLabel(key) {
  const hit = SCENARIOS.find((item) => item.key === key);
  // 未知场景回显原始 key，而不是留空——数据里出现意外值时应当看得见。
  return hit ? hit.label : key;
}

module.exports = {
  DEFAULT_STAGES,
  SCENARIOS,
  STAGE_MIN,
  STAGE_MAX,
  STAGE_NAME_MAX,
  scenarioLabel
};
