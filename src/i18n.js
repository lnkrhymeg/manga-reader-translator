/*
 * i18n.js — 扩展界面文案（简体中文 / English）
 *
 * 与「翻译目标语言」无关：那是 manga-translator-ui 的多语言翻译配置，
 * 由 presets/languages.json + GET /config/options 提供。
 */
(function (root) {
  'use strict';

  const STRINGS = {
    zh: {
      appName: 'MangaTrans',
      // 悬浮面板
      panelStart: '开始翻译',
      panelPause: '暂停',
      panelResume: '继续',
      panelRetranslate: '重译本话',
      panelSettings: '设置',
      panelCollapse: '收起',
      panelExpand: '展开',
      panelChapter: '本章 {done}/{total}',
      panelNext: '下一话 {done}/{total}',
      panelQueue: '队列 {n}',
      panelFailed: '失败 {n}',
      panelSkipped: '跳过 {n}',
      panelThrottled: '已降速',
      panelCooldown: '冷却 {n}s',
      errPage: '取页图失败（HTTP {status}）',
      errStreamAborted: '服务端中断了响应，通常是并发超限（用户组 max_concurrent_tasks）',
      errConcurrent: '服务端并发已满',
      panelIdle: '未开始',
      panelPreheating: '预热中…',
      panelTranslating: '翻译中…',
      panelDone: '本话已译完',
      panelIdleHint: '点击「开始翻译」，会先预热本章与下一话前若干页，再随阅读进度续翻。',
      panelRetryFailed: '重试失败页',
      panelNoNext: '已是最后一话',
      // 错误
      errServerOffline: '翻译服务未启动',
      errServerOfflineHint: '请在 manga-translator-ui 目录运行：python -m manga_translator web --port 8000',
      errAuth: '登录失败，请检查用户名与密码',
      errPermission: '没有使用该翻译器/OCR 的权限',
      errBadConfig: '翻译配置被服务端拒绝（HTTP {status}）',
      errTranslate: '翻译失败（HTTP {status}）',
      errNotFound: '页面不存在（HTTP 404）',
      errTooMany: '服务端繁忙，稍后重试',
      // 弹窗
      popupEnabled: '翻译已开启',
      popupDisabled: '翻译已关闭',
      popupToggle: '启用翻译',
      popupOpenOptions: '打开设置',
      popupNotConfigured: '尚未完成设置，请先填写地址与账号',
      popupNotReader: '当前标签页不是 Suwayomi 阅读器',
      popupReaderHint: '打开 /manga/…/chapter/… 页面即可看到悬浮面板',
      // 设置页
      optTitle: 'MangaTrans 设置',
      optSecConnection: '连接',
      optSuwayomiBase: 'Suwayomi 地址',
      optMtBase: 'Manga Translator 地址',
      optUsername: '用户名',
      optPassword: '密码',
      optSecPermission: '授权',
      optPermissionHint: '保存时会申请这两个站点的访问权限，并把翻译脚本只注入 Suwayomi 这一个站点。',
      optGrantSave: '保存并授权',
      optPermissionDenied: '权限被拒绝，扩展无法工作',
      optReloadTabs: '重新加载已打开的 Suwayomi 标签页',
      optSecConfig: '翻译配置',
      optConfigMode: '配置模式',
      optModeServer: '跟随服务端（推荐）',
      optModeCustom: '自定义',
      optModeServerHint: '不发送任何参数，服务端用自己的 config/config.json。',
      optModeCustomHint: '三层合并：内置预设 → 服务端配置 → 下面选择的项。',
      optPreset: '预设',
      optPresetStandard: '标准检测 (2048)',
      optPresetHigh: '高精度检测 (4096)',
      optPresetCustom: '自定义 JSON',
      optTargetLang: '目标语言',
      optKeepLang: '保留语言',
      optTranslator: '翻译器',
      optOcr: 'OCR',
      optSecondaryOcr: '二次 OCR',
      optDetector: '检测器',
      optInpainter: '修复器',
      optRenderer: '渲染器',
      optServerValue: '使用服务端值',
      optSecScheduling: '调度',
      optConcurrency: '并发数',
      optPreheatPages: '预热页数',
      optLookahead: '预读页数',
      optFullChapter: '翻译整章',
      optSecAdvanced: '高级',
      optJson: '完整配置 JSON',
      optJsonLoad: '载入到编辑器',
      optJsonApply: '应用编辑器内容',
      optJsonExport: '导出',
      optJsonImport: '导入',
      optSyncServer: '重新同步服务端配置',
      optSecCache: '缓存',
      optCacheCount: '已缓存 {n} 页',
      optClearCache: '清空翻译缓存',
      // 通用
      btnSave: '保存',
      btnTest: '测试连接',
      btnTesting: '测试中…',
      btnSaved: '已保存',
      btnDone: '完成',
      testSuwayomi: 'Suwayomi 连接',
      testMt: '翻译服务连接',
      testLogin: '登录',
      testOptions: '读取配置选项',
      testOk: '正常',
      testFail: '失败',
      testSkipped: '跳过（{reason}）',
      testEmpty: '{field} 为空',
      testUnauthorized: '无法访问（可能还没授权该站点）',
      testNeedSetup: '尚未初始化管理员',
      testNoLogin: '未登录',
      warnGroupConfig: '服务端用户组里有不被接受的参数值：{list}（已自动退回预设值）'
    },
    en: {
      appName: 'MangaTrans',
      panelStart: 'Translate',
      panelPause: 'Pause',
      panelResume: 'Resume',
      panelRetranslate: 'Re-translate chapter',
      panelSettings: 'Settings',
      panelCollapse: 'Collapse',
      panelExpand: 'Expand',
      panelChapter: 'chapter {done}/{total}',
      panelNext: 'next {done}/{total}',
      panelQueue: 'queued {n}',
      panelFailed: 'failed {n}',
      panelSkipped: 'skipped {n}',
      panelThrottled: 'throttled',
      panelCooldown: 'cooldown {n}s',
      errPage: 'Failed to fetch the page image (HTTP {status})',
      errStreamAborted: 'Server aborted the response — usually the per-group concurrency limit',
      errConcurrent: 'Server concurrency limit reached',
      panelIdle: 'idle',
      panelPreheating: 'preheating…',
      panelTranslating: 'translating…',
      panelDone: 'chapter done',
      panelIdleHint: 'Click “Translate” to preheat this chapter and the next one, then keep up with your reading.',
      panelRetryFailed: 'Retry failed',
      panelNoNext: 'last chapter',
      errServerOffline: 'Translator server offline',
      errServerOfflineHint: 'Run in the manga-translator-ui folder: python -m manga_translator web --port 8000',
      errAuth: 'Login failed — check username and password',
      errPermission: 'No permission for this translator/OCR',
      errBadConfig: 'Server rejected the translation config (HTTP {status})',
      errTranslate: 'Translation failed (HTTP {status})',
      errNotFound: 'Page not found (HTTP 404)',
      errTooMany: 'Server busy, retrying later',
      popupEnabled: 'Translation is ON',
      popupDisabled: 'Translation is OFF',
      popupToggle: 'Enable translation',
      popupOpenOptions: 'Open settings',
      popupNotConfigured: 'Not configured yet — set the URLs and credentials',
      popupNotReader: 'This tab is not a Suwayomi reader',
      popupReaderHint: 'Open a /manga/…/chapter/… page to see the panel',
      optTitle: 'MangaTrans Settings',
      optSecConnection: 'Connection',
      optSuwayomiBase: 'Suwayomi URL',
      optMtBase: 'Manga Translator URL',
      optUsername: 'Username',
      optPassword: 'Password',
      optSecPermission: 'Permission',
      optPermissionHint: 'Saving requests access to these two origins and injects the script into the Suwayomi origin only.',
      optGrantSave: 'Save & grant',
      optPermissionDenied: 'Permission denied — the extension cannot work',
      optReloadTabs: 'Reload open Suwayomi tabs',
      optSecConfig: 'Translation config',
      optConfigMode: 'Config mode',
      optModeServer: 'Follow server (recommended)',
      optModeCustom: 'Custom',
      optModeServerHint: 'Sends no parameters; the server uses its own config/config.json.',
      optModeCustomHint: 'Three-layer merge: built-in preset → server config → the choices below.',
      optPreset: 'Preset',
      optPresetStandard: 'Standard detection (2048)',
      optPresetHigh: 'High-precision detection (4096)',
      optPresetCustom: 'Custom JSON',
      optTargetLang: 'Target language',
      optKeepLang: 'Keep language',
      optTranslator: 'Translator',
      optOcr: 'OCR',
      optSecondaryOcr: 'Secondary OCR',
      optDetector: 'Detector',
      optInpainter: 'Inpainter',
      optRenderer: 'Renderer',
      optServerValue: 'Use server value',
      optSecScheduling: 'Scheduling',
      optConcurrency: 'Concurrency',
      optPreheatPages: 'Preheat pages',
      optLookahead: 'Lookahead pages',
      optFullChapter: 'Translate whole chapter',
      optSecAdvanced: 'Advanced',
      optJson: 'Full config JSON',
      optJsonLoad: 'Load into editor',
      optJsonApply: 'Apply editor content',
      optJsonExport: 'Export',
      optJsonImport: 'Import',
      optSyncServer: 'Re-sync server config',
      optSecCache: 'Cache',
      optCacheCount: '{n} pages cached',
      optClearCache: 'Clear translation cache',
      btnSave: 'Save',
      btnTest: 'Test connection',
      btnTesting: 'Testing…',
      btnSaved: 'Saved',
      btnDone: 'Done',
      testSuwayomi: 'Suwayomi connection',
      testMt: 'Translator connection',
      testLogin: 'Login',
      testOptions: 'Read config options',
      testOk: 'OK',
      testFail: 'failed',
      testSkipped: 'skipped ({reason})',
      testEmpty: '{field} is empty',
      testUnauthorized: 'Unreachable (site permission not granted?)',
      testNeedSetup: 'admin account not set up yet',
      testNoLogin: 'not logged in',
      warnGroupConfig: 'The server group has unsupported values: {list} (fell back to presets)'
    }
  };

  let current = 'zh';

  function detect(setting) {
    if (setting === 'zh' || setting === 'en') return setting;
    const nav = (root.navigator && (root.navigator.language || root.navigator.userLanguage)) || 'zh';
    return /^zh/i.test(nav) ? 'zh' : 'en';
  }

  function setLang(setting) {
    current = detect(setting);
    return current;
  }

  function lang() {
    return current;
  }

  function t(key, vars) {
    const table = STRINGS[current] || STRINGS.zh;
    let text = table[key];
    if (text === undefined) text = STRINGS.zh[key];
    if (text === undefined) return key;
    if (vars) {
      for (const name of Object.keys(vars)) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      }
    }
    return text;
  }

  const I18N = { STRINGS, setLang, lang, t, detect };

  root.MTX = Object.assign(root.MTX || {}, { i18n: I18N, t });

  if (typeof module !== 'undefined' && module.exports) module.exports = I18N;
})(typeof globalThis !== 'undefined' ? globalThis : this);
