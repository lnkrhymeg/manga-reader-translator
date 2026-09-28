/*
 * engine.js — 阅读器引擎
 *
 * 设计要点：Suwayomi 阅读器只保留约 6 个 <img>（一话可能有 197 页），
 * 所以调度必须以「页号」为准，而不是以 DOM 里有什么为准。
 *   · 当前页 P 由 IntersectionObserver 从可见图中反解
 *   · 其余页用真实样本 URL 改写章节号/页号得到
 *   · 按 planTasks() 的优先级排队，并发跑翻译，结果写 IndexedDB
 *   · <img> 一旦出现就先查缓存，命中就立刻换图 —— 这就是「无感」的来源
 *
 * 依赖：MTX（shared.js / i18n.js / cache.js / mt-api.js）
 */
(function (root) {
  'use strict';

  const M = root.MTX;
  const CACHE = M.cache;
  const TICK_MS = 700;
  /** 同一页因并发饱和被放回队列的最大次数，超过就标记失败，避免无限循环 */
  const MAX_SATURATION_RETRIES = 8;

  function log() {
    const args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ['[MangaTrans]'].concat(args));
  }

  // ---------------------------------------------------------------------------
  // Suwayomi 只读接口
  // ---------------------------------------------------------------------------

  async function fetchJson(url, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || 15000) : null;
    try {
      const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
      if (res.status === 404) return { notFound: true };
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 取章节信息；页面列表还没被服务端抓取时 pageCount 会是 -1 */
  async function getChapter(base, mangaId, chapterIndex) {
    return fetchJson(base + '/api/v1/manga/' + mangaId + '/chapter/' + chapterIndex, 20000);
  }

  async function getChapterList(base, mangaId) {
    const list = await fetchJson(base + '/api/v1/manga/' + mangaId + '/chapters', 20000);
    return Array.isArray(list) ? list : [];
  }

  /** 下一话 = 章节列表里 index 大于当前值的最小者 */
  function pickNextChapter(list, currentIndex) {
    const indexes = list
      .map((c) => Number(c && c.index))
      .filter((n) => Number.isFinite(n) && n > currentIndex)
      .sort((a, b) => a - b);
    return indexes.length ? indexes[0] : null;
  }

  // ---------------------------------------------------------------------------
  // 引擎
  // ---------------------------------------------------------------------------

  function createEngine(options) {
    const settings = options.settings;
    const panel = options.panel;
    let client = options.client;

    const state = {
      running: false,
      fatal: null,
      session: null,
      configJson: '{}',
      configRejected: [],
      currentPage: 0,
      tasks: new Map(),
      inflight: new Map(),
      done: new Set(),
      skipped: new Set(),
      failed: new Map(),
      saturationRetries: new Map(),
      objectUrls: new Map(),
      throttle: M.createThrottle(M.toPosInt(settings.concurrency, 2)),
      lastError: null,
      stats: { chapterDone: 0, chapterTotal: 0, nextDone: 0, nextTotal: 0, queued: 0, failed: 0, skipped: 0, limit: 0, cooldownMs: 0 },
      resolving: null
    };

    const ratios = new Map();
    let observer = null;
    let mutationObserver = null;
    let tickTimer = null;
    let intervalTimer = null;
    let pumpTimer = null;
    let scanScheduled = false;

    // --- 会话 -------------------------------------------------------------

    function route() {
      return M.parseReaderPath(location.pathname, settings.readerUrlPattern);
    }

    /** 找一个真实的页面图 URL 当模板；优先取本话的 */
    function findSample() {
      const current = route();
      let fallback = null;
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        const raw = img.getAttribute('src');
        if (!raw || raw.startsWith('blob:')) continue;
        const parsed = M.parsePageUrl(raw, settings.pageUrlPattern);
        if (!parsed) continue;
        if (current && parsed.mangaId === current.mangaId && parsed.chapterIndex === current.chapterIndex) {
          return raw;
        }
        if (!fallback) fallback = raw;
      }
      return fallback;
    }

    function sessionMatches(current) {
      return !!state.session &&
        state.session.mangaId === current.mangaId &&
        state.session.chapterIndex === current.chapterIndex;
    }

    function resolveSession() {
      if (state.resolving) return state.resolving;
      const current = route();
      if (!current) return Promise.resolve(false);
      if (sessionMatches(current)) return Promise.resolve(true);

      const sample = findSample();
      if (!sample) return Promise.resolve(false); // 等第一张图出现

      const buildUrl = M.makePageUrlBuilder(sample, settings.pageUrlPattern);
      if (!buildUrl) return Promise.resolve(false);

      const base = M.normalizeBase(settings.suwayomiBase);
      state.resolving = (async () => {
        const chapter = await getChapter(base, current.mangaId, current.chapterIndex);
        const list = await getChapterList(base, current.mangaId);
        const nextChapterIndex = pickNextChapter(list, current.chapterIndex);

        // pageCount 为 -1 表示 Suwayomi 还没抓这一话的页列表。
        // GET 章节接口本身会触发抓取，所以先问一次；还是拿不到就放弃预热下一话，
        // 否则会白白打出一堆 404（每页还要重试 3 次）。
        let nextChapterPageCount = -1;
        if (nextChapterIndex !== null) {
          const info = list.find((c) => Number(c && c.index) === nextChapterIndex);
          nextChapterPageCount = info ? Number(info.pageCount) : -1;
          if (!(nextChapterPageCount > 0)) {
            const detail = await getChapter(base, current.mangaId, nextChapterIndex);
            nextChapterPageCount = detail ? Number(detail.pageCount) : -1;
          }
          if (!(nextChapterPageCount > 0)) {
            log('下一话', nextChapterIndex, '页列表尚未就绪，暂不预热');
          }
        }

        state.session = {
          mangaId: current.mangaId,
          chapterIndex: current.chapterIndex,
          pageCount: chapter && Number.isFinite(Number(chapter.pageCount)) ? Number(chapter.pageCount) : -1,
          nextChapterIndex,
          nextChapterPageCount,
          buildUrl
        };
        state.currentPage = 0;
        log('会话：manga', current.mangaId, 'chapter', current.chapterIndex,
          '共', state.session.pageCount, '页；下一话', nextChapterIndex,
          nextChapterPageCount > 0 ? '(' + nextChapterPageCount + ' 页)' : '');
        return true;
      })().finally(() => { state.resolving = null; });

      return state.resolving;
    }

    // --- 配置 -------------------------------------------------------------

    async function resolveConfig() {
      if (settings.configMode !== 'custom') {
        state.configJson = '{}';
        state.configRejected = [];
        return;
      }
      let preset = null;
      const presetJson = settings.profile && settings.profile.presetJson;
      if (presetJson) {
        try {
          preset = JSON.parse(presetJson);
        } catch (e) {
          preset = null;
        }
      }
      if (!preset) {
        state.configJson = '{}';
        log('自定义模式缺少预设，退回服务端配置');
        return;
      }
      try {
        const [live, options] = await Promise.all([client.getConfig(), client.getOptions()]);
        const built = M.buildCustomConfig({
          preset,
          live,
          overrides: (settings.profile && settings.profile.overrides) || {},
          options
        });
        state.configJson = built.json;
        state.configRejected = built.rejected;
        if (built.rejected.length) {
          log('配置校验修正了不被服务端接受的值：',
            built.rejected.map((r) => r.path + ' ' + r.from + ' -> ' + r.to).join(', '));
        }
      } catch (e) {
        state.configJson = '{}';
        log('读取服务端配置失败，退回 config="{}"', e.message);
      }
    }

    // --- DOM --------------------------------------------------------------

    function pageOfImage(img) {
      const raw = img.dataset ? img.dataset.mtxSrc : null;
      if (!raw) return null;
      const parsed = M.parsePageUrl(raw, settings.pageUrlPattern);
      if (!parsed || !state.session) return null;
      if (parsed.chapterIndex !== state.session.chapterIndex) return null;
      return parsed.pageIndex;
    }

    function swapIn(img, objectUrl) {
      if (img.getAttribute('src') === objectUrl) return;
      img.style.transition = 'opacity 150ms ease';
      img.style.opacity = '0';
      const reveal = () => { img.style.opacity = '1'; };
      img.addEventListener('load', reveal, { once: true });
      img.src = objectUrl;
      // 兜底：图片可能已在缓存里、load 不再触发
      setTimeout(reveal, 400);
    }

    function registerImage(img) {
      const raw = img.getAttribute('src');
      if (!raw || raw.startsWith('blob:')) return false;
      const parsed = M.parsePageUrl(raw, settings.pageUrlPattern);
      if (!parsed) return false;

      img.dataset.mtxSrc = raw;
      if (observer) observer.observe(img);
      // 只在运行中换图，否则关闭开关后重新扫描会把译文又贴回去
      if (state.running) {
        const objectUrl = state.objectUrls.get(raw);
        if (objectUrl) swapIn(img, objectUrl);
      }
      return true;
    }

    function scanDom() {
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) registerImage(img);
      scheduleTick(0);
    }

    function scheduleScan() {
      if (scanScheduled) return;
      scanScheduled = true;
      requestAnimationFrame(() => {
        scanScheduled = false;
        scanDom();
      });
    }

    function applyUrl(pageUrl) {
      const objectUrl = state.objectUrls.get(pageUrl);
      if (!objectUrl) return;
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        if (img.dataset && img.dataset.mtxSrc === pageUrl) swapIn(img, objectUrl);
      }
    }

    function restoreAll() {
      const imgs = document.querySelectorAll('img[data-mtx-src]');
      for (const img of imgs) {
        const original = img.dataset.mtxSrc;
        if (original && img.getAttribute('src') !== original) img.setAttribute('src', original);
        img.style.transition = '';
        img.style.opacity = '';
      }
    }

    function updateCurrentPage() {
      let best = null;
      let bestRatio = 0;
      ratios.forEach((ratio, img) => {
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = img;
        }
      });
      const page = best && bestRatio > 0 ? pageOfImage(best) : null;
      if (page !== null && page !== state.currentPage) {
        state.currentPage = page;
        scheduleTick(0);
      }
    }

    // --- 调度 -------------------------------------------------------------

    function scheduleTick(delay) {
      if (tickTimer) return;
      tickTimer = setTimeout(() => {
        tickTimer = null;
        tick();
      }, delay === undefined ? 120 : delay);
    }

    function takeBestTask() {
      let bestKey = null;
      let best = null;
      state.tasks.forEach((task, key) => {
        if (!best ||
            task.priority < best.priority ||
            (task.priority === best.priority && task.pageIndex < best.pageIndex)) {
          best = task;
          bestKey = key;
        }
      });
      if (bestKey !== null) state.tasks.delete(bestKey);
      return best ? Object.assign({ key: bestKey }, best) : null;
    }

    function configuredConcurrency() {
      return Math.max(1, M.toPosInt(settings.concurrency, 2));
    }

    function updateStats() {
      const s = state.session;
      state.stats.queued = state.tasks.size + state.inflight.size;
      state.stats.failed = state.failed.size;
      state.stats.skipped = state.skipped.size;
      state.stats.limit = Math.min(configuredConcurrency(), state.throttle.limit);
      state.stats.cooldownMs = M.throttleWait(state.throttle, Date.now());
      state.stats.lastError = state.lastError;
      if (!s) return;

      let chapterDone = 0;
      let nextDone = 0;
      state.done.forEach((key) => {
        const parts = key.split(':');
        const chapter = Number(parts[0]);
        if (chapter === s.chapterIndex) chapterDone++;
        else if (chapter === s.nextChapterIndex) nextDone++;
      });
      state.stats.chapterDone = chapterDone;
      state.stats.chapterTotal = s.pageCount > 0 ? s.pageCount : 0;
      state.stats.nextDone = nextDone;
      state.stats.nextTotal = s.nextChapterPageCount > 0 ? s.nextChapterPageCount : 0;
      if (panel) panel.update(state);
    }

    function handleFailure(task, error) {
      const code = error && error.code ? error.code : 'unknown';

      // 整页没有文字（服务端 no_result / transform 失败）不是故障：
      // 原图本来就是对的，直接标记跳过，不重试也不报错。
      if (code === 'skip') {
        state.skipped.add(task.key);
        state.failed.delete(task.key);
        log('跳过', task.key, error.message);
        return;
      }

      if (code === 'auth' || code === 'permission' || code === 'bad-config') {
        state.fatal = { code, message: error.message };
        state.running = false;
        log('致命错误，已停止：', code, error.message);
        if (panel) panel.showError(code);
        updateStats();
        return;
      }

      // 并发饱和不是这一页的问题，而是服务端被喂太多：
      // 不当作失败，改为整体降速 + 冷却，让请求往后排。
      if (code === 'stream-aborted' || code === 'busy') {
        const retries = (state.saturationRetries.get(task.key) || 0) + 1;
        state.throttle = M.throttleOnSaturated(state.throttle, configuredConcurrency(), Date.now());
        state.lastError = { code, task: task.key, at: Date.now() };

        if (retries > MAX_SATURATION_RETRIES) {
          // 服务端持续饱和（或一直中途断流），别无限循环
          state.saturationRetries.delete(task.key);
          state.failed.set(task.key, { attempts: retries, code, nextAt: Infinity });
          log('并发持续饱和，放弃', task.key);
        } else {
          state.saturationRetries.set(task.key, retries);
          state.tasks.set(task.key, task); // 放回队列，等冷却结束再试
          log('服务端并发已满，降到', state.throttle.limit, '并发并冷却',
            Math.round((state.throttle.cooldownUntil - Date.now()) / 1000) + 's');
        }
        updateStats();
        return;
      }

      const previous = state.failed.get(task.key);
      const attempts = (previous ? previous.attempts : 0) + 1;
      const backoff = attempts === 1 ? 2000 : attempts === 2 ? 8000 : 20000;
      state.failed.set(task.key, { attempts, code, nextAt: Date.now() + backoff });
      state.lastError = { code, task: task.key, at: Date.now() };
      log('失败', task.key, code, error.message, '第 ' + attempts + ' 次');
    }

    async function runTask(task) {
      const session = state.session;
      if (!session) {
        state.inflight.delete(task.key);
        return;
      }
      const url = session.buildUrl(task.chapterIndex, task.pageIndex);
      try {
        if (!url) throw new M.mt.MTError('page', 'cannot build page url');

        let blob = await CACHE.get(url);
        if (!blob) {
          const res = await fetch(url);
          if (!res.ok) throw new M.mt.MTError('page', 'page HTTP ' + res.status, res.status);
          const original = await res.blob();
          blob = await client.translate(original, 'page-' + task.pageIndex + '.png', state.configJson);
          await CACHE.put(url, blob);
        }

        const objectUrl = URL.createObjectURL(blob);
        const old = state.objectUrls.get(url);
        if (old) URL.revokeObjectURL(old);
        state.objectUrls.set(url, objectUrl);
        state.done.add(task.key);
        state.failed.delete(task.key);
        state.saturationRetries.delete(task.key);
        state.throttle = M.throttleOnSuccess(state.throttle, configuredConcurrency());
        applyUrl(url);
      } catch (error) {
        handleFailure(task, error);
      } finally {
        state.inflight.delete(task.key);
        updateStats();
        if (state.running) pump();
      }
    }

    function pump() {
      if (!state.running || state.fatal) return;

      const wait = M.throttleWait(state.throttle, Date.now());
      if (wait > 0) {
        // 冷却期间不再发请求；起来后自然会把放回队列的页重新捡起来
        if (!pumpTimer) {
          pumpTimer = setTimeout(() => {
            pumpTimer = null;
            updateStats();
            pump();
          }, wait);
        }
        return;
      }

      const limit = Math.min(configuredConcurrency(), state.throttle.limit);
      while (state.inflight.size < limit) {
        const task = takeBestTask();
        if (!task) break;
        state.inflight.set(task.key, true);
        runTask(task);
      }
    }

    async function tick() {
      if (!state.running) return;
      if (!route()) return;

      const ready = await resolveSession();
      if (!ready || !state.session) return;

      // 丢掉既不属于本章也不属于下一话的遗留任务（切话后可能残留）
      state.tasks.forEach((task, key) => {
        if (task.chapterIndex !== state.session.chapterIndex &&
            task.chapterIndex !== state.session.nextChapterIndex) {
          state.tasks.delete(key);
        }
      });

      const planned = M.planTasks({
        chapterIndex: state.session.chapterIndex,
        pageCount: state.session.pageCount,
        nextChapterIndex: state.session.nextChapterIndex,
        nextChapterPageCount: state.session.nextChapterPageCount,
        currentPage: state.currentPage
      }, settings);

      const now = Date.now();
      for (const task of planned) {
        const key = M.taskKey(task.chapterIndex, task.pageIndex);
        if (state.done.has(key) || state.skipped.has(key) || state.inflight.has(key)) continue;
        const failure = state.failed.get(key);
        if (failure && (failure.attempts >= M.MAX_ATTEMPTS || failure.nextAt > now)) continue;
        const queued = state.tasks.get(key);
        if (!queued || task.priority < queued.priority) state.tasks.set(key, task);
      }

      updateStats();
      pump();
    }

    // --- 生命周期 ---------------------------------------------------------

    function attachObservers() {
      if (!observer) {
        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            ratios.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
          }
          updateCurrentPage();
        }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
      }
      if (!mutationObserver) {
        mutationObserver = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type !== 'attributes') continue;
            const target = record.target;
            const value = target && target.getAttribute ? target.getAttribute('src') : null;
            // 我们自己换上去的 blob: URL 要保持追踪；站点换了新图才重置
            if (target && target.dataset && (!value || !value.startsWith('blob:'))) {
              delete target.dataset.mtxSrc;
            }
          }
          scheduleScan();
        });
        mutationObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src']
        });
      }
    }

    async function start() {
      if (state.running) return;
      state.fatal = null;
      state.lastError = null;
      state.running = true;
      state.throttle = M.createThrottle(configuredConcurrency());
      ratios.clear();
      attachObservers();

      try {
        await client.ensureToken(false);
      } catch (error) {
        state.running = false;
        state.fatal = { code: error.code || 'auth', message: error.message };
        if (panel) panel.showError(state.fatal.code);
        return;
      }

      await resolveConfig();
      await resolveSession();
      scanDom();

      if (intervalTimer) clearInterval(intervalTimer);
      intervalTimer = setInterval(() => {
        if (state.running) tick();
      }, TICK_MS);

      updateStats();
      tick();
      log('已开始');
    }

    function stop() {
      state.running = false;
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
      if (tickTimer) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }
      if (pumpTimer) {
        clearTimeout(pumpTimer);
        pumpTimer = null;
      }
      restoreAll();
      updateStats();
      log('已暂停');
    }

    /** 清掉本话缓存并重排（缓存删除是异步的，先清内存态） */
    async function retranslateChapter() {
      if (!state.session) return;
      const chapterIndex = state.session.chapterIndex;

      state.done.forEach((key) => {
        if (Number(key.split(':')[0]) === chapterIndex) state.done.delete(key);
      });
      state.skipped.forEach((key) => {
        if (Number(key.split(':')[0]) === chapterIndex) state.skipped.delete(key);
      });
      state.failed.clear();
      state.saturationRetries.clear();
      state.tasks.clear();
      state.objectUrls.forEach((objectUrl, url) => {
        const parsed = M.parsePageUrl(url, settings.pageUrlPattern);
        if (parsed && parsed.chapterIndex === chapterIndex) {
          URL.revokeObjectURL(objectUrl);
          state.objectUrls.delete(url);
        }
      });
      restoreAll();
      await CACHE.removeChapter(settings.pageUrlPattern, chapterIndex);
      log('已清空第', chapterIndex, '话缓存');

      if (!state.running) await start();
      else tick();
    }

    /** 设置变了：更新引用并按需重启 */
    function applySettings(next) {
      Object.assign(settings, next);
      const configured = configuredConcurrency();
      if (state.throttle.limit > configured) state.throttle.limit = configured;
      if (next.enabled && !state.running) start();
      else if (!next.enabled && state.running) stop();
      else if (state.running) resolveConfig().then(() => tick());
    }

    function destroy() {
      stop();
      if (observer) observer.disconnect();
      if (mutationObserver) mutationObserver.disconnect();
      state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
      state.objectUrls.clear();
    }

    return {
      state,
      start,
      stop,
      applySettings,
      destroy,
      retranslateChapter,
      setClient: (next) => { client = next; },
      refresh: () => { scheduleTick(0); },
      isRunning: () => state.running
    };
  }

  // ---------------------------------------------------------------------------
  // 悬浮面板（Shadow DOM，避免和站点样式打架）
  // ---------------------------------------------------------------------------

  function createPanel(handlers) {
    const t = (key, vars) => root.MTX.i18n.t(key, vars);
    const host = document.createElement('div');
    host.id = 'mangatrans-host';
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 14px; bottom: 14px;';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .box {
          font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
          color: #e8ecf4; background: rgba(20, 24, 34, .94);
          border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
          box-shadow: 0 6px 24px rgba(0,0,0,.4); padding: 8px 10px;
          min-width: 190px; backdrop-filter: blur(6px);
        }
        .row { display: flex; align-items: center; gap: 6px; }
        .title { font-weight: 600; color: #7cb0ff; }
        .stats { margin-top: 4px; color: #b9c2d4; white-space: nowrap; }
        .err { margin-top: 4px; color: #ff9a9a; max-width: 260px; white-space: normal; }
        .btns { margin-top: 7px; display: flex; gap: 6px; flex-wrap: wrap; }
        button {
          font: inherit; color: #e8ecf4; background: rgba(255,255,255,.09);
          border: 1px solid rgba(255,255,255,.16); border-radius: 6px;
          padding: 3px 8px; cursor: pointer;
        }
        button:hover { background: rgba(255,255,255,.18); }
        button.primary { background: #2f6fd0; border-color: #3f83e6; }
        button.primary:hover { background: #3a7fe4; }
        .mini {
          font: 12px/1 system-ui, sans-serif; color: #e8ecf4;
          background: rgba(20,24,34,.9); border: 1px solid rgba(255,255,255,.16);
          border-radius: 999px; padding: 7px 11px; cursor: pointer;
        }
        .hidden { display: none !important; }
      </style>
      <div class="box" id="box">
        <div class="row">
          <span class="title">MangaTrans</span>
          <span class="stats" id="stats"></span>
        </div>
        <div class="err hidden" id="err"></div>
        <div class="btns">
          <button class="primary" id="toggle"></button>
          <button id="retrans"></button>
          <button id="settings"></button>
          <button id="fold" title="">−</button>
        </div>
      </div>
      <button class="mini hidden" id="unfold">MangaTrans</button>
    `;

    const box = shadow.getElementById('box');
    const mini = shadow.getElementById('unfold');
    const statsEl = shadow.getElementById('stats');
    const errEl = shadow.getElementById('err');
    const toggleBtn = shadow.getElementById('toggle');
    const retransBtn = shadow.getElementById('retrans');
    const settingsBtn = shadow.getElementById('settings');
    const foldBtn = shadow.getElementById('fold');

    toggleBtn.addEventListener('click', handlers.onToggle);
    retransBtn.addEventListener('click', handlers.onRetranslate);
    settingsBtn.addEventListener('click', handlers.onOpenSettings);
    foldBtn.addEventListener('click', () => setCollapsed(true));
    mini.addEventListener('click', () => setCollapsed(false));

    function setCollapsed(collapsed) {
      box.classList.toggle('hidden', collapsed);
      mini.classList.toggle('hidden', !collapsed);
      try {
        localStorage.setItem('mangatrans.collapsed', collapsed ? '1' : '0');
      } catch (e) { /* 隐私模式下忽略 */ }
    }

    try {
      setCollapsed(localStorage.getItem('mangatrans.collapsed') === '1');
    } catch (e) { /* ignore */ }

    document.documentElement.appendChild(host);

    function update(state) {
      const s = state.stats;
      const parts = [];
      if (state.session) {
        const total = s.chapterTotal > 0 ? String(s.chapterTotal) : '?';
        parts.push(t('panelChapter', { done: s.chapterDone, total }));
      }
      if (state.session && state.session.nextChapterIndex !== null && state.session.nextChapterIndex !== undefined) {
        parts.push(t('panelNext', { done: s.nextDone, total: s.nextTotal > 0 ? s.nextTotal : '?' }));
      }
      if (s.queued > 0) parts.push(t('panelQueue', { n: s.queued }));
      if (s.skipped > 0) parts.push(t('panelSkipped', { n: s.skipped }));
      if (s.failed > 0) parts.push(t('panelFailed', { n: s.failed }));
      if (s.limit < 2 && state.running) parts.push(t('panelThrottled'));

      let label = state.fatal ? state.fatal.code : (state.running ? (s.chapterDone === 0 ? t('panelPreheating') : t('panelTranslating')) : t('panelIdle'));
      if (state.running && s.cooldownMs > 0) {
        label = t('panelCooldown', { n: Math.ceil(s.cooldownMs / 1000) });
      }
      statsEl.textContent = label + (parts.length ? ' · ' + parts.join(' · ') : '');
      toggleBtn.textContent = state.running ? t('panelPause') : t('panelStart');
      retransBtn.textContent = t('panelRetranslate');
      settingsBtn.textContent = t('panelSettings');

      // 让用户看得见失败原因，而不是只看到一个数字
      if (state.fatal) {
        errEl.textContent = errorText(state.fatal.code);
      } else if (s.failed > 0 && s.lastError) {
        errEl.textContent = errorText(s.lastError.code) + ' ×' + s.failed;
      } else {
        errEl.textContent = '';
      }
      errEl.classList.toggle('hidden', !errEl.textContent);
    }

    function errorText(code) {
      const key = {
        auth: 'errAuth',
        permission: 'errPermission',
        'bad-config': 'errBadConfig',
        'server-offline': 'errServerOffline',
        'stream-aborted': 'errStreamAborted',
        busy: 'errConcurrent',
        translate: 'errTranslate',
        page: 'errPage'
      }[code] || 'errTranslate';
      return t(key, { status: '' });
    }

    function showError(code) {
      errEl.textContent = errorText(code);
      if (code === 'server-offline') errEl.textContent += ' — ' + t('errServerOfflineHint');
      errEl.classList.remove('hidden');
    }

    function destroy() {
      if (host.parentNode) host.parentNode.removeChild(host);
    }

    return { update, showError, destroy, setCollapsed };
  }

  const ENGINE = { createEngine, createPanel, getChapter, getChapterList, pickNextChapter };

  root.MTX = Object.assign(root.MTX || {}, { engine: ENGINE });

  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
