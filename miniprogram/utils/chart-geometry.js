/**
 * 图表几何计算（D18 / D19 / D20 + D16 / D17 / D6）。
 *
 * 为什么把几何单独抽出来：D19 要求"宽度严格按人数比例、绝不设最小宽度"、
 * D20 要求"0 人阶段用极细虚线标记存在"、标签还要在内嵌与侧置之间自动选择。
 * 这些规则如果只体现在一坨 canvas 绘制代码里，就只能靠肉眼判断对错。
 * 抽成纯函数之后，它们可以用 Node 直接断言。
 *
 * 本模块不画任何东西，只算坐标；绘制由页面的 canvas 代码完成。
 */

/**
 * 文字宽度估算。默认用启发式规则（中日韩字符按 1 个字宽，其余按 0.55），
 * 页面可以传入基于 canvas measureText 的真实测量函数来获得更准的结果。
 */
function defaultMeasure(text, fontSize) {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    width += code > 0x2e80 ? fontSize : fontSize * 0.55;
  }
  return width;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * D18/D19/D20：梯形漏斗的几何。
 *
 * @param {Array<{name:string,count:number,label:string}>} rows 阶段数据（顺序即阶段顺序）
 * @param {object} opts
 *   width/height   画布可用区域
 *   bandGap        段与段之间的留白
 *   fontSize       标签字号
 *   sideGap        侧置标签与梯形边缘的水平间距
 *   markerHalf     0 值虚线的半长
 *   measure        自定义文字测量函数
 */
function buildFunnelLayout(rows, opts) {
  const options = opts || {};
  const width = toNumber(options.width);
  const height = toNumber(options.height);
  const bandGap = toNumber(options.bandGap);
  const fontSize = toNumber(options.fontSize) || 12;
  const sideGap = toNumber(options.sideGap) || 12;
  const markerHalf = toNumber(options.markerHalf) || 10;
  const measure = options.measure || defaultMeasure;

  const list = Array.isArray(rows) ? rows : [];
  const count = list.length;

  const layout = { bands: [], markerCount: 0, insideCount: 0, sideCount: 0, centerX: width / 2 };
  if (count === 0 || width <= 0 || height <= 0) return layout;

  // 作图区域左右各留出侧置标签的空间。侧置标签靠右放置，
  // 所以右侧留白要按最长标签估算——留不下就会和画布边缘打架。
  const maxLabelWidth = list.reduce(
    (max, row) => Math.max(max, measure(row.label || row.name || '', fontSize)),
    0
  );
  const sideSpace = maxLabelWidth + sideGap;
  const halfMax = Math.max((width - sideSpace * 2) / 2, 10);

  const bandHeight = (height - bandGap * (count - 1)) / count;
  const maxValue = list.reduce((max, row) => Math.max(max, toNumber(row.count)), 0);

  // D19：宽度 = 人数 / 最大值 * 半宽。**没有任何最小值下限**——
  // 数据悬殊时末段会缩到近乎不可见，这是有意为之：形状只负责说真话，数字由标签负责。
  const halfWidths = list.map((row) => (maxValue > 0 ? (toNumber(row.count) / maxValue) * halfMax : 0));

  list.forEach((row, index) => {
    const top = index * (bandHeight + bandGap);
    const bottom = top + bandHeight;
    const topHalf = halfWidths[index];
    // 最后一个阶段的下底收到 0，形成收口的漏斗；其余段的下底就是下一段的上底。
    const bottomHalf = index === count - 1 ? 0 : halfWidths[index + 1];

    const band = {
      index,
      name: row.name,
      count: toNumber(row.count),
      label: row.label || row.name || '',
      top,
      bottom,
      centerY: top + bandHeight / 2,
      topHalf,
      bottomHalf,
      // 该段中部可供放文字的水平跨度
      innerWidth: (topHalf + bottomHalf),
      zero: toNumber(row.count) === 0
    };

    // D19：宽段标签内嵌居中，窄段移到两侧空白区、与该段垂直对齐。
    // 判断依据是"段中部宽度能否容下这行字"，而不是凭感觉设阈值。
    const labelWidth = measure(band.label, fontSize);
    band.labelInside = band.innerWidth >= labelWidth + 8;

    // 侧置标签放在梯形右侧的空白区：梯形是上宽下窄的，
    // 越靠下的段两侧越空，而它恰恰最需要空间——空间与需求正好反向。
    band.labelX = band.labelInside
      ? layout.centerX
      : layout.centerX + halfMax + sideGap;
    band.labelAlign = band.labelInside ? 'center' : 'left';

    // D20：0 人阶段宽度为 0，画不出任何形状，但必须让使用者知道"这一段存在"。
    // 这与"最小宽度"性质完全不同：最小宽度是假装数值更大（失真），
    // 这里只画一根极细虚线，不对数值做任何声张。
    if (band.zero) {
      band.marker = {
        y: band.centerY,
        x1: layout.centerX - markerHalf,
        x2: layout.centerX + markerHalf
      };
      layout.markerCount += 1;
    }

    if (band.labelInside) layout.insideCount += 1;
    else layout.sideCount += 1;

    layout.bands.push(band);
  });

  return layout;
}

/**
 * D16 / D17：折线图的几何。数值为 null 或不可计算的日子用断点表示（不连线）。
 * 注意：绝不允许把不相邻的日子连成相邻点（D24），所以断点必须断开而不是跨过。
 */
function buildLineLayout(points, opts) {
  const options = opts || {};
  const width = toNumber(options.width);
  const height = toNumber(options.height);
  const paddingTop = toNumber(options.paddingTop) || 12;
  const paddingBottom = toNumber(options.paddingBottom) || 20;
  const list = Array.isArray(points) ? points : [];

  const layout = { points: [], segments: [], min: null, max: null, yOf: null };
  if (list.length === 0 || width <= 0 || height <= 0) return layout;

  const values = list
    .map((p) => (p && p.rate && p.rate.kind === 'ok' ? p.rate.value : null))
    .filter((v) => v !== null);

  if (values.length === 0) return layout;

  let min = Math.min.apply(null, values);
  let max = Math.max.apply(null, values);
  if (min === max) {
    // 单点或全部相同：人为撑开一段范围，否则线会贴在边上
    min = Math.max(0, min - 0.05);
    max = max + 0.05;
  }

  const plotHeight = height - paddingTop - paddingBottom;
  const stepX = list.length > 1 ? width / (list.length - 1) : 0;

  const yOf = (value) => paddingTop + plotHeight * (1 - (value - min) / (max - min));
  layout.min = min;
  layout.max = max;
  layout.yOf = yOf;

  layout.points = list.map((p, index) => ({
    date: p.date,
    x: list.length > 1 ? index * stepX : width / 2,
    value: p.rate && p.rate.kind === 'ok' ? p.rate.value : null,
    kind: p.rate ? p.rate.kind : 'undefined',
    y: p.rate && p.rate.kind === 'ok' ? yOf(p.rate.value) : null
  }));

  // 只在相邻且都有值的点之间连线，断点处留空
  for (let i = 1; i < layout.points.length; i++) {
    const a = layout.points[i - 1];
    const b = layout.points[i];
    if (a.y === null || b.y === null) continue;
    layout.segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }

  return layout;
}

/** D6：入口人数柱状图的几何。与折线图上下并列，绝不与转化率共图。 */
function buildColumnLayout(points, opts) {
  const options = opts || {};
  const width = toNumber(options.width);
  const height = toNumber(options.height);
  const paddingTop = toNumber(options.paddingTop) || 8;
  const paddingBottom = toNumber(options.paddingBottom) || 16;
  const list = Array.isArray(points) ? points : [];

  const layout = { bars: [], max: 0 };
  if (list.length === 0 || width <= 0 || height <= 0) return layout;

  const values = list.map((p) => (p && Number.isFinite(p.value) ? p.value : null));
  const max = values.reduce((m, v) => (v === null ? m : Math.max(m, v)), 0);
  layout.max = max;

  const plotHeight = height - paddingTop - paddingBottom;
  const slot = width / list.length;
  const barWidth = Math.max(slot * 0.6, 1);

  layout.bars = list.map((p, index) => {
    const value = values[index];
    const h = max > 0 && value !== null ? (value / max) * plotHeight : 0;
    return {
      date: p.date,
      value,
      x: index * slot + (slot - barWidth) / 2,
      y: paddingTop + plotHeight - h,
      width: barWidth,
      height: h
    };
  });

  return layout;
}

module.exports = {
  defaultMeasure,
  buildFunnelLayout,
  buildLineLayout,
  buildColumnLayout
};
