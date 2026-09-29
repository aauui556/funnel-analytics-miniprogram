# funnel-analytics-miniprogram

微信原生小程序 + 小程序·云开发实现的转化漏斗分析工具，面向内容/增长运营、销售、教培三类场景。

## 功能

- **漏斗列表**：按创建时间倒序列出已保存的漏斗，数据按微信用户隔离。
- **新建漏斗**：从三个内置模板出发，可在 3–7 段之间增删阶段、改名后保存。
- **导入数据**：从剪贴板粘贴「日期 + 各阶段」的制表符文本；原子校验（一次列全所有问题位置）、预览后入库；同一天重复导入为覆盖，不产生重复数据。
- **漏斗详情**：窗口内合计的梯形漏斗、逐步与整体转化率、7/14/30 天环比、规则式异常点与判定依据、入口人数趋势。

## 目录结构

- `miniprogram/`
  - `pages/`：`index`（漏斗列表）、`funnel-create`（新建）、`data-import`（导入）、`funnel-detail`（详情）
  - `utils/`：四个不依赖小程序 API 的纯模块——`metrics.js` 计算引擎、`chart-geometry.js` 图表几何、`parse-table.js` 粘贴解析与校验、`scenarios.js` 模板常量
- `cloudfunctions/`：五个云函数——`createFunnel`、`importRecords`、`manageFunnel`、`clearRecords`、`ping`
- `docs/`：方案文档、产品说明，以及 `docs/adr/` 下的 6 份架构决策记录
- `tests/validate-miniapp.js`：结构与路由校验脚本

## 设计要点

完整决策记录见 `docs/solution-design.md`（27 个决策点）与 `docs/adr/`。最影响代码形态的三条：

- **数据口径**：聚合人数（阶段 × 日期），**不做跨阶段去重**，转化率是各阶段人数之比。因此它回答不了"同一批人走到哪一步"这类问题。见 `docs/adr/0001-aggregated-daily-counts.md`。
- **读写分工**：读取由小程序端直查数据库、计算全在前端；只有写入走云函数（事务保证原子性）。见 `docs/adr/0006-client-reads-cloud-writes.md`。
- **数据隔离**：按微信用户隔离；云函数以管理员身份运行会绕过安全规则，写入时必须显式补 `_openid`。见 `docs/adr/0003-per-user-data-isolation.md`。

图表为原生 Canvas 2D 自绘，未引入第三方图表库。

## 本地校验

```powershell
npm run validate
```

检查项目配置、`wx.cloud.init`、页面路由的双向完整性（声明了却缺文件、有目录却没声明）、云函数完整性，以及四个纯模块能否加载。

## 运行前必须做的四件事

1. 用微信开发者工具「导入项目」，**把 `project.config.json` 里的 AppID 换成你自己的**。
2. 创建云开发环境，把 `miniprogram/app.js` 中的 `your-env-id` 替换为真实环境 ID（也可以删掉 `env` 字段，改用云控制台里的默认环境）。
3. 在云控制台创建 `funnels` 与 `records` 两个集合，权限都设为「仅创建者可读写」。**这一步不能省**——读取走客户端直查，隔离完全依赖这条规则。
4. 上传并部署五个云函数（右键 → 上传并部署：云端安装依赖）。

## 说明

- 云函数依赖 `wx-server-sdk`；小程序端不放任何 AppSecret 或私钥。
- 异常判定阈值（30%）与样本量门槛（20）是待校准的初始值，集中定义在 `miniprogram/utils/metrics.js` 顶部。
- 本项目尚未提交微信审核；服务类目、备案信息与审核测试路径仍待补充，见 `docs/product-brief.md`。
