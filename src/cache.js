/*
 * cache.js — 翻译结果的持久缓存（IndexedDB）
 *
 * 键 = 页图原始 URL，值 = { url, blob, savedAt }。
 * 之所以不用 Cache Storage：Suwayomi 多为 http://192.168.x.x，
 * 非安全上下文下 window.caches 不存在（实测），indexedDB 则始终可用。
 *
 * 依赖：MTX（shared.js）
 */
(function (root) {
  'use strict';

  const M = root.MTX;
  const DB_NAME = M.DB_NAME;
  const DB_STORE = M.DB_STORE;
  const DB_VERSION = M.DB_VERSION;
  const PRUNE_EVERY = 25;

  let dbPromise = null;
  let putsSincePrune = 0;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('indexedDB unavailable'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          const store = db.createObjectStore(DB_STORE, { keyPath: 'url' });
          store.createIndex('savedAt', 'savedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((e) => {
      dbPromise = null;
      throw e;
    });
    return dbPromise;
  }

  function tx(mode, run) {
    return open().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, mode);
      const store = transaction.objectStore(DB_STORE);
      let result;
      try {
        result = run(store);
      } catch (e) {
        reject(e);
        return;
      }
      transaction.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }));
  }

  async function get(url) {
    try {
      const row = await tx('readonly', (store) => store.get(url));
      return row && row.blob ? row.blob : null;
    } catch (e) {
      return null;
    }
  }

  async function put(url, blob) {
    try {
      await tx('readwrite', (store) => store.put({ url, blob, savedAt: Date.now() }));
      putsSincePrune++;
      if (putsSincePrune >= PRUNE_EVERY) {
        putsSincePrune = 0;
        prune(M.CACHE_MAX_PAGES).catch(() => {});
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async function count() {
    try {
      return await tx('readonly', (store) => store.count());
    } catch (e) {
      return 0;
    }
  }

  async function clear() {
    try {
      await tx('readwrite', (store) => store.clear());
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 超出上限时按 savedAt 从旧到新删掉一批，避免把磁盘吃满 */
  async function prune(max) {
    const limit = max > 0 ? max : M.CACHE_MAX_PAGES;
    const total = await count();
    if (total <= limit) return 0;

    const excess = total - limit + Math.ceil(limit * 0.05);
    return new Promise((resolve, reject) => {
      open().then((db) => {
        const transaction = db.transaction(DB_STORE, 'readwrite');
        const index = transaction.objectStore(DB_STORE).index('savedAt');
        let removed = 0;
        const cursorRequest = index.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || removed >= excess) return;
          cursor.delete();
          removed++;
          cursor.continue();
        };
        transaction.oncomplete = () => resolve(removed);
        transaction.onerror = () => reject(transaction.error);
      }).catch(reject);
    });
  }

  /** 删除某一话的所有缓存（「重译本话」用） */
  async function removeChapter(pattern, chapterIndex) {
    return new Promise((resolve, reject) => {
      open().then((db) => {
        const transaction = db.transaction(DB_STORE, 'readwrite');
        const request = transaction.objectStore(DB_STORE).openCursor();
        let removed = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const parsed = M.parsePageUrl(cursor.value && cursor.value.url, pattern);
          if (parsed && parsed.chapterIndex === chapterIndex) {
            cursor.delete();
            removed++;
          }
          cursor.continue();
        };
        transaction.oncomplete = () => resolve(removed);
        transaction.onerror = () => reject(transaction.error);
      }).catch(reject);
    });
  }

  const CACHE = { get, put, count, clear, prune, removeChapter, open };

  root.MTX = Object.assign(root.MTX || {}, { cache: CACHE });

  if (typeof module !== 'undefined' && module.exports) module.exports = CACHE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
