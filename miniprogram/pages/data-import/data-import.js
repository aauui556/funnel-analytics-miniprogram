const { parseTable, transposeText } = require('../../utils/parse-table');

// 错误一次列全（D9），但界面上最多铺这么多条，其余用总数交代清楚。
const MAX_SHOWN_ERRORS = 30;

Page({
  data: {
    funnelId: '',
    funnelName: '',
    stages: [],
    stageSummary: '',

    loadingFunnel: true,
    loadError: '',

    text: '',
    placeholderText: '',

    // 解析状态
    parsed: false,
    parseOk: false,
    previewRows: [],
    previewCount: 0,
    dateRangeText: '',
    parseErrors: [],
    parseErrorCount: 0,

    // 云函数返回的校验问题（服务端复核没通过时才会有内容）
    importErrors: [],
    importErrorCount: 0,
    importing: false
  },

  // 同一段文本只提示一次转置，避免每次失焦都弹窗
  _transposePromptedFor: null,

  onLoad(options) {
    const funnelId = options && options.funnelId ? options.funnelId : '';

    // 没有 funnelId 就没法确定导入到哪个漏斗。不猜、不选默认值，直接说清楚。
    if (!funnelId) {
      this.setData({
        loadingFunnel: false,
        loadError: '缺少漏斗参数。请从首页某个漏斗卡片上的「录入数据」进入。'
      });
      return;
    }

    this.setData({
      funnelId,
      // 表头示例用真实制表符和换行，避免把转义写成字面量
      placeholderText: '日期\t曝光\t点击\t注册\n2025-05-01\t1000\t300\t90'
    });

    this.loadFunnel(funnelId);
  },

  /**
   * ADR-0006：读取走客户端直查，不经过云函数。
   * ADR-0003：隔离由安全规则「仅创建者可读写」保证，所以这里不手写 _openid 过滤条件。
   * 需要漏斗的 stages 做两件事：按名称匹配表头（D5）、把 counts 对齐到这个顺序（ADR-0002）。
   */
  loadFunnel(funnelId) {
    wx.cloud
      .database()
      .collection('funnels')
      .doc(funnelId)
      .get()
      .then((res) => {
        const funnel = res.data || {};
        const stages = Array.isArray(funnel.stages) ? funnel.stages : [];

        this.setData({
          loadingFunnel: false,
          funnelName: funnel.name || '',
          stages,
          stageSummary: stages.join(' → ')
        });

        if (funnel.name) {
          wx.setNavigationBarTitle({ title: funnel.name });
        }
      })
      .catch((err) => {
        console.error('[data-import] 读取漏斗失败', err);
        this.setData({
          loadingFunnel: false,
          loadError:
            '读取漏斗失败：' +
            (err.errMsg || err.message || '未知错误') +
            '（如果确认该漏斗存在，请检查 funnels 集合的权限是否为「仅创建者可读写」）'
        });
      });
  },

  /**
   * D7：从剪贴板读取纯文本。
   * 小程序里粘贴只能拿到纯文本（制表符分隔），没有"打开 xlsx 文件"这回事。
   */
  readClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const text = res.data || '';
        if (!text) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' });
          return;
        }
        // 读到就顺手解析一次，并允许在失败时提示转置（D8）
        this.setData({ text }, () => this.runParse({ offerTranspose: true }));
      },
      fail: () => {
        wx.showToast({ title: '读取剪贴板失败，请在下方手动粘贴', icon: 'none' });
      }
    });
  },

  onTextInput(e) {
    // 内容一变，之前的预览就不再代表当前文本了，直接清掉，
    // 避免出现"预览是旧的、贴的是新的"这种时间差。确认导入前还会再解析一次兜底。
    this.setData({
      text: e.detail.value,
      parsed: false,
      parseOk: false,
      previewRows: [],
      previewCount: 0,
      dateRangeText: '',
      parseErrors: [],
      parseErrorCount: 0
    });
  },

  onTextBlur() {
    this.runParse({ offerTranspose: true });
  },

  /**
   * D8 一键转置：只由使用者主动触发。
   * 转置作用在**原始文本矩阵**上、必须在解析之前；程序绝不自动判断表格方向——
   * 猜错就是整月数据静默错位，那种错误在图上看起来完全正常。
   */
  transpose() {
    const next = transposeText(this.data.text);
    if (!next) {
      wx.showToast({ title: '没有可转置的内容', icon: 'none' });
      return;
    }

    // 转置是对合运算，再按一次就转回去了，所以不需要额外的撤销按钮。
    this.setData({ text: next }, () => this.runParse({ offerTranspose: false }));
  },

  /** D8：解析失败时主动问一句是否转置，但同一段文本只问一次。 */
  offerTranspose() {
    const text = this.data.text;
    if (this._transposePromptedFor === text) return;
    this._transposePromptedFor = text;

    wx.showModal({
      title: '没解析成功',
      content: '有没有可能是行列贴反了？可以试试一键转置。',
      confirmText: '尝试转置',
      cancelText: '先不改',
      success: (res) => {
        if (res.confirm) this.transpose();
      }
    });
  },

  /**
   * 解析当前文本。返回解析结果，供调用方直接判断。
   * 注意这是"体验层的预览"——真正决定能不能入库的是云函数里的复核（D9）。
   */
  runParse(options) {
    const opts = options || {};
    const stages = this.data.stages;

    if (stages.length === 0) {
      const empty = { ok: false, rows: [], errors: [], errorCount: 0 };
      this.setData({
        parsed: false,
        parseOk: false,
        previewRows: [],
        previewCount: 0,
        dateRangeText: '',
        parseErrors: [],
        parseErrorCount: 0
      });
      return empty;
    }

    const result = parseTable(this.data.text, stages);
    const dates = result.rows.map((row) => row.date).sort();

    this.setData({
      previewRows: result.rows.map((row) => ({
        date: row.date,
        cells: row.counts.map((value, index) => ({ key: 'c' + index, text: String(value) }))
      })),
      previewCount: result.rows.length,
      dateRangeText: dates.length ? dates[0] + ' → ' + dates[dates.length - 1] : '',
      parseErrors: result.errors.slice(0, MAX_SHOWN_ERRORS).map((err, index) => ({
        id: index,
        positionText: buildPositionText(err),
        message: err.message
      })),
      parseErrorCount: result.errorCount,
      parsed: true,
      parseOk: result.ok
    });

    if (!result.ok && opts.offerTranspose) {
      this.offerTranspose();
    }

    return result;
  },

  /** 确认导入：先按当前文本重新解析一次，再交给云函数。 */
  onImport() {
    if (this.data.importing) return;
    if (!this.data.funnelId || this.data.stages.length === 0) return;

    const result = this.runParse({ offerTranspose: false });
    if (!result.ok) {
      wx.showToast({ title: '数据还有问题，未提交', icon: 'none' });
      return;
    }

    const dates = result.rows.map((row) => row.date).sort();

    this.setData({ importing: true, importErrors: [], importErrorCount: 0 });

    // ADR-0006：写入只能走云函数，客户端绝不直接写 records。
    // ADR-0003：_openid 由云函数从 getWXContext() 取，客户端不传。
    // D9：云函数会用事务整批写入，任何一处不合格就整批回滚。
    wx.cloud.callFunction({
      name: 'importRecords',
      data: {
        funnelId: this.data.funnelId,
        // 这个 dateRange 只是给云函数排查用的参考值——服务端会自己从 parsedRows 重新推导，
        // 不采信客户端算出来的元数据。
        dateRange: { start: dates[0], end: dates[dates.length - 1] },
        parsedRows: result.rows.map((row) => ({ date: row.date, counts: row.counts }))
      },
      success: (res) => {
        const payload = res.result || {};

        if (!payload.ok) {
          const list = Array.isArray(payload.errors) ? payload.errors : [];
          this.setData({
            importErrors: list.map((item, index) => ({
              id: index,
              positionText: '',
              message: typeof item === 'string' ? item : item.message || JSON.stringify(item)
            })),
            importErrorCount:
              typeof payload.errorCount === 'number' ? payload.errorCount : list.length
          });

          wx.showModal({
            title: '导入未完成',
            content: (payload.message || '数据校验未通过') + '。数据库没有任何改动。',
            showCancel: false
          });
          return;
        }

        this._imported = true;

        // D26：必须把"存了多少、能看到多少"讲清楚——
        // 存了 90 天却只能看 30 天而不说明，使用者会认定数据丢了。
        wx.showModal({
          title: '导入成功',
          content:
            '已保存 ' +
            payload.savedDays +
            ' 天，当前展示最近 ' +
            payload.displayDays +
            ' 天（最多 ' +
            payload.maxDisplayDays +
            ' 天）。本次新增 ' +
            payload.createdDays +
            ' 天、覆盖 ' +
            payload.overwrittenDays +
            ' 天。',
          showCancel: false,
          confirmText: '查看漏斗',
          success: () => this.goToDetail(payload)
        });
      },
      fail: (err) => {
        const message = (err && err.errMsg) || '云函数调用失败';
        this.setData({
          importErrors: [{ id: 0, positionText: '', message }],
          importErrorCount: 1
        });
        wx.showModal({
          title: '导入失败',
          content: message + '。如果提示找不到云函数，请先在开发者工具里部署 importRecords。',
          showCancel: false
        });
      },
      complete: () => {
        // 成功时会弹窗并返回首页，这里不清 importing，避免重复提交
        if (!this._imported) this.setData({ importing: false });
      }
    });
  },

  /**
   * 导入完成后直接进详情页。
   * D26：把"已保存 N 天、当前展示最近 M 天"两个数字带过去，
   * 由详情页在顶部如实展示——存了 90 天却只能看 30 天而不说明，使用者会以为数据丢了。
   */
  goToDetail(payload) {
    const saved = payload && payload.savedDays ? payload.savedDays : 0;
    const display = payload && payload.displayDays ? payload.displayDays : saved;
    const url =
      '/pages/funnel-detail/funnel-detail?funnelId=' +
      this.data.funnelId +
      '&saved=' +
      saved +
      '&display=' +
      display;

    // 用 redirectTo：导入页已经完成使命，不该留在返回栈里
    wx.redirectTo({
      url,
      fail: () => wx.reLaunch({ url: '/pages/index/index' })
    });
  }
});

function buildPositionText(err) {
  if (!err || !err.line) return '表头';
  if (!err.column) return '第 ' + err.line + ' 行';
  return '第 ' + err.line + ' 行 第 ' + err.column + ' 列';
}
