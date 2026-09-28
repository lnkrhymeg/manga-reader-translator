/*
 * mt-api.js — manga-translator-ui web 模式客户端
 *
 * 只做四件事：登录拿 token、读服务端配置/选项、发一页图去翻译、把失败归类。
 * 并发控制与重试节奏由 engine.js 负责；这里只保证单次调用的正确性。
 *
 * 依赖：MTX（shared.js）
 */
(function (root) {
  'use strict';

  const M = root.MTX;
  const TOKEN_KEY = 'mtToken';
  const DEFAULT_TIMEOUT_MS = 300000;

  /** 归一化后的错误，便于 engine 决定「换 token 重试」还是「放弃这一页」 */
  class MTError extends Error {
    constructor(code, message, status, detail) {
      super(message);
      this.name = 'MTError';
      this.code = code;
      this.status = status || 0;
      this.detail = detail || null;
    }
  }

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  // ---------------------------------------------------------------------------
  // 流式分帧：1 字节状态 + 4 字节大端长度 + 数据
  //   0 = 最终图片，1 = 进度 JSON，2 = 错误 JSON
  //
  // 为什么不用 /translate/with-form/image（一次性返回 PNG）：
  // 该端点在「整页没有文字」时会抛 ValueError: Operation on closed image，
  // 直接 HTTP 500；而 500 是 ASGI 层异常，不带 CORS 头，浏览器只会报
  // “blocked by CORS policy”，状态码完全拿不到，只能当成未知网络错误重试。
  // 流式端点把 transform 的异常接住了，改成 200 + 状态 2 的错误帧，
  // 于是我们能区分「这页没文字，跳过」和「临时故障，该重试」。
  // ---------------------------------------------------------------------------

  function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function decodeJson(bytes) {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      return null;
    }
  }

  /**
   * 读取整条帧流。
   * @returns {{data: Uint8Array|null, error: object|null, progress: object[]}}
   */
  async function readFrames(stream, onProgress) {
    const reader = stream.getReader();
    let buffer = new Uint8Array(0);
    let data = null;
    let error = null;
    const progress = [];

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer = concatBytes(buffer, chunk.value);

      while (buffer.length >= 5) {
        // 用乘法而不是 << ，避免大图长度在 32 位有符号位移里变成负数
        const status = buffer[0];
        const size = buffer[1] * 0x1000000 + (buffer[2] << 16) + (buffer[3] << 8) + buffer[4];
        if (buffer.length < 5 + size) break;

        const payload = buffer.subarray(5, 5 + size);
        buffer = buffer.subarray(5 + size);

        if (status === 0) {
          data = payload.slice(); // 复制一份，后续 buffer 还会被替换
        } else if (status === 2) {
          error = decodeJson(payload) || { error: 'unknown', stage: 'unknown' };
        } else if (status === 1) {
          const message = decodeJson(payload);
          if (message) {
            progress.push(message);
            if (onProgress) onProgress(message);
          }
        }
      }
    }
    return { data, error, progress };
  }

  /** 测试用：把一帧打包成字节 */
  function packFrame(status, payload) {
    const bytes = payload instanceof Uint8Array ? payload : new TextEncoder().encode(String(payload));
    const out = new Uint8Array(5 + bytes.length);
    out[0] = status;
    out[1] = (bytes.length / 0x1000000) & 0xff;
    out[2] = (bytes.length >> 16) & 0xff;
    out[3] = (bytes.length >> 8) & 0xff;
    out[4] = bytes.length & 0xff;
    out.set(bytes, 5);
    return out;
  }

  /** 服务端返回「这页没东西可翻」，重试没有意义，应当直接跳过 */
  const SKIP_STAGES = { no_result: true, transform: true, cancelled: true };

  // ---------------------------------------------------------------------------

  async function readStoredToken(base) {
    if (!hasStorage()) return null;
    const stored = await chrome.storage.local.get(TOKEN_KEY);
    const entry = stored[TOKEN_KEY];
    if (!entry || entry.base !== base || !entry.token) return null;
    return entry.token;
  }

  async function writeStoredToken(base, token) {
    if (!hasStorage()) return;
    await chrome.storage.local.set({ [TOKEN_KEY]: { base, token, savedAt: Date.now() } });
  }

  async function clearStoredToken() {
    if (!hasStorage()) return;
    await chrome.storage.local.remove(TOKEN_KEY);
  }

  async function fetchJson(url, init, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS) : null;
    try {
      const options = Object.assign({}, init);
      if (controller) options.signal = controller.signal;
      return await fetch(url, options);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function createClient(options) {
    const base = M.normalizeBase(options.base);
    if (!base) throw new MTError('config', 'missing mtBase');

    let token = null;
    let tokenLoaded = false;

    async function login() {
      let res;
      try {
        res = await fetchJson(base + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: options.username, password: options.password })
        }, 30000);
      } catch (e) {
        throw new MTError('server-offline', 'login unreachable: ' + e.message);
      }
      if (!res.ok) throw new MTError('server-offline', 'login HTTP ' + res.status, res.status);

      // 注意：服务端凭据错误时也返回 HTTP 200，必须判 success
      const body = await res.json();
      if (!body || body.success !== true || !body.token) {
        throw new MTError('auth', (body && body.message) || 'login rejected');
      }
      token = body.token;
      tokenLoaded = true;
      await writeStoredToken(base, token);
      return token;
    }

    async function ensureToken(force) {
      if (force) {
        token = null;
        await clearStoredToken();
      }
      if (token) return token;
      if (!tokenLoaded) {
        tokenLoaded = true;
        const stored = await readStoredToken(base);
        if (stored) token = stored;
      }
      if (token) {
        // 复用的 token 可能已过期（会话 60 分钟），用 /auth/check 验一次
        try {
          const check = await fetchJson(base + '/auth/check', { headers: { 'X-Session-Token': token } }, 15000);
          const body = await check.json();
          if (body && body.valid === true) return token;
        } catch (e) {
          /* 落到重新登录 */
        }
        token = null;
        await clearStoredToken();
      }
      return login();
    }

    /** 带 token 的请求；401 时清 token 重登一次再试 */
    async function authed(path, init, timeoutMs, allowRetry) {
      const activeToken = await ensureToken(false);
      const headers = Object.assign({}, (init && init.headers) || {}, { 'X-Session-Token': activeToken });
      const res = await fetchJson(base + path, Object.assign({}, init, { headers }), timeoutMs);

      if (res.status === 401 && allowRetry !== false) {
        await ensureToken(true);
        return authed(path, init, timeoutMs, false);
      }
      return res;
    }

    async function readError(res) {
      let detail = null;
      try {
        detail = await res.json();
      } catch (e) {
        try {
          detail = await res.text();
        } catch (e2) {
          detail = null;
        }
      }
      const code = detail && detail.error && detail.error.code;
      if (res.status === 401) return new MTError('auth', 'unauthorized', 401, detail);
      if (res.status === 403) return new MTError('permission', 'forbidden', 403, detail);
      if (res.status === 404) return new MTError('not-found', 'not found', 404, detail);
      if (res.status === 422) return new MTError('bad-config', 'invalid config', 422, detail);
      if (res.status === 429) return new MTError('busy', 'too many requests', 429, detail);
      if (res.status >= 500) return new MTError('translate-failed', 'server error', res.status, detail);
      return new MTError('translate-failed', (code || 'HTTP ' + res.status), res.status, detail);
    }

    return {
      base,

      login,
      ensureToken,

      /** 服务端 config/config.json 的真实值（不含用户组注入） */
      async getConfig() {
        const res = await authed('/config', { method: 'GET' }, 20000);
        if (!res.ok) throw await readError(res);
        return res.json();
      },

      /** 按用户权限过滤后的配置：用来发现用户组里不被接受的值 */
      async getAuthenticatedConfig() {
        const res = await authed('/config?mode=authenticated', { method: 'GET' }, 20000);
        if (!res.ok) throw await readError(res);
        return res.json();
      },

      /** 所有下拉选项；带 token 时结果已按用户权限过滤 */
      async getOptions() {
        const res = await authed('/config/options', { method: 'GET' }, 30000);
        if (!res.ok) throw await readError(res);
        return res.json();
      },

      async translate(blob, filename, configJson, onProgress) {
        const form = new FormData();
        form.append('image', blob, filename || 'page.png');
        form.append('config', configJson || '{}');
        const res = await authed(
          '/translate/with-form/image/stream',
          { method: 'POST', body: form },
          DEFAULT_TIMEOUT_MS
        );
        if (!res.ok) throw await readError(res);

        let frames;
        try {
          frames = await readFrames(res.body, onProgress);
        } catch (readError) {
          // 响应头已经收到（200），读流却失败了 —— 服务端在生成器里抛异常后
          // 直接把连接掐断，h11 报协议错误，浏览器这边就是 "Failed to fetch"。
          // 这就是并发超限的表现，按饱和处理而不是当成未知网络错误。
          throw new MTError('stream-aborted', readError.message || 'stream read failed', 0);
        }

        if (frames.error) {
          const stage = frames.error.stage || 'unknown';
          throw new MTError(
            SKIP_STAGES[stage] ? 'skip' : 'translate-failed',
            frames.error.error || 'translation failed',
            200,
            frames.error
          );
        }
        if (!frames.data) {
          // 拿到 200 却没等到结果帧 —— 服务端在生成器里抛了 429/500，
          // 但响应头早已发出，Starlette 只能掐断流（response already started）。
          // 最常见的成因是用户组并发上限被打满。
          throw new MTError('stream-aborted', 'stream ended without a result frame', 0, {
            stages: frames.progress.map((p) => p.stage)
          });
        }
        return new Blob([frames.data], { type: 'image/png' });
      }
    };
  }

  /** 设置页的「测试连接」用：只探可达性与认证状态，不登录 */
  async function probe(base) {
    const normalized = M.normalizeBase(base);
    if (!normalized) throw new MTError('config', 'missing base');
    try {
      const res = await fetchJson(normalized + '/auth/status', { method: 'GET' }, 10000);
      if (!res.ok) throw new MTError('server-offline', 'HTTP ' + res.status, res.status);
      return await res.json();
    } catch (e) {
      if (e instanceof MTError) throw e;
      throw new MTError('server-offline', e.message);
    }
  }

  const API = { createClient, probe, readFrames, packFrame, MTError, TOKEN_KEY, clearStoredToken };

  root.MTX = Object.assign(root.MTX || {}, { mt: API });

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
