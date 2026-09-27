# funnel-analytics-miniprogram

微信原生小程序 + 小程序·云开发项目骨架。

## 目录结构

- `miniprogram/`：小程序前端代码，`app.js` 中完成云开发初始化。
- `cloudfunctions/`：云函数目录，对应 `project.config.json` 的 `cloudfunctionRoot`。
- `docs/`：产品说明与提审准备材料。
- `tests/validate-miniapp.js`：本地结构校验脚本。

## 本地校验

```powershell
npm run validate
```

## 上手步骤

1. 用微信开发者工具「导入项目」，选择本目录，填入自己的 AppID（当前为 `touristappid` 游客模式占位）。
2. 在云开发控制台创建环境，拿到环境 ID。
3. 把 `miniprogram/app.js` 和 `miniprogram/pages/index/index.js` 中的 `your-env-id` 替换为真实环境 ID。
4. 右键 `cloudfunctions/ping`，选择「上传并部署：云端安装依赖」。
5. 在小程序首页点击「调用云函数 ping」，确认云函数连通性为「成功」。

## 说明

- `cloudfunctions/ping/package.json` 固定了 `wx-server-sdk` 版本；新增云函数时按需引入，不要在小程序端放置任何 AppSecret 或私钥。
- 云函数本地调试需要 Node.js 环境；纯结构校验不需要安装依赖。
