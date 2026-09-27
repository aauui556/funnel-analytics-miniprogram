/**
 * 结构与路由校验。
 *
 * 目标不只是"能跑起来"，而是让下面三类错误在提交前就被挡住：
 *   1. app.json 声明了路由，但对应的 .js/.json/.wxml/.wxss 缺文件；
 *   2. 页面上有目录，却没写进 app.json（页面永远打不开，且没人会发现）；
 *   3. 云函数缺 index.js 或 package.json（部署时才会失败，排查成本高）。
 * 任何一项不通过都以非零码退出，可以直接接进提审前的检查流程。
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const miniprogramRoot = path.join(root, 'miniprogram');
const pagesRoot = path.join(miniprogramRoot, 'pages');
const cloudRoot = path.join(root, 'cloudfunctions');

const problems = [];

function fail(message) {
  problems.push(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function exists(target) {
  return fs.existsSync(target);
}

function listDirs(dir) {
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// ---- 1. 项目配置 ----
const projectConfig = readJson(path.join(root, 'project.config.json'));

if (projectConfig.miniprogramRoot !== 'miniprogram/') {
  fail('project.config.json 的 miniprogramRoot 应为 "miniprogram/"');
}
if (projectConfig.cloudfunctionRoot !== 'cloudfunctions/') {
  fail('project.config.json 的 cloudfunctionRoot 应为 "cloudfunctions/"');
}
if (!projectConfig.appid) {
  fail('project.config.json 缺少 appid');
}

// ---- 2. 小程序入口文件 ----
if (!exists(path.join(miniprogramRoot, 'app.wxss'))) {
  fail('缺少 miniprogram/app.wxss');
}
if (!exists(path.join(miniprogramRoot, 'sitemap.json'))) {
  fail('缺少 miniprogram/sitemap.json');
} else {
  readJson(path.join(miniprogramRoot, 'sitemap.json'));
}

const appJs = fs.readFileSync(path.join(miniprogramRoot, 'app.js'), 'utf8');
if (!appJs.includes('wx.cloud.init')) {
  fail('miniprogram/app.js 未调用 wx.cloud.init');
}
if (!appJs.includes('traceUser')) {
  fail('miniprogram/app.js 的 wx.cloud.init 未设置 traceUser');
}

// ---- 3. 路由完整性（双向检查）----
const appJson = readJson(path.join(miniprogramRoot, 'app.json'));

if (!Array.isArray(appJson.pages) || appJson.pages.length === 0) {
  fail('app.json 未声明任何页面');
}

const pages = Array.isArray(appJson.pages) ? appJson.pages : [];

// 3a. 声明了的页面，四个文件必须齐全
pages.forEach((page) => {
  ['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    const target = path.join(miniprogramRoot, `${page}.${ext}`);
    if (!exists(target)) fail(`app.json 声明了 ${page}，但缺少文件：miniprogram/${page}.${ext}`);
  });
});

// 3b. 反向：磁盘上有目录却没被声明（页面永远打不开，属于最容易漏掉的一类）
listDirs(pagesRoot).forEach((dir) => {
  const declared = pages.some((page) => page.indexOf(`pages/${dir}/`) === 0);
  if (!declared) {
    fail(`miniprogram/pages/${dir} 没有被 app.json 声明，这个页面将无法打开`);
  }
});

// ---- 4. 云函数完整性 ----
const functions = listDirs(cloudRoot);

if (functions.length === 0) {
  fail('cloudfunctions 下没有任何云函数');
}

functions.forEach((name) => {
  const dir = path.join(cloudRoot, name);

  if (!exists(path.join(dir, 'index.js'))) {
    fail(`云函数 ${name} 缺少 index.js`);
  }

  const pkgPath = path.join(dir, 'package.json');
  if (!exists(pkgPath)) {
    fail(`云函数 ${name} 缺少 package.json（部署时会失败）`);
    return;
  }

  try {
    const pkg = readJson(pkgPath);
    if (!pkg.main) fail(`云函数 ${name} 的 package.json 缺少 main`);
    if (!pkg.dependencies || !pkg.dependencies['wx-server-sdk']) {
      fail(`云函数 ${name} 未声明 wx-server-sdk 依赖`);
    }
  } catch (err) {
    fail(`云函数 ${name} 的 package.json 无法解析：${err.message}`);
  }
});

// ---- 5. 纯计算模块可加载性 ----
// metrics / chart-geometry / parse-table / scenarios 都是不依赖小程序 API 的纯模块，
// 在 Node 里直接 require 就能验证它们没有加载期错误。这些正是口径逻辑的所在，
// 一旦它们连加载都失败，页面上的数字会是错的而界面看起来一切正常。
const utilsDir = path.join(miniprogramRoot, 'utils');
const utils = fs
  .readdirSync(utilsDir)
  .filter((name) => name.endsWith('.js'))
  .sort();

utils.forEach((name) => {
  try {
    const loaded = require(path.join(utilsDir, name));
    if (!loaded || Object.keys(loaded).length === 0) {
      fail(`miniprogram/utils/${name} 没有导出任何内容`);
    }
  } catch (err) {
    fail(`miniprogram/utils/${name} 加载失败：${err.message}`);
  }
});

// ---- 汇总 ----
if (problems.length > 0) {
  console.error('[miniapp] 校验未通过，共 ' + problems.length + ' 项：');
  problems.forEach((item) => console.error('  - ' + item));
  process.exit(1);
}

console.log('[miniapp] 校验通过');
console.log(`- 页面数量: ${pages.length}（${pages.join(', ')}）`);
console.log(`- 云函数数量: ${functions.length}（${functions.join(', ')}）`);
console.log(`- 纯模块数量: ${utils.length}（${utils.join(', ')}）`);
console.log(`- miniprogramRoot: ${projectConfig.miniprogramRoot}`);
console.log(`- cloudfunctionRoot: ${projectConfig.cloudfunctionRoot}`);
