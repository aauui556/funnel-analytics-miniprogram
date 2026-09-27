const { scenarioLabel } = require('../../utils/scenarios');

// ADR-0002 / ADR-0006：小程序端单次查询最多返回 20 条。
// 首页列表同样受这个上限约束，所以必须翻页，否则第 21 个漏斗会静默消失。
const PAGE_SIZE = 20;

Page({
  data: {
    funnels: [],
    loading: false,
    finished: false,
    loadError: ''
  },

  // 翻页游标和并发锁放在实例上，不放进 data——它们不参与渲染，没必要触发 setData。
  _skip: 0,
  _loading: false,

  onShow() {
    // 用 onShow 而不是 onLoad：从创建页返回时，列表需要重新拉取才会出现新漏斗。
    this.reload();
  },

  onPullDownRefresh() {
    this.reload(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore(false);
  },

  reload(done) {
    this._skip = 0;
    this.setData({ finished: false, loadError: '' }, () => {
      this.loadMore(true, done);
    });
  },

  /**
   * ADR-0006：读取走客户端直查，不经过云函数。
   * ADR-0003：数据隔离由数据库安全规则「仅创建者可读写」保证，所以这里**不手写 _openid 过滤条件**。
   *   前提是 funnels 集合的权限已设为「仅创建者可读写」；若设成「所有用户可读」，
   *   这里就会读到别人的漏斗。这是一条部署时必须确认的前置条件。
   */
  loadMore(reset, done) {
    if (this._loading) return;
    if (!reset && this.data.finished) return;

    this._loading = true;
    this.setData({ loading: true });

    wx.cloud
      .database()
      .collection('funnels')
      .orderBy('createdAt', 'desc') // 新建的排在最前，符合"最近在用"的直觉
      .skip(this._skip)
      .limit(PAGE_SIZE)
      .get()
      .then((res) => {
        const rows = res.data.map((item) => ({
          _id: item._id,
          name: item.name,
          scenarioLabel: scenarioLabel(item.scenario),
          stageCount: Array.isArray(item.stages) ? item.stages.length : 0,
          createdAtText: formatTime(item.createdAt)
        }));

        this._skip += res.data.length;

        this.setData({
          funnels: reset ? rows : this.data.funnels.concat(rows),
          // 返回条数少于一页，说明后面没有了。不额外查一次 count()，省一次往返。
          finished: res.data.length < PAGE_SIZE
        });
      })
      .catch((err) => {
        console.error('[index] 读取 funnels 失败', err);
        this.setData({
          loadError: '读取失败：' + (err.errMsg || err.message || '未知错误')
        });
      })
      .then(() => {
        this._loading = false;
        this.setData({ loading: false });
        if (typeof done === 'function') done();
      });
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/funnel-create/funnel-create' });
  },

  // 点击卡片进入详情页。详情页需要 funnelId 来确定看哪个漏斗。
  openFunnel(e) {
    const funnelId = e.currentTarget.dataset.id;
    if (!funnelId) return;
    wx.navigateTo({ url: '/pages/funnel-detail/funnel-detail?funnelId=' + funnelId });
  },

  // 录入数据的快捷入口：必须带上 funnelId，导入页靠它确定目标漏斗与该漏斗的阶段顺序。
  goImport(e) {
    const funnelId = e.currentTarget.dataset.id;
    if (!funnelId) return;
    wx.navigateTo({ url: '/pages/data-import/data-import?funnelId=' + funnelId });
  }
});

function formatTime(value) {
  // createdAt 由云函数写入 Date.now()（毫秒数）。不是数字就返回空串，不猜。
  if (typeof value !== 'number') return '';

  const d = new Date(value);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}
