/*
 * content.js — 内容脚本入口
 *
 * 只注入到用户授权的 Suwayomi 源（由设置页用 chrome.scripting 动态注册）。
 * 不是阅读器页就什么都不做。
 */
(function () {
  'use strict';

  // 内容脚本运行在隔离世界，这个标记只防止同一页面被注入两次
  if (window.__mangatransLoaded) return;
  window.__mangatransLoaded = true;

  const M = window.MTX;

  const makeClient = (s) => M.mt.createClient({
    base: s.mtBase,
    username: s.username,
    password: s.password
  });

  (async function boot() {
    // engine 创建晚于 panel，但 handler 只会在用户点击时执行
    let engine = null;
    let settings = await M.getSettings();
    M.i18n.setLang(settings.uiLang);

    if (!M.parseReaderPath(location.pathname, settings.readerUrlPattern)) {
      console.log('[MangaTrans] 非阅读器页，跳过');
      return;
    }

    function commit(enabled) {
      settings.enabled = enabled;
      M.saveSettings({ enabled }).catch(() => {});
      engine.applySettings(settings);
    }

    const panel = M.engine.createPanel({
      onToggle: () => commit(!engine.isRunning()),
      onRetranslate: () => engine.retranslateChapter(),
      onOpenSettings: () => { chrome.runtime.openOptionsPage(); }
    });

    // settings 与 engine 共用同一个对象，面板开关和设置页改动都落在它上面
    engine = M.engine.createEngine({ settings, panel, client: makeClient(settings) });

    M.onSettingsChanged((next) => {
      const credentialsChanged =
        next.mtBase !== settings.mtBase ||
        next.username !== settings.username ||
        next.password !== settings.password;

      Object.assign(settings, next);
      M.i18n.setLang(settings.uiLang);
      if (credentialsChanged) engine.setClient(makeClient(settings));
      engine.applySettings(settings);
      panel.update(engine.state);
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return undefined;
      if (!message.type.startsWith('mangatrans:')) return undefined;

      if (message.type === 'mangatrans:status') {
        const session = engine.state.session;
        sendResponse({
          onReader: true,
          running: engine.isRunning(),
          enabled: settings.enabled,
          stats: engine.state.stats,
          session: session ? { mangaId: session.mangaId, chapterIndex: session.chapterIndex } : null,
          fatal: engine.state.fatal
        });
        return true;
      }
      if (message.type === 'mangatrans:setEnabled') {
        commit(!!message.enabled);
        sendResponse({ ok: true, running: engine.isRunning() });
        return true;
      }
      if (message.type === 'mangatrans:retranslate') {
        engine.retranslateChapter();
        sendResponse({ ok: true });
        return true;
      }
      if (message.type === 'mangatrans:cacheInfo') {
        // 缓存建在 Suwayomi 页面的源下，只有内容脚本能读到
        M.cache.count().then((count) => sendResponse({ ok: true, count }));
        return true;
      }
      if (message.type === 'mangatrans:clearCache') {
        M.cache.clear().then(() => sendResponse({ ok: true }));
        return true;
      }
      return undefined;
    });

    window.addEventListener('pagehide', () => engine.destroy());

    panel.update(engine.state);
    if (settings.enabled) {
      engine.start().catch((e) => console.error('[MangaTrans] 启动失败', e));
    } else {
      console.log('[MangaTrans] 已就绪（默认关闭；点面板「开始翻译」或打开弹窗里的总开关）');
    }
  })().catch((e) => console.error('[MangaTrans] 初始化失败', e));
})();
