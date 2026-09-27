// 部署前请替换为你自己的云开发环境ID
const CLOUD_ENV_ID = 'your-env-id';

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库版本过低，无法使用云开发能力，请将基础库调整为 2.2.3 及以上');
      return;
    }

    wx.cloud.init({
      env: CLOUD_ENV_ID,
      traceUser: true
    });
  },

  globalData: {
    appName: 'funnel-analytics-miniprogram',
    // 与 wx.cloud.init 共用同一个常量：环境 ID 只在这里写一次，
    // 避免将来本地改回自己的环境时只改了一处、另一处还指向旧环境。
    envId: CLOUD_ENV_ID
  }
});
