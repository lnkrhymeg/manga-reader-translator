/*
 * popup.js — 工具栏弹窗：总开关、当前状态、重译本话、打开设置
 *
 * 状态来自内容脚本（阅读器页）。没装内容脚本的标签页只显示「不是阅读器」。
 */
(function () {
  'use strict';

  const M = window.MTX;
  const t = (key, vars) => M.i18n.t(key, vars);
  const $ = (id) => document.getElementById(id);

  let settings = null;
  let tabId = null;
  let status = null;

  function fatalText(code) {
    const key = {
      auth: 'errAuth',
      permission: 'errPermission',
      'bad-config': 'errBadConfig',
      'server-offline': 'errServerOffline',
      'stream-aborted': 'errStreamAborted',
      busy: 'errConcurrent',
      page: 'errPage'
    }[code] || 'errTranslate';
    return t(key, { status: '' });
  }

  function render() {
    $('toggleLabel').textContent = t('popupToggle');
    $('optionsBtn').textContent = t('popupOpenOptions');
    $('retranslateBtn').textContent = t('panelRetranslate');

    const enabled = settings ? !!settings.enabled : false;
    $('enableToggle').checked = enabled;

    if (!status) {
      $('stateText').className = 'state off';
      $('stateText').textContent = t('popupNotReader');
      $('detail').textContent = t('popupReaderHint');
      $('retranslateBtn').disabled = true;
      $('sessionInfo').textContent = '';
      return;
    }

    $('retranslateBtn').disabled = !status.running;
    $('stateText').className = 'state ' + (status.running ? 'on' : 'off');
    $('stateText').textContent = status.running ? t('popupEnabled') : t('popupDisabled');

    if (status.fatal) {
      $('detail').textContent = fatalText(status.fatal.code);
    } else if (status.session) {
      const s = status.stats || {};
      const parts = [
        t('panelChapter', { done: s.chapterDone || 0, total: s.chapterTotal > 0 ? s.chapterTotal : '?' })
      ];
      if (s.queued) parts.push(t('panelQueue', { n: s.queued }));
      if (s.failed) parts.push(t('panelFailed', { n: s.failed }));
      if (s.skipped) parts.push(t('panelSkipped', { n: s.skipped }));
      if (s.cooldownMs > 0) parts.push(t('panelCooldown', { n: Math.ceil(s.cooldownMs / 1000) }));
      $('detail').textContent = parts.join(' · ');

      // 失败原因单独一行，别让用户对着一个数字猜
      if (s.failed > 0 && s.lastError) {
        $('detail').textContent += '  ⚠ ' + fatalText(s.lastError.code);
      }
    } else {
      $('detail').textContent = t('panelIdleHint');
    }

    $('sessionInfo').textContent = status.session
      ? '#' + status.session.mangaId + ' / ' + status.session.chapterIndex
      : '';
  }

  async function ask(message) {
    if (tabId === null) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      return null;
    }
  }

  async function refresh() {
    settings = await M.getSettings();
    M.i18n.setLang(settings.uiLang);

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    tabId = tab && tab.id !== undefined ? tab.id : null;
    status = await ask({ type: 'mangatrans:status' });
    render();
  }

  function bind() {
    $('enableToggle').addEventListener('change', async (event) => {
      const enabled = event.target.checked;
      await M.saveSettings({ enabled });
      settings = await M.getSettings();
      if (!status) {
        render();
        return;
      }
      await ask({ type: 'mangatrans:setEnabled', enabled });
      status = await ask({ type: 'mangatrans:status' });
      render();
    });

    $('retranslateBtn').addEventListener('click', async () => {
      await ask({ type: 'mangatrans:retranslate' });
      setTimeout(refresh, 400);
    });

    $('optionsBtn').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
  }

  (async function init() {
    await refresh();
    bind();
  })().catch((e) => console.error('[MangaTrans] popup 初始化失败', e));
})();
