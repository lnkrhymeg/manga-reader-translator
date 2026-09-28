/*
 * shared.js — 设置、URL 解析、配置合并、任务规划
 *
 * 纯逻辑模块：加载时不触碰 chrome.*，因此 Node 可直接 require 做单测。
 * 依赖：无。
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 默认设置
  // ---------------------------------------------------------------------------

  const SETTINGS_KEY = 'settings';

  const DEFAULT_SETTINGS = {
    // 总开关
    enabled: false,
    // 扩展界面语言：'auto' | 'zh' | 'en'
    uiLang: 'auto',

    // 服务地址（Suwayomi 在别的机器上时，改成它的 IP，例如 http://192.168.1.100:4567）
    suwayomiBase: 'http://127.0.0.1:4567',
    mtBase: 'http://127.0.0.1:8000',

    // 翻译服务账号（manga-translator-ui web 模式的登录账号，需自己填）
    username: '',
    password: '',

    // 翻译配置：'server' = 发 "{}"，完全用服务端 config/config.json；
    //           'custom' = 发 preset + 服务端配置 + overrides 三层合并后的完整 JSON。
    configMode: 'server',
    profile: {
      presetId: 'standard', // 'standard' | 'high-precision' | 'custom'
      presetJson: null,     // 完整配置的 JSON 字符串（由设置页写入，内容脚本直接复用）
      overrides: {}         // 稀疏覆盖，例如 {translator:{target_lang:'CHT'}}
    },

    // 调度
    concurrency: 2,
    preheatPages: 12,
    lookahead: 8,
    fullChapter: false,

    // 站点适配（默认值即 Suwayomi；改成正则即可适配其它阅读器）
    readerUrlPattern: '^/manga/(\\d+)/chapter/(\\d+)/?$',
    pageUrlPattern: '^https?://[^/]+/api/v1/manga/(\\d+)/chapter/(\\d+)/page/(\\d+)(?:\\?.*)?$'
  };

  /*
   * 持久缓存用 IndexedDB 而不是 Cache Storage。
   * 原因：Suwayomi 通常是 http://192.168.x.x，不是安全上下文，
   * window.caches 在这种页面上是 undefined（实测确认），而 indexedDB 可用。
   * 数据库建在 Suwayomi 页面的源下，键就是页图 URL。
   */
  const DB_NAME = 'mangatrans';
  const DB_VERSION = 1;
  const DB_STORE = 'pages';
  const CACHE_MAX_PAGES = 1500;
  const MAX_ATTEMPTS = 3;

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  function toPosInt(value, fallback, allowZero) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    if (n === 0) return allowZero ? 0 : fallback;
    return Math.floor(n);
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** 按顺序深合并：后面的层覆盖前面的层。数组与标量整体替换，null 也整体替换。 */
  function deepMerge() {
    const out = {};
    for (let i = 0; i < arguments.length; i++) {
      const layer = arguments[i];
      if (!isPlainObject(layer)) continue;
      for (const key of Object.keys(layer)) {
        const value = layer[key];
        if (value === undefined) continue;
        out[key] = isPlainObject(value) ? deepMerge(out[key], value) : value;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 自适应节流
  // ---------------------------------------------------------------------------

  /*
   * 服务端的并发上限来自「用户组」设置（实测管理员组是 3，默认用户组是 1），
   * 而不是账号里的 max_concurrent_tasks。
   *
   * 更麻烦的是它检查得太晚：check_concurrent_limit() 在流式响应的生成器里才调用，
   * 那时 HTTP 200 已经发出去了，429 没法再回给客户端，Starlette 只能
   *   RuntimeError: Caught handled exception, but response already started.
   * 直接把流掐断。客户端只看到「200 但没收到结果帧」。
   *
   * 所以扩展不能只靠重试：必须退让。命中饱和就降低并发并全局冷却，
   * 连续成功若干次后再逐步恢复。
   */
  const THROTTLE_BASE_MS = 5000;
  const THROTTLE_MAX_MS = 60000;
  const THROTTLE_RECOVER_AFTER = 3;

  function createThrottle(configured) {
    return {
      limit: Math.max(1, configured | 0),
      strikes: 0,
      successes: 0,
      cooldownUntil: 0
    };
  }

  /** 一次成功：攒够次数就试探性恢复一档并发 */
  function throttleOnSuccess(state, configured) {
    const max = Math.max(1, configured | 0);
    const successes = state.successes + 1;
    let limit = state.limit;
    let consumed = successes;

    if (successes >= THROTTLE_RECOVER_AFTER && limit < max) {
      limit = limit + 1;
      consumed = 0;
    }
    return { limit, strikes: 0, successes: consumed, cooldownUntil: state.cooldownUntil };
  }

  /** 命中并发饱和：并发减一 + 指数冷却 */
  function throttleOnSaturated(state, configured, now) {
    const max = Math.max(1, configured | 0);
    const strikes = state.strikes + 1;
    const backoff = Math.min(THROTTLE_BASE_MS * Math.pow(2, strikes - 1), THROTTLE_MAX_MS);
    return {
      limit: Math.max(1, Math.min(state.limit, max) - 1),
      strikes,
      successes: 0,
      cooldownUntil: now + backoff
    };
  }

  /** 冷却剩余毫秒数，0 表示可以继续 */
  function throttleWait(state, now) {
    return Math.max(0, state.cooldownUntil - now);
  }

  // ---------------------------------------------------------------------------
  // 配置校验
  // ---------------------------------------------------------------------------

  /*
   * 下面这些字段在服务端是 pydantic 枚举，值不在允许集合内会直接 500：
   *   pydantic_core.ValidationError: translator.translator
   *     Input should be 'openai', 'openai_hq', ... [input_value='vertex_hq']
   *
   * 实测 GET /config?mode=authenticated 会把「用户组」里的默认值注入进来，
   * 而组策略里可能残留服务端当前版本已不认识的取值（例如 vertex_hq）。
   * 所以合并后的配置必须先过一遍白名单校验，否则整个请求 500。
   *
   * 注意：target_lang / keep_lang / font_family / layout_mode /
   * ocr_vl_language_hint / high_quality_prompt_path 在服务端是自由字符串，
   * 不做校验也不能改写，否则会和 config="{}" 的产物产生漂移。
   */
  const CONSTRAINED_FIELDS = [
    ['translator', 'translator', 'translator'],
    ['ocr', 'ocr', 'ocr'],
    ['ocr', 'secondary_ocr', 'secondary_ocr'],
    ['detector', 'detector', 'detector'],
    ['inpainter', 'inpainter', 'inpainter'],
    ['inpainter', 'inpainting_precision', 'inpainting_precision'],
    ['render', 'renderer', 'renderer'],
    ['render', 'alignment', 'alignment'],
    ['render', 'direction', 'direction'],
    ['upscale', 'upscaler', 'upscaler'],
    ['colorizer', 'colorizer', 'colorizer']
  ];

  /**
   * 把配置里不被服务端接受的枚举值替换成 fallback（一般是内置预设）里的值。
   * @returns {{config: object, rejected: Array<{path:string,from:*,to:*}>}}
   */
  function sanitizeConfig(config, options, fallback) {
    const out = JSON.parse(JSON.stringify(config || {}));
    const rejected = [];
    if (!isPlainObject(out) || !isPlainObject(options)) return { config: out, rejected };

    for (const [section, key, optionsKey] of CONSTRAINED_FIELDS) {
      const allowed = options[optionsKey];
      if (!Array.isArray(allowed) || allowed.length === 0) continue;
      if (!isPlainObject(out[section])) continue;

      const current = out[section][key];
      if (current === undefined || current === null) continue;
      if (allowed.indexOf(current) >= 0) continue;

      let replacement = isPlainObject(fallback) && isPlainObject(fallback[section])
        ? fallback[section][key]
        : undefined;
      if (replacement === undefined || replacement === null || allowed.indexOf(replacement) < 0) {
        replacement = allowed[0];
      }
      out[section][key] = replacement;
      rejected.push({ path: section + '.' + key, from: current, to: replacement });
    }
    return { config: out, rejected };
  }

  /**
   * 生成「自定义配置」模式要发的完整配置字符串。
   * 三层合并：内置预设 → 服务端配置 → 用户在下拉框里的选择，然后过白名单校验。
   */
  function buildCustomConfig(layers) {
    const merged = deepMerge(layers.preset, layers.live, layers.overrides);
    const result = sanitizeConfig(merged, layers.options, layers.preset);
    return { json: JSON.stringify(result.config), config: result.config, rejected: result.rejected };
  }

  /** 去掉尾部斜杠的 base，例如 "http://127.0.0.1:8000/" -> "http://127.0.0.1:8000" */
  function normalizeBase(base) {
    return String(base || '').trim().replace(/\/+$/, '');
  }

  /** base -> 匹配模式，用于 permissions.request 与 registerContentScripts */
  function originPattern(base) {
    const normalized = normalizeBase(base);
    if (!normalized) return null;
    try {
      const url = new URL(normalized);
      return url.origin + '/*';
    } catch (e) {
      return null;
    }
  }

  function toRegExp(pattern, fallbackPattern) {
    const source = pattern || fallbackPattern;
    let flags = 'd';
    let body = source;
    // 允许用户写成 /re/flags 形式
    const wrapped = /^\/(.*)\/([a-z]*)$/.exec(source);
    if (wrapped) {
      body = wrapped[1];
      flags = wrapped[2].indexOf('d') >= 0 ? wrapped[2] : wrapped[2] + 'd';
    }
    try {
      return new RegExp(body, flags);
    } catch (e) {
      return new RegExp(fallbackPattern, 'd');
    }
  }

  // ---------------------------------------------------------------------------
  // URL 解析
  // ---------------------------------------------------------------------------

  /** 从阅读器路径解析 mangaId / chapterIndex，不匹配返回 null。 */
  function parseReaderPath(pathname, pattern) {
    const match = toRegExp(pattern, DEFAULT_SETTINGS.readerUrlPattern).exec(pathname);
    if (!match) return null;
    return { mangaId: Number(match[1]), chapterIndex: Number(match[2]) };
  }

  /** 从页面图 URL 解析 mangaId / chapterIndex / pageIndex / sourceId，不匹配返回 null。 */
  function parsePageUrl(url, pattern) {
    const match = toRegExp(pattern, DEFAULT_SETTINGS.pageUrlPattern).exec(url);
    if (!match) return null;
    const sourceMatch = /[?&]sourceId=(\d+)/.exec(url);
    return {
      mangaId: Number(match[1]),
      chapterIndex: Number(match[2]),
      pageIndex: Number(match[3]),
      sourceId: sourceMatch ? Number(sourceMatch[1]) : null
    };
  }

  /**
   * 用页面里真实出现过的一张图 URL 作为模板，生成"改章节号 / 改页号"的函数。
   * 这样不必硬编码 Suwayomi 的 URL 形状，换阅读器只改正则即可。
   */
  function makePageUrlBuilder(sampleUrl, pattern) {
    const match = toRegExp(pattern, DEFAULT_SETTINGS.pageUrlPattern).exec(sampleUrl);
    if (!match || !match.indices) return null;
    const chapterRange = match.indices[2];
    const pageRange = match.indices[3];
    if (!chapterRange || !pageRange) return null;
    return function build(chapterIndex, pageIndex) {
      return (
        sampleUrl.slice(0, chapterRange[0]) + chapterIndex +
        sampleUrl.slice(chapterRange[1], pageRange[0]) + pageIndex +
        sampleUrl.slice(pageRange[1])
      );
    };
  }

  /** 兜底：按 Suwayomi 的 URL 形状直接拼。 */
  function buildPageUrl(base, mangaId, chapterIndex, pageIndex, sourceId) {
    const source = sourceId === null || sourceId === undefined ? 0 : sourceId;
    return (
      normalizeBase(base) + '/api/v1/manga/' + mangaId +
      '/chapter/' + chapterIndex + '/page/' + pageIndex + '?sourceId=' + source
    );
  }

  function taskKey(chapterIndex, pageIndex) {
    return chapterIndex + ':' + pageIndex;
  }

  // ---------------------------------------------------------------------------
  // 任务规划
  // ---------------------------------------------------------------------------

  /**
   * 根据当前阅读位置算出"该翻哪些页"。
   *
   * 优先级（数字越小越先翻）：
   *   0 当前可见页
   *   1 当前页之后 lookahead 页（滑动窗口）
   *   2 本章开头 preheatPages 页（会话预热）
   *   3 下一话开头 preheatPages 页（跨话预热；接近本章末尾时加深）
   *   4 本章剩余页（仅 fullChapter 打开时）
   *
   * @returns {Array<{chapterIndex:number,pageIndex:number,priority:number}>} 已按优先级排序
   */
  function planTasks(state, settings) {
    const cfg = settings || {};
    const preheatPages = toPosInt(cfg.preheatPages, DEFAULT_SETTINGS.preheatPages);
    const lookahead = toPosInt(cfg.lookahead, DEFAULT_SETTINGS.lookahead, true);

    const chapterIndex = state.chapterIndex;
    if (chapterIndex === null || chapterIndex === undefined) return [];

    const nextChapterIndex = state.nextChapterIndex;
    const pageCount = toPosInt(state.pageCount, -1, true);
    const nextPageCount = toPosInt(state.nextChapterPageCount, -1, true);
    const currentPage = Math.max(0, toPosInt(state.currentPage, 0, true));

    const limits = new Map();
    limits.set(chapterIndex, pageCount);
    if (nextChapterIndex !== null && nextChapterIndex !== undefined) {
      limits.set(nextChapterIndex, nextPageCount);
    }

    const best = new Map();

    function add(chapter, page, priority) {
      if (chapter === null || chapter === undefined) return;
      if (page === null || page === undefined || page < 0) return;
      const limit = limits.get(chapter);
      if (typeof limit === 'number' && limit > 0 && page >= limit) return;
      const key = taskKey(chapter, page);
      const previous = best.get(key);
      if (previous === undefined || priority < previous) best.set(key, priority);
    }

    // 0 / 1 —— 滑动窗口
    add(chapterIndex, currentPage, 0);
    for (let i = 1; i <= lookahead; i++) add(chapterIndex, currentPage + i, 1);

    // 2 —— 本章预热
    for (let i = 0; i < preheatPages; i++) add(chapterIndex, i, 2);

    // 3 —— 下一话预热
    if (nextChapterIndex !== null && nextChapterIndex !== undefined) {
      const nearEnd = pageCount > 0 && currentPage >= pageCount - lookahead;
      const depth = preheatPages + (nearEnd ? lookahead : 0);
      for (let i = 0; i < depth; i++) add(nextChapterIndex, i, 3);
    }

    // 4 —— 本章剩余页
    if (cfg.fullChapter && pageCount > 0) {
      for (let i = 0; i < pageCount; i++) add(chapterIndex, i, 4);
    }

    const tasks = [];
    best.forEach(function (priority, key) {
      const parts = key.split(':');
      tasks.push({
        chapterIndex: Number(parts[0]),
        pageIndex: Number(parts[1]),
        priority: priority
      });
    });
    tasks.sort(function (a, b) {
      return a.priority - b.priority || a.pageIndex - b.pageIndex;
    });
    return tasks;
  }

  // ---------------------------------------------------------------------------
  // 设置读写（仅这些函数触碰 chrome.*）
  // ---------------------------------------------------------------------------

  function hasChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  async function getSettings() {
    if (!hasChromeStorage()) return Object.assign({}, DEFAULT_SETTINGS);
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return deepMerge(DEFAULT_SETTINGS, stored[SETTINGS_KEY] || {});
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const next = deepMerge(current, patch);
    if (hasChromeStorage()) {
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    }
    return next;
  }

  async function onSettingsChanged(handler) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes[SETTINGS_KEY]) {
        handler(deepMerge(DEFAULT_SETTINGS, changes[SETTINGS_KEY].newValue || {}));
      }
    });
  }

  // ---------------------------------------------------------------------------

  const MTX = {
    SETTINGS_KEY,
    DB_NAME,
    DB_VERSION,
    DB_STORE,
    CACHE_MAX_PAGES,
    MAX_ATTEMPTS,
    DEFAULT_SETTINGS,
    CONSTRAINED_FIELDS,
    THROTTLE_RECOVER_AFTER,
    createThrottle,
    throttleOnSuccess,
    throttleOnSaturated,
    throttleWait,
    deepMerge,
    sanitizeConfig,
    buildCustomConfig,
    normalizeBase,
    originPattern,
    toRegExp,
    toPosInt,
    isPlainObject,
    parseReaderPath,
    parsePageUrl,
    makePageUrlBuilder,
    buildPageUrl,
    taskKey,
    planTasks,
    getSettings,
    saveSettings,
    onSettingsChanged
  };

  root.MTX = Object.assign(root.MTX || {}, MTX);

  if (typeof module !== 'undefined' && module.exports) module.exports = MTX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
