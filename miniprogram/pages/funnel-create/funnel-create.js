const {
  DEFAULT_STAGES,
  SCENARIOS,
  STAGE_MIN,
  STAGE_MAX,
  STAGE_NAME_MAX
} = require('../../utils/scenarios');

Page({
  data: {
    scenarioOptions: SCENARIOS,
    scenarioKey: SCENARIOS[0].key,
    // 阶段以对象数组存放，key 是稳定的行标识，name 才是阶段名。
    // 原因有两个：① WXML 的 wx:key 需要一个稳定且唯一的值，而阶段名在编辑过程中可能暂时重复；
    // ② 按 D5，阶段身份其实由**下标**决定，name 只是显示与导入匹配用的，两者要分开。
    stages: [],
    name: '',
    saving: false,
    errorMessage: '',
    stageMin: STAGE_MIN,
    stageMax: STAGE_MAX,
    stageNameMax: STAGE_NAME_MAX,
    canAdd: true,
    canRemove: false,
    addStageText: ''
  },

  // 当前编辑中的阶段来自哪个模板的默认值，用于判断"用户是否改过阶段"。
  _appliedTemplate: SCENARIOS[0].key,
  _stageSeq: 0,
  _created: false,

  onLoad() {
    this.applyTemplate(SCENARIOS[0].key);
  },

  onScenarioChange(e) {
    const key = e.detail.value;
    if (!DEFAULT_STAGES[key]) return;

    if (!this.hasEditedStages()) {
      this.applyTemplate(key);
      return;
    }

    // 切换模板会用新模板的默认阶段覆盖当前内容。按项目原则（不静默丢失用户输入），
    // 这里必须先确认，而不是默默清空。
    wx.showModal({
      title: '切换模板会覆盖当前阶段',
      content: '你修改过阶段名称或数量。切换后会被重置为新模板的默认阶段，且无法撤销。',
      confirmText: '仍要切换',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          this.applyTemplate(key);
        } else {
          // 用户取消：把单选控件拨回原选项，否则界面会显示成已经切换了。
          this.setData({ scenarioKey: this._appliedTemplate });
        }
      }
    });
  },

  hasEditedStages() {
    const base = DEFAULT_STAGES[this._appliedTemplate] || [];
    const current = this.data.stages.map((stage) => stage.name);
    if (base.length !== current.length) return true;
    return base.some((name, index) => name !== current[index]);
  },

  applyTemplate(key) {
    // 必须复制一份：常量表是模块级共享对象，直接引用会被后续编辑污染。
    const stages = (DEFAULT_STAGES[key] || []).map((name) => this.makeStage(name));
    this._appliedTemplate = key;
    this.setData({
      scenarioKey: key,
      stages,
      errorMessage: ''
    });
    this.syncStageButtons(stages.length);
  },

  makeStage(name) {
    this._stageSeq += 1;
    return { key: 's' + this._stageSeq, name };
  },

  syncStageButtons(count) {
    this.setData({
      canAdd: count < STAGE_MAX,
      canRemove: count > STAGE_MIN,
      // 文案在 JS 里拼好，避免把字符串拼接写进 WXML 表达式
      addStageText: count < STAGE_MAX ? '+ 添加阶段' : '已达 ' + STAGE_MAX + ' 段上限'
    });
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value, errorMessage: '' });
  },

  onStageNameInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const value = e.detail.value;

    // 值没变就不重渲染。setData 整个数组会让输入框重绘，在中文输入法下可能打断打词。
    if (this.data.stages[index] && this.data.stages[index].name === value) return;

    const stages = this.data.stages.slice();
    stages[index] = { key: stages[index].key, name: value };
    this.setData({ stages, errorMessage: '' });
  },

  addStage() {
    if (this.data.stages.length >= STAGE_MAX) return;

    // 新阶段名留空，让使用者自己填。这里刻意不生成"阶段 6"这类占位名——
    // 那是替使用者编造一个业务含义，属于"猜"。
    const stages = this.data.stages.concat(this.makeStage(''));
    this.setData({ stages, errorMessage: '' });
    this.syncStageButtons(stages.length);
  },

  removeStage(e) {
    if (this.data.stages.length <= STAGE_MIN) return;

    const index = Number(e.currentTarget.dataset.index);
    const stages = this.data.stages.slice();
    stages.splice(index, 1);
    this.setData({ stages, errorMessage: '' });
    this.syncStageButtons(stages.length);
  },

  /**
   * 前端校验（对应 D3、D5）。只负责体验，不是唯一防线——
   * 云函数 createFunnel 会用同一套规则再校验一遍，因为任何人都能伪造一次 callFunction 请求。
   */
  validate() {
    const name = this.data.name.trim();
    const stages = this.data.stages.map((stage) => (stage.name || '').trim());

    if (!name) return { ok: false, message: '请填写漏斗名称' };
    if (name.length > 40) return { ok: false, message: '漏斗名称不能超过 40 个字符' };

    if (stages.length < STAGE_MIN || stages.length > STAGE_MAX) {
      return { ok: false, message: '阶段数量必须在 ' + STAGE_MIN + '–' + STAGE_MAX + ' 段之间' };
    }

    const emptyIndex = stages.findIndex((stage) => !stage);
    if (emptyIndex !== -1) {
      return { ok: false, message: '第 ' + (emptyIndex + 1) + ' 个阶段名称为空' };
    }

    const tooLongIndex = stages.findIndex((stage) => stage.length > STAGE_NAME_MAX);
    if (tooLongIndex !== -1) {
      return {
        ok: false,
        message: '第 ' + (tooLongIndex + 1) + ' 个阶段名称不能超过 ' + STAGE_NAME_MAX + ' 个字符'
      };
    }

    // D5：同一漏斗内阶段名称必须唯一。因为导入时按**名称**匹配阶段，
    // 重名会让"这一列数字属于哪一段"变得无法判定。
    const seen = {};
    for (let i = 0; i < stages.length; i++) {
      if (seen[stages[i]]) {
        return { ok: false, message: '阶段名称重复：' + stages[i] };
      }
      seen[stages[i]] = true;
    }

    return { ok: true, name, stages };
  },

  save() {
    if (this.data.saving) return;

    const result = this.validate();
    if (!result.ok) {
      this.setData({ errorMessage: result.message });
      wx.showToast({ title: result.message, icon: 'none' });
      return;
    }

    this.setData({ saving: true, errorMessage: '' });

    // ADR-0006：写入只能走云函数，客户端绝不直接写库。
    // ADR-0003：_openid 由云函数从 getWXContext() 里取，客户端不传、也不应该传——
    //   否则用户就能伪造数据归属。
    wx.cloud.callFunction({
      name: 'createFunnel',
      data: {
        name: result.name,
        scenario: this.data.scenarioKey,
        stages: result.stages
      },
      success: (res) => {
        const payload = res.result || {};

        if (!payload.ok) {
          const message = payload.message || '创建失败';
          this.setData({ errorMessage: message, saving: false });
          wx.showToast({ title: message, icon: 'none' });
          return;
        }

        // 标记成功。complete 里据此不清 saving，避免在返回首页前的这几百毫秒内被重复点击、
        // 建出两个同名漏斗。
        this._created = true;
        wx.showToast({ title: '创建成功', icon: 'success', duration: 600 });
        setTimeout(() => this.goBackToList(), 600);
      },
      fail: (err) => {
        const message = (err && err.errMsg) || '云函数调用失败';
        this.setData({ errorMessage: message, saving: false });
        wx.showToast({ title: '创建失败', icon: 'none' });
      },
      complete: () => {
        if (!this._created) this.setData({ saving: false });
      }
    });
  },

  goBackToList() {
    // 首页在 onShow 里重新拉取列表，所以返回后新漏斗会自动出现，这里不需要做任何刷新。
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/index/index' })
    });
  }
});
