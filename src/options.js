/*
 * options.js — 设置页
 *
 * 职责：连接信息与授权、多语言翻译配置、调度参数、完整 JSON 编辑、缓存管理。
 * 关键约束：chrome.permissions.request 必须在用户手势里同步发起，
 * 所以点击处理函数第一件事就是申请权限，之后才 await 其它东西。
 */
(function () {
  'use strict';

  const M = window.MTX;
  const t = (key, vars) => M.i18n.t(key, vars);
  const $ = (id) => document.getElementById(id);

  const SCRIPT_ID = 'mangatrans-reader';
  const CONTENT_SCRIPTS = [
    'src/i18n.js',
    'src/shared.js',
    'src/cache.js',
    'src/mt-api.js',
    'src/engine.js',
    'src/content.js'
  ];
  const USE_SERVER = ''; // 下拉框「使用服务端值」的哨兵

  const PRESET_FILES = {
    standard: 'presets/standard.json',
    'high-precision': 'presets/high-precision.json'
  };

  let settings = null;
  let languages = null;
  let presetCache = {};
  let serverOptions = null;
  let client = null;
  /** 最近一次从存储载入编辑器的内容，用来判断用户有没有手动改过 */
  let jsonEditorClean = null;

  // ---------------------------------------------------------------------------
  // 静态文案
  // ---------------------------------------------------------------------------

  function applyStaticText() {
    document.documentElement.lang = M.i18n.lang() === 'zh' ? 'zh-CN' : 'en';
    document.title = t('optTitle');
    $('pageTitle').textContent = t('optTitle');
    $('pageLead').textContent = t('optPermissionHint');

    $('hConnection').textContent = t('optSecConnection');
    $('lSuwayomi').textContent = t('optSuwayomiBase');
    $('lMt').textContent = t('optMtBase');
    $('lUser').textContent = t('optUsername');
    $('lPass').textContent = t('optPassword');
    $('connHint').textContent = t('errServerOfflineHint');
    $('saveBtn').textContent = t('optGrantSave');
    $('testBtn').textContent = t('btnTest');
    $('reloadTabsBtn').textContent = t('optReloadTabs');

    $('hConfig').textContent = t('optSecConfig');
    $('lMode').textContent = t('optConfigMode');
    $('configMode').options[0].textContent = t('optModeServer');
    $('configMode').options[1].textContent = t('optModeCustom');
    $('lPreset').textContent = t('optPreset');
    $('lTargetLang').textContent = t('optTargetLang');
    $('lKeepLang').textContent = t('optKeepLang');
    $('lTranslator').textContent = t('optTranslator');
    $('lOcr').textContent = t('optOcr');
    $('lSecondaryOcr').textContent = t('optSecondaryOcr');
    $('lDetector').textContent = t('optDetector');
    $('lInpainter').textContent = t('optInpainter');
    $('lRenderer').textContent = t('optRenderer');
    $('syncBtn').textContent = t('optSyncServer');

    $('hScheduling').textContent = t('optSecScheduling');
    $('lConcurrency').textContent = t('optConcurrency');
    $('lPreheat').textContent = t('optPreheatPages');
    $('lLookahead').textContent = t('optLookahead');
    $('lFullChapter').textContent = t('optFullChapter');
    $('schedHint').textContent = t('panelIdleHint');

    $('hAdvanced').textContent = t('optSecAdvanced');
    $('jsonHint').textContent = t('optModeCustomHint');
    $('loadJsonBtn').textContent = t('optJsonLoad');
    $('applyJsonBtn').textContent = t('optJsonApply');
    $('exportJsonBtn').textContent = t('optJsonExport');
    $('importJsonBtn').textContent = t('optJsonImport');

    $('hCache').textContent = t('optSecCache');
    $('clearCacheBtn').textContent = t('optClearCache');
    updateModeHint();
  }

  function updateModeHint() {
    const custom = $('configMode').value === 'custom';
    $('modeHint').textContent = custom ? t('optModeCustomHint') : t('optModeServerHint');
    for (const id of ['preset', 'targetLang', 'keepLang', 'translator', 'ocr', 'secondaryOcr', 'detector', 'inpainter', 'renderer']) {
      $(id).disabled = !custom;
    }
  }

  // ---------------------------------------------------------------------------
  // 下拉框
  // ---------------------------------------------------------------------------

  function setOptions(select, items, current) {
    select.textContent = '';
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    }
    select.value = items.some((i) => i.value === current) ? current : '';
  }

  /** 服务端选项优先（已按权限过滤），否则用内置表兜底 */
  function languageItems(serverList, table) {
    const codes = Array.isArray(serverList) && serverList.length
      ? serverList
      : Object.keys(table);
    const zh = M.i18n.lang() === 'zh';
    return codes.map((code) => {
      const names = table[code];
      const label = names ? (zh ? names.zh : names.en) : code;
      return { value: code, label: label + ' (' + code + ')' };
    });
  }

  function featureItems(key) {
    const list = serverOptions && Array.isArray(serverOptions[key]) ? serverOptions[key] : null;
    const items = [{ value: USE_SERVER, label: t('optServerValue') }];
    if (list) {
      for (const value of list) items.push({ value, label: value });
    }
    return items;
  }

  function presetItems() {
    return [
      { value: 'standard', label: t('optPresetStandard') },
      { value: 'high-precision', label: t('optPresetHigh') },
      { value: 'custom', label: t('optPresetCustom') }
    ];
  }

  function rebuildDynamicSelects() {
    const profile = settings.profile || {};
    const overrides = profile.overrides || {};

    setOptions($('preset'), presetItems(), profile.presetId || 'standard');

    const targetItems = languageItems(serverOptions && serverOptions.target_lang, languages.targetLangs);
    setOptions($('targetLang'), [{ value: USE_SERVER, label: t('optServerValue') }].concat(targetItems),
      (overrides.translator && overrides.translator.target_lang) || USE_SERVER);

    const keepItems = languageItems(serverOptions && serverOptions.keep_lang, languages.keepLangs);
    setOptions($('keepLang'), [{ value: USE_SERVER, label: t('optServerValue') }].concat(keepItems),
      (overrides.translator && overrides.translator.keep_lang) || USE_SERVER);

    const mapping = [
      ['translator', 'translator'],
      ['ocr', 'ocr'],
      ['secondaryOcr', 'secondary_ocr'],
      ['detector', 'detector'],
      ['inpainter', 'inpainter'],
      ['renderer', 'renderer']
    ];
    for (const [elementId, optionKey] of mapping) {
      const current = overrides[optionKeyToSection(optionKey)] && overrides[optionKeyToSection(optionKey)][optionKey];
      setOptions($(elementId), featureItems(optionKey), current || USE_SERVER);
    }
  }

  function optionKeyToSection(key) {
    return {
      translator: 'translator',
      ocr: 'ocr',
      secondary_ocr: 'ocr',
      detector: 'detector',
      inpainter: 'inpainter',
      renderer: 'render'
    }[key];
  }

  // ---------------------------------------------------------------------------
  // 表单 <-> 设置
  // ---------------------------------------------------------------------------

  function fillForm() {
    $('suwayomiBase').value = settings.suwayomiBase || '';
    $('mtBase').value = settings.mtBase || '';
    $('username').value = settings.username || '';
    $('password').value = settings.password || '';
    $('configMode').value = settings.configMode || 'server';
    $('concurrency').value = settings.concurrency;
    $('preheatPages').value = settings.preheatPages;
    $('lookahead').value = settings.lookahead;
    $('fullChapter').checked = !!settings.fullChapter;
    rebuildDynamicSelects();
    updateModeHint();
  }

  function readOverrides() {
    const out = {};
    const put = (section, key, value) => {
      if (!value) return;
      if (!out[section]) out[section] = {};
      out[section][key] = value;
    };
    put('translator', 'target_lang', $('targetLang').value);
    put('translator', 'keep_lang', $('keepLang').value);
    put('translator', 'translator', $('translator').value);
    put('ocr', 'ocr', $('ocr').value);
    put('ocr', 'secondary_ocr', $('secondaryOcr').value);
    put('detector', 'detector', $('detector').value);
    put('inpainter', 'inpainter', $('inpainter').value);
    put('render', 'renderer', $('renderer').value);
    return out;
  }

  function readNumbers() {
    return {
      concurrency: clamp($('concurrency').value, 1, 16, 2),
      preheatPages: clamp($('preheatPages').value, 1, 200, 12),
      lookahead: clamp($('lookahead').value, 0, 50, 8)
    };
  }

  function clamp(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // ---------------------------------------------------------------------------
  // 预设
  // ---------------------------------------------------------------------------

  async function loadPresetFile(id) {
    if (presetCache[id]) return presetCache[id];
    const url = chrome.runtime.getURL(PRESET_FILES[id]);
    const res = await fetch(url);
    const json = await res.json();
    presetCache[id] = json;
    return json;
  }

  /** 当前应该用的 presetJson：自定义优先，其次内置预设 */
  async function resolvePresetJson() {
    const profile = settings.profile || {};
    if (profile.presetId === 'custom' && profile.presetJson) return profile.presetJson;
    const id = PRESET_FILES[profile.presetId] ? profile.presetId : 'standard';
    return JSON.stringify(await loadPresetFile(id));
  }

  // ---------------------------------------------------------------------------
  // 授权与内容脚本注册
  // ---------------------------------------------------------------------------

  function computeOrigins() {
    const origins = [];
    for (const base of [$('suwayomiBase').value, $('mtBase').value]) {
      const pattern = M.originPattern(base);
      if (pattern && origins.indexOf(pattern) < 0) origins.push(pattern);
    }
    return origins;
  }

  async function registerContentScript(matchPattern) {
    if (!matchPattern) return false;
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      await chrome.scripting.registerContentScripts([{
        id: SCRIPT_ID,
        matches: [matchPattern],
        js: CONTENT_SCRIPTS.slice(),
        runAt: 'document_idle',
        persistAcrossSessions: true
      }]);
      return true;
    } catch (e) {
      console.error('[MangaTrans] 注册内容脚本失败', e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // 连接测试
  // ---------------------------------------------------------------------------

  function renderTests(rows) {
    const list = $('testResults');
    list.textContent = '';
    for (const row of rows) {
      const li = document.createElement('li');
      const mark = row.ok === true ? '✔' : row.ok === false ? '✘' : '·';
      const cls = row.ok === true ? 'ok' : row.ok === false ? 'bad' : 'warn';
      li.innerHTML = `<span class="${cls}">${mark} ${escapeHtml(row.label)}</span>` +
        (row.detail ? ` — ${escapeHtml(row.detail)}` : '');
      list.appendChild(li);
    }
  }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setTestBusy(busy) {
    const button = $('testBtn');
    button.disabled = busy;
    button.textContent = busy ? t('btnTesting') : t('btnTest');
  }

  /**
   * 逐项跑连接测试，并把结果实时画到列表里。
   * 注意：任何一步都不能让异常逃出去 —— 否则按钮点了像没反应。
   */
  async function testConnection(prefix) {
    const suwayomiBase = M.normalizeBase($('suwayomiBase').value);
    const mtBase = M.normalizeBase($('mtBase').value);
    const username = $('username').value.trim();
    const password = $('password').value;

    // 先铺占位行，点下去立刻有反应
    const rows = [
      { ok: null, label: t('testSuwayomi'), detail: t('btnTesting') },
      { ok: null, label: t('testMt'), detail: t('btnTesting') },
      { ok: null, label: t('testLogin'), detail: t('btnTesting') },
      { ok: null, label: t('testOptions'), detail: t('btnTesting') }
    ];
    setTestBusy(true);
    renderTests(rows);
    $('saveStatus').className = 'status';
    $('saveStatus').textContent = t('btnTesting');

    const summary = (text, ok) => {
      $('saveStatus').className = 'status ' + (ok ? 'ok' : 'bad');
      $('saveStatus').textContent = (prefix ? prefix + ' · ' : '') + text;
    };

    try {
      // 1. Suwayomi
      if (!suwayomiBase) {
        rows[0] = { ok: false, label: t('testSuwayomi'), detail: t('testEmpty', { field: t('optSuwayomiBase') }) };
      } else {
        try {
          const res = await fetch(suwayomiBase + '/api/v1/settings/about');
          if (!res.ok) {
            rows[0] = { ok: false, label: t('testSuwayomi'), detail: 'HTTP ' + res.status };
          } else {
            const about = await res.json();
            rows[0] = { ok: true, label: t('testSuwayomi'), detail: `${about.name || ''} ${about.version || ''}`.trim() };
          }
        } catch (e) {
          rows[0] = { ok: false, label: t('testSuwayomi'), detail: t('testUnauthorized') };
        }
      }
      renderTests(rows);

      // 2. 翻译服务可达性
      if (!mtBase) {
        rows[1] = { ok: false, label: t('testMt'), detail: t('testEmpty', { field: t('optMtBase') }) };
      } else {
        try {
          const status = await M.mt.probe(mtBase);
          rows[1] = { ok: true, label: t('testMt'), detail: status.need_setup ? t('testNeedSetup') : 'ok' };
        } catch (e) {
          rows[1] = { ok: false, label: t('testMt'), detail: e.message };
        }
      }
      renderTests(rows);

      // 3. 登录
      client = null;
      if (!mtBase) {
        rows[2] = { ok: false, label: t('testLogin'), detail: t('testSkipped', { reason: t('testEmpty', { field: t('optMtBase') }) }) };
      } else {
        try {
          client = M.mt.createClient({ base: mtBase, username, password });
          await client.ensureToken(true);
          rows[2] = { ok: true, label: t('testLogin'), detail: username };
        } catch (e) {
          client = null;
          rows[2] = { ok: false, label: t('testLogin'), detail: e.message };
        }
      }
      renderTests(rows);

      // 4. 配置选项
      if (!client) {
        rows[3] = { ok: false, label: t('testOptions'), detail: t('testSkipped', { reason: t('testNoLogin') }) };
      } else {
        try {
          serverOptions = await client.getOptions();
          rows[3] = {
            ok: true,
            label: t('testOptions'),
            detail: `${serverOptions.target_lang.length} target / ${serverOptions.keep_lang.length} keep`
          };
        } catch (e) {
          rows[3] = { ok: false, label: t('testOptions'), detail: e.message };
        }
      }
      renderTests(rows);
      rebuildDynamicSelects();

      if (client) {
        await syncFromServer(true);
        await loadJsonIntoEditor();
      }
    } catch (e) {
      // 兜底：任何没预料到的异常都要看得见
      const message = String(e && e.message ? e.message : e);
      rows.push({ ok: false, label: t('testFail'), detail: message });
      renderTests(rows);
      summary(t('testFail') + '：' + message, false);
      setTestBusy(false);
      return false;
    }

    setTestBusy(false);
    const failed = rows.filter((r) => r.ok === false);
    if (failed.length === 0) {
      summary(t('testOk'), true);
      return true;
    }
    summary(failed.map((r) => `${r.label}: ${r.detail}`).join(' · '), false);
    return false;
  }


  // ---------------------------------------------------------------------------
  // 与服务端同步配置
  // ---------------------------------------------------------------------------

  async function syncFromServer(silent) {
    if (!client) return;
    const status = $('configStatus');
    try {
      const [live, options] = await Promise.all([client.getConfig(), client.getOptions()]);
      serverOptions = options;

      const preset = JSON.parse(await resolvePresetJson());
      const built = M.buildCustomConfig({ preset, live, overrides: readOverrides(), options });

      rebuildDynamicSelects();

      const rows = [{ ok: true, label: t('testOk'), detail: `target_lang=${built.config.translator.target_lang}` }];
      if (built.rejected.length) {
        rows.push({
          ok: null,
          label: t('warnGroupConfig', { list: built.rejected.map((r) => r.path).join(', ') }),
          detail: built.rejected.map((r) => `${r.from}→${r.to}`).join(', ')
        });
      }
      status.className = 'status ok';
      status.textContent = t('testOk') + ` · target_lang=${built.config.translator.target_lang}`;
      if (!silent) renderTests(rows);
    } catch (e) {
      status.className = 'status bad';
      status.textContent = e.message;
    }
  }

  // ---------------------------------------------------------------------------
  // 缓存
  // ---------------------------------------------------------------------------

  async function findSuwayomiTab() {
    const pattern = M.originPattern($('suwayomiBase').value);
    if (!pattern) return null;
    const prefix = pattern.replace(/\*$/, '');
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url && tab.url.startsWith(prefix)) || null;
  }

  async function askTab(type, payload) {
    const tab = await findSuwayomiTab();
    if (!tab || tab.id === undefined) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, Object.assign({ type }, payload));
    } catch (e) {
      return null;
    }
  }

  async function refreshCacheCount() {
    const info = $('cacheInfo');
    const reply = await askTab('mangatrans:cacheInfo');
    if (!reply) {
      info.className = 'status warn';
      info.textContent = '打开任意 Suwayomi 页面后可查看缓存';
      return;
    }
    info.className = 'status';
    info.textContent = t('optCacheCount', { n: reply.count });
  }

  // ---------------------------------------------------------------------------
  // JSON 编辑器
  // ---------------------------------------------------------------------------

  async function loadJsonIntoEditor(force) {
    const status = $('jsonStatus');
    const current = $('jsonEditor').value;
    // 自动载入时不要冲掉用户正在编辑的内容
    if (!force && jsonEditorClean !== null && current !== jsonEditorClean) {
      return;
    }
    try {
      const json = await resolvePresetJson();
      $('jsonEditor').value = JSON.stringify(JSON.parse(json), null, 2);
      jsonEditorClean = $('jsonEditor').value;
      status.className = 'status ok';
      status.textContent = t('btnDone');
    } catch (e) {
      status.className = 'status bad';
      status.textContent = e.message;
    }
  }

  function applyEditorJson() {
    const status = $('jsonStatus');
    try {
      const parsed = JSON.parse($('jsonEditor').value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('根节点必须是对象');
      settings.profile = settings.profile || {};
      settings.profile.presetId = 'custom';
      settings.profile.presetJson = JSON.stringify(parsed);
      $('preset').value = 'custom';
      status.className = 'status ok';
      status.textContent = t('btnSaved');
    } catch (e) {
      status.className = 'status bad';
      status.textContent = e.message;
    }
  }

  function exportJson() {
    const text = $('jsonEditor').value || '{}';
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mangatrans-config.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function importJson(file) {
    const status = $('jsonStatus');
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      settings.profile = settings.profile || {};
      settings.profile.presetId = 'custom';
      settings.profile.presetJson = JSON.stringify(parsed);
      $('jsonEditor').value = JSON.stringify(parsed, null, 2);
      $('preset').value = 'custom';
      status.className = 'status ok';
      status.textContent = t('btnSaved') + ' — ' + file.name;
    } catch (e) {
      status.className = 'status bad';
      status.textContent = e.message;
    }
  }

  // ---------------------------------------------------------------------------
  // 事件绑定
  // ---------------------------------------------------------------------------

  async function onSaveClick() {
    const status = $('saveStatus');
    const origins = computeOrigins();

    if (origins.length === 0) {
      status.className = 'status bad';
      status.textContent = t('testEmpty', { field: t('optSuwayomiBase') + ' / ' + t('optMtBase') });
      return;
    }

    // 必须在用户手势里同步发起
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins });
    } catch (e) {
      granted = false;
    }
    if (!granted) {
      status.className = 'status bad';
      status.textContent = t('optPermissionDenied');
      return;
    }

    const numbers = readNumbers();
    const previousPresetId = (settings.profile && settings.profile.presetId) || 'standard';
    const presetId = $('preset').value || previousPresetId;

    let presetJson = (settings.profile && settings.profile.presetJson) || null;
    if (PRESET_FILES[presetId]) {
      presetJson = JSON.stringify(await loadPresetFile(presetId));
    } else if (presetId === 'custom' && !presetJson) {
      presetJson = JSON.stringify(await loadPresetFile('standard'));
    }

    await M.saveSettings({
      suwayomiBase: M.normalizeBase($('suwayomiBase').value),
      mtBase: M.normalizeBase($('mtBase').value),
      username: $('username').value.trim(),
      password: $('password').value,
      configMode: $('configMode').value,
      concurrency: numbers.concurrency,
      preheatPages: numbers.preheatPages,
      lookahead: numbers.lookahead,
      fullChapter: $('fullChapter').checked,
      profile: { presetId, presetJson, overrides: readOverrides() }
    });

    settings = await M.getSettings();
    const registered = await registerContentScript(M.originPattern(settings.suwayomiBase));
    $('reloadTabsBtn').classList.toggle('hidden', !registered);

    if (!registered) {
      $('saveStatus').className = 'status bad';
      $('saveStatus').textContent = t('optPermissionDenied');
    }

    await testConnection(registered ? t('btnSaved') : t('optPermissionDenied'));
    await refreshCacheCount();
  }

  function bind() {
    $('saveBtn').addEventListener('click', () => { onSaveClick().catch((e) => console.error(e)); });
    $('testBtn').addEventListener('click', () => { testConnection().catch((e) => console.error(e)); });
    $('reloadTabsBtn').addEventListener('click', async () => {
      const pattern = M.originPattern($('suwayomiBase').value);
      if (!pattern) return;
      const prefix = pattern.replace(/\*$/, '');
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id !== undefined && tab.url && tab.url.startsWith(prefix)) chrome.tabs.reload(tab.id);
      }
    });
    $('configMode').addEventListener('change', updateModeHint);
    $('syncBtn').addEventListener('click', () => { syncFromServer(false).catch((e) => console.error(e)); });
    $('loadJsonBtn').addEventListener('click', () => { loadJsonIntoEditor(true).catch((e) => console.error(e)); });
    $('applyJsonBtn').addEventListener('click', applyEditorJson);
    $('exportJsonBtn').addEventListener('click', exportJson);
    $('importJsonBtn').addEventListener('click', () => $('importJsonFile').click());
    $('importJsonFile').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) importJson(file).catch((e) => console.error(e));
    });
    $('clearCacheBtn').addEventListener('click', async () => {
      const status = $('cacheStatus');
      const reply = await askTab('mangatrans:clearCache');
      if (!reply) {
        status.className = 'status warn';
        status.textContent = '打开任意 Suwayomi 页面后可清空缓存';
        return;
      }
      status.className = 'status ok';
      status.textContent = t('btnDone');
      await refreshCacheCount();
    });
  }

  // ---------------------------------------------------------------------------

  (async function init() {
    // 依赖缺失要当场说清楚，否则整个设置页会静默半死
    for (const dep of ['i18n', 'mt']) {
      if (!M[dep]) {
        document.body.insertAdjacentHTML('afterbegin',
          `<p style="color:#c0392b;font-weight:600">缺少依赖 MTX.${dep}：请检查 options.html 的 script 引入顺序</p>`);
        return;
      }
    }

    settings = await M.getSettings();
    M.i18n.setLang(settings.uiLang);
    languages = await (await fetch(chrome.runtime.getURL('presets/languages.json'))).json();

    applyStaticText();
    fillForm();
    bind();
    updateModeHint();

    client = M.mt.createClient({
      base: settings.mtBase,
      username: settings.username,
      password: settings.password
    });

    const granted = await chrome.permissions.contains({
      origins: computeOrigins()
    }).catch(() => false);
    if (granted) {
      await testConnection();
      await loadJsonIntoEditor();
      await refreshCacheCount();
    } else {
      $('configStatus').className = 'status warn';
      $('configStatus').textContent = t('optPermissionHint');
    }
  })().catch((e) => console.error('[MangaTrans] 设置页初始化失败', e));
})();
