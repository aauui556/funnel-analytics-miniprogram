/**
 * 粘贴文本的解析与校验：D7（录入格式）、D8（转置）、D9（原子导入/无损规范化/空白≠0）、D27（日期解析）。
 *
 * 这个模块刻意写成不依赖任何小程序 API 的纯函数，原因有两个：
 *   1. 这些规则是整个产品最容易出错的地方，必须能脱离小程序单独跑用例验证；
 *   2. 云函数 importRecords 里有一套等价的服务端复核，两边可以对着同一个规则集看。
 */

const FULLWIDTH_OFFSET = 0xfee0; // 全角字符与半角字符的码位差
const IDEOGRAPHIC_SPACE = '\u3000';

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * D9 的无损规范化：全角转半角、去首尾空格。
 * 只做**格式**层面的统一，不改变任何数值含义——所以这一步是安全的，
 * 而"空白补 0""小数四舍五入"这类会改变语义的操作一律不做。
 */
function normalizeCell(raw) {
  if (raw === null || raw === undefined) return '';

  let text = String(raw);

  // 全角空格先变成普通空格，才能被后面的 trim 正确处理
  text = text.split(IDEOGRAPHIC_SPACE).join(' ');

  // 全角 ASCII（！-～，码位 FF01-FF5E）转半角：数字、逗号、点号、括号都在这个区间
  text = text.replace(/[\uff01-\uff5e]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_OFFSET)
  );

  return text.trim();
}

/**
 * 解析人数。
 * 只接受十进制非负整数（允许千分位逗号，因为那是纯格式）。
 * 小数、科学计数法、带符号、百分号一律拒绝——它们要么不是人数，要么需要"猜"才能解释。
 */
function parseCount(raw) {
  const text = normalizeCell(raw);
  if (text === '') return { ok: false, reason: 'empty' };

  const compact = text.split(',').join('');
  if (!/^\d+$/.test(compact)) return { ok: false, reason: 'notInteger' };

  const value = Number(compact);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: 'tooLarge' };

  return { ok: true, value };
}

// D27：接受的三种写法。顺序即匹配优先级。
const DATE_PATTERNS = [
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
  /^(\d{4})年(\d{1,2})月(\d{1,2})日$/
];

/**
 * 解析日期（D27）：统一规范化为 YYYY-MM-DD。
 * 三种写法属于**格式**差异，做无损规范化；无年份属于**语义**缺失，必须拒绝——
 * 跨年时补全年份必然无声出错（1 月导入去年 12 月的数据、或表里同时有 12/30 和 1/2）。
 */
function parseDate(raw) {
  const text = normalizeCell(raw);
  if (text === '') return { ok: false, reason: 'empty' };

  for (let i = 0; i < DATE_PATTERNS.length; i++) {
    const matched = DATE_PATTERNS[i].exec(text);
    if (!matched) continue;

    const year = Number(matched[1]);
    const month = Number(matched[2]);
    const day = Number(matched[3]);

    // 年份下限 1000 是技术性护栏：JS 的 Date 会把 0-99 当成 19xx，不拦住就会出现静默的年份漂移。
    if (year < 1000) return { ok: false, reason: 'badYear' };

    // 真实存在性校验：2025-02-30 必须被拒绝，而不是被 Date 悄悄滚成 3 月 2 日
    const probe = new Date(year, month - 1, day);
    if (
      probe.getFullYear() !== year ||
      probe.getMonth() !== month - 1 ||
      probe.getDate() !== day
    ) {
      return { ok: false, reason: 'notExist' };
    }

    return { ok: true, value: year + '-' + pad2(month) + '-' + pad2(day) };
  }

  // 无年份是被 D27 单独点名拒绝的情形，错误信息要让人一眼看懂原因
  if (/^\d{1,2}[-\/月]\d{1,2}日?$/.test(text)) {
    return { ok: false, reason: 'noYear' };
  }

  return { ok: false, reason: 'badFormat' };
}

/** 按行切分并丢掉空行：Excel 复制常见的结尾空行不该被当成数据。 */
function splitLines(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/** D7：分隔符只认制表符。用空格或逗号分隔的表格会在这里被识破并报错，而不是被猜着切开。 */
function splitCells(line) {
  return line.split('\t');
}

/**
 * D8 一键转置：对**原始文本矩阵**做转置，必须在解析之前执行。
 * 转置是"形状"操作，只有使用者知道自己的表原本是什么方向；程序绝不自动判断。
 * 这个函数是对合运算——再按一次就转回去了，所以不需要额外的撤销按钮。
 */
function transposeText(text) {
  const lines = splitLines(text).map(splitCells);
  if (lines.length === 0) return '';

  const width = lines.reduce((max, cells) => Math.max(max, cells.length), 0);
  const output = [];

  for (let col = 0; col < width; col++) {
    const row = [];
    for (let r = 0; r < lines.length; r++) {
      const cell = lines[r][col];
      row.push(cell === undefined ? '' : cell);
    }
    output.push(row.join('\t'));
  }

  return output.join('\n');
}

const REASON_TEXT = {
  empty: '是空白单元格',
  notInteger: '不是非负整数',
  tooLarge: '数值超出可处理范围',
  badYear: '年份不合法',
  notExist: '这个日期并不存在',
  noYear: '缺少年份',
  badFormat: '格式无法识别（支持 2025-05-01、2025/5/1、2025年5月1日）'
};

/**
 * 解析整张表。
 *
 * @param {string} text   粘贴进来的原始文本
 * @param {string[]} stages 所选漏斗的阶段名，**有序**
 * @returns {{ok: boolean, rows: Array, errors: Array, errorCount: number}}
 *   rows 中的 counts 已经按 stages 的顺序对齐（不是按粘贴的列顺序）。
 *
 * D5 的核心在这里：表头阶段名必须与漏斗阶段**按名称**完全对应（顺序可以不同，集合必须一致）。
 * 绝不允许退化成"第 1 列对第 1 阶段"——那会产生静默错位，图表看起来正常，数字却全错。
 */
function parseTable(text, stages) {
  const errors = [];
  const rows = [];
  const stageList = Array.isArray(stages) ? stages : [];

  const lines = splitLines(text);
  if (lines.length === 0) {
    errors.push({ line: 0, column: 0, message: '没有读到任何内容' });
    return { ok: false, rows: [], errors, errorCount: errors.length };
  }
  if (lines.length === 1) {
    errors.push({ line: 1, column: 0, message: '只有表头，没有数据行' });
    return { ok: false, rows: [], errors, errorCount: errors.length };
  }

  const header = splitCells(lines[0]).map(normalizeCell);
  const headerStages = header.slice(1); // 第一格是日期列的表头（通常写"日期"），不参与阶段匹配

  // 只切出一列，几乎一定是没用制表符分隔（逗号、空格、或整段粘成一行）。
  // 直接点明原因，比让使用者从"缺少这些阶段的列"里去猜要好得多。
  if (header.length === 1) {
    errors.push({
      line: 1,
      column: 0,
      message:
        '只解析出 1 列，没读到制表符。请从 Excel 里直接复制单元格区域（制表符分隔），' +
        '不要用逗号或空格手工分隔'
    });
    return { ok: false, rows: [], errors, errorCount: errors.length };
  }

  // ---- 表头与漏斗阶段的按名匹配（D5）----
  const stageIndexByName = {};
  stageList.forEach((name, index) => {
    stageIndexByName[name] = index;
  });

  const mapping = [];      // mapping[粘贴列序号-1] = 漏斗阶段下标
  const unknownNames = [];
  const emptyHeaders = [];
  const duplicateHeaders = [];
  const seenStageIndex = {};

  headerStages.forEach((name, i) => {
    if (!name) {
      emptyHeaders.push(i + 2); // 1 基列号，含日期列
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(stageIndexByName, name)) {
      unknownNames.push(name);
      return;
    }

    const stageIndex = stageIndexByName[name];
    if (seenStageIndex[stageIndex]) {
      duplicateHeaders.push(name);
      return;
    }

    seenStageIndex[stageIndex] = true;
    mapping[i] = stageIndex;
  });

  const missingNames = stageList.filter((name, index) => !seenStageIndex[index]);

  if (unknownNames.length) {
    errors.push({
      line: 1,
      column: 0,
      message: '表头里有该漏斗没有的阶段：' + unknownNames.join('、')
    });
  }
  if (emptyHeaders.length) {
    errors.push({
      line: 1,
      column: 0,
      message: '第 ' + emptyHeaders.join('、') + ' 列的表头是空的，无法判断它属于哪个阶段'
    });
  }
  if (duplicateHeaders.length) {
    errors.push({
      line: 1,
      column: 0,
      message: '表头里重复出现同一个阶段：' + duplicateHeaders.join('、')
    });
  }
  if (missingNames.length) {
    errors.push({
      line: 1,
      column: 0,
      message: '缺少这些阶段的列：' + missingNames.join('、') + '（每天的数据必须完整，缺一列就无法填出这一天）'
    });
  }

  // 表头都没对上，逐行报错只会产生噪音——先把匹配问题修好，再谈数值。
  if (errors.length) {
    return { ok: false, rows: [], errors, errorCount: errors.length };
  }

  // ---- 逐行解析 ----
  const firstLineByDate = {};

  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const cells = splitCells(lines[i]);

    if (cells.length !== header.length) {
      errors.push({
        line: lineNo,
        column: 0,
        message: '这行有 ' + cells.length + ' 列，与表头的 ' + header.length + ' 列不一致'
      });
      continue;
    }

    // 先把所有单元格的问题收集完，再决定这一行要不要进 rows——
    // D9 要求"一次列全所有问题位置"，不能报一个就停。
    const counts = new Array(stageList.length).fill(null);
    let rowHasError = false;

    for (let c = 1; c < cells.length; c++) {
      const stageIndex = mapping[c - 1];
      const parsed = parseCount(cells[c]);

      if (!parsed.ok) {
        rowHasError = true;
        if (parsed.reason === 'empty') {
          // D9: 空白 = 缺失 ≠ 0，整批拒绝。绝不补 0——那会凭空造出一个断崖，而且永远没人发现。
          errors.push({
            line: lineNo,
            column: c + 1,
            message:
              '阶段「' + header[c] + '」是空白。空白表示没有统计，不等于 0；' +
              '请填入真实数字，或删掉整行/整列后重贴'
          });
        } else {
          errors.push({
            line: lineNo,
            column: c + 1,
            message:
              '阶段「' + header[c] + '」的值「' + normalizeCell(cells[c]) + '」' +
              (REASON_TEXT[parsed.reason] || '不合法')
          });
        }
        continue;
      }

      counts[stageIndex] = parsed.value;
    }

    const parsedDate = parseDate(cells[0]);
    if (!parsedDate.ok) {
      rowHasError = true;
      errors.push({
        line: lineNo,
        column: 1,
        message:
          '日期「' + normalizeCell(cells[0]) + '」' + (REASON_TEXT[parsedDate.reason] || '不合法')
      });
    } else if (Object.prototype.hasOwnProperty.call(firstLineByDate, parsedDate.value)) {
      // D27：同一批里重复日期整批拒绝。同一天给出两个不同数字时，
      // 系统没有任何依据判断哪个对——替使用者选一个就是编造。
      rowHasError = true;
      errors.push({
        line: lineNo,
        column: 1,
        message:
          '日期 ' + parsedDate.value + ' 与第 ' + firstLineByDate[parsedDate.value] + ' 行重复，无法判断哪个值才对'
      });
    }

    if (rowHasError || !parsedDate.ok) continue;

    firstLineByDate[parsedDate.value] = lineNo;
    rows.push({ date: parsedDate.value, counts });
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ line: 0, column: 0, message: '没有解析出任何数据行' });
  }

  return {
    ok: errors.length === 0,
    // 只要有任何问题就整批作废，绝不把半个结果交出去——调用方拿不到"部分可用"的东西，
    // 也就不会有"要不要将就一下"的余地（D9）。
    rows: errors.length === 0 ? rows : [],
    errors,
    errorCount: errors.length
  };
}

module.exports = {
  normalizeCell,
  parseCount,
  parseDate,
  splitLines,
  splitCells,
  transposeText,
  parseTable
};
