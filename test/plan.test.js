'use strict';

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/shared.js');

// 用一张真实出现过的页面图 URL 作为输入
const SAMPLE = 'http://127.0.0.1:4567/api/v1/manga/30/chapter/1/page/0?sourceId=0';

function byPriority(tasks, priority) {
  return tasks.filter((t) => t.priority === priority);
}

function has(tasks, chapterIndex, pageIndex) {
  return tasks.some((t) => t.chapterIndex === chapterIndex && t.pageIndex === pageIndex);
}

test('planTasks: 当前页优先级最高，其次滑动窗口', () => {
  const tasks = M.planTasks(
    { chapterIndex: 1, pageCount: 85, nextChapterIndex: 2, nextChapterPageCount: 80, currentPage: 10 },
    { preheatPages: 12, lookahead: 8 }
  );
  assert.ok(has(tasks, 1, 10));
  assert.strictEqual(tasks[0].priority, 0);
  assert.strictEqual(tasks[0].pageIndex, 10);
  // 窗口内 P+1..P+8 都应为 priority 1
  for (let i = 1; i <= 8; i++) {
    const t = tasks.find((x) => x.chapterIndex === 1 && x.pageIndex === 10 + i);
    assert.strictEqual(t.priority, 1, `page ${10 + i} 应为 priority 1`);
  }
});

test('planTasks: 同页取最高优先级（去重）', () => {
  const tasks = M.planTasks(
    { chapterIndex: 1, pageCount: 85, nextChapterIndex: null, nextChapterPageCount: -1, currentPage: 0 },
    { preheatPages: 12, lookahead: 8 }
  );
  const page0 = tasks.filter((t) => t.chapterIndex === 1 && t.pageIndex === 0);
  assert.strictEqual(page0.length, 1, '同一页不能被排两次');
  assert.strictEqual(page0[0].priority, 0);
});

test('planTasks: 本章预热 12 页落在 priority 2', () => {
  const tasks = M.planTasks(
    { chapterIndex: 1, pageCount: 85, nextChapterIndex: null, nextChapterPageCount: -1, currentPage: 40 },
    { preheatPages: 12, lookahead: 8 }
  );
  assert.strictEqual(byPriority(tasks, 2).length, 12);
  assert.deepStrictEqual(
    byPriority(tasks, 2).map((t) => t.pageIndex),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  );
});

test('planTasks: 下一话预热 12 页，接近本章末尾时加深', () => {
  const base = { chapterIndex: 1, pageCount: 85, nextChapterIndex: 2, nextChapterPageCount: 80, lookahead: 8 };
  const mid = M.planTasks({ ...base, currentPage: 10 }, { preheatPages: 12, lookahead: 8 });
  assert.strictEqual(byPriority(mid, 3).length, 12);

  const nearEnd = M.planTasks({ ...base, currentPage: 80 }, { preheatPages: 12, lookahead: 8 });
  assert.strictEqual(byPriority(nearEnd, 3).length, 20, '接近末尾时应加深到 preheat+lookahead');
});

test('planTasks: pageCount 为 -1（服务端未抓页列表）时不做上界过滤', () => {
  const tasks = M.planTasks(
    { chapterIndex: 1, pageCount: -1, nextChapterIndex: 2, nextChapterPageCount: -1, currentPage: 0 },
    { preheatPages: 12, lookahead: 8 }
  );
  assert.ok(tasks.length > 0);
  assert.strictEqual(byPriority(tasks, 3).length, 12);
});

test('planTasks: 窗口不越过本章末尾', () => {
  const tasks = M.planTasks(
    { chapterIndex: 1, pageCount: 20, nextChapterIndex: 2, nextChapterPageCount: 50, currentPage: 19 },
    { preheatPages: 12, lookahead: 8 }
  );
  for (const t of tasks) {
    if (t.chapterIndex === 1) assert.ok(t.pageIndex < 20, `本章越界: ${t.pageIndex}`);
  }
});

test('planTasks: fullChapter 打开才补全本章剩余页', () => {
  const state = { chapterIndex: 1, pageCount: 30, nextChapterIndex: null, nextChapterPageCount: -1, currentPage: 0 };
  const off = M.planTasks(state, { preheatPages: 2, lookahead: 1, fullChapter: false });
  assert.strictEqual(byPriority(off, 4).length, 0, '关闭时不应排剩余页');

  const on = M.planTasks(state, { preheatPages: 2, lookahead: 1, fullChapter: true });
  // 页 0(priority 0) 与页 1(priority 1) 已被更高优先级占用，剩余 28 页落在 priority 4
  assert.strictEqual(byPriority(on, 4).length, 28);

  // 打开后本章必须被完整覆盖
  const covered = new Set(on.filter((t) => t.chapterIndex === 1).map((t) => t.pageIndex));
  assert.strictEqual(covered.size, 30);
  for (let i = 0; i < 30; i++) assert.ok(covered.has(i), `缺页 ${i}`);
});

test('planTasks: 没有 chapterIndex 时返回空', () => {
  assert.deepStrictEqual(M.planTasks({ chapterIndex: null }, {}), []);
});

test('planTasks: 排序为 优先级升序、同级页号升序', () => {
  const tasks = M.planTasks(
    { chapterIndex: 1, pageCount: 85, nextChapterIndex: 2, nextChapterPageCount: 80, currentPage: 5 },
    { preheatPages: 12, lookahead: 8 }
  );
  for (let i = 1; i < tasks.length; i++) {
    const a = tasks[i - 1];
    const b = tasks[i];
    assert.ok(
      a.priority < b.priority || (a.priority === b.priority && a.pageIndex <= b.pageIndex),
      `排序错误: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`
    );
  }
});

test('parseReaderPath: 只认阅读器路由', () => {
  assert.deepStrictEqual(M.parseReaderPath('/manga/30/chapter/1'), { mangaId: 30, chapterIndex: 1 });
  assert.deepStrictEqual(M.parseReaderPath('/manga/488/chapter/12/'), { mangaId: 488, chapterIndex: 12 });
  assert.strictEqual(M.parseReaderPath('/library'), null);
  assert.strictEqual(M.parseReaderPath('/manga/30'), null);
});

test('parsePageUrl: 解析出章节号、页号与 sourceId', () => {
  assert.deepStrictEqual(M.parsePageUrl(SAMPLE), {
    mangaId: 30,
    chapterIndex: 1,
    pageIndex: 0,
    sourceId: 0
  });
  assert.strictEqual(M.parsePageUrl('http://127.0.0.1:4567/api/v1/settings/about'), null);
});

test('makePageUrlBuilder: 用真实样本换章节号与页号', () => {
  const build = M.makePageUrlBuilder(SAMPLE, M.DEFAULT_SETTINGS.pageUrlPattern);
  assert.ok(build, '应能从样本构造 builder');
  assert.strictEqual(build(1, 5), 'http://127.0.0.1:4567/api/v1/manga/30/chapter/1/page/5?sourceId=0');
  assert.strictEqual(build(7, 0), 'http://127.0.0.1:4567/api/v1/manga/30/chapter/7/page/0?sourceId=0');
});

test('makePageUrlBuilder: 非默认 sourceId 也被保留', () => {
  const sample = 'http://127.0.0.1:4567/api/v1/manga/30/chapter/1/page/3?sourceId=2';
  const build = M.makePageUrlBuilder(sample, M.DEFAULT_SETTINGS.pageUrlPattern);
  assert.strictEqual(build(2, 9), 'http://127.0.0.1:4567/api/v1/manga/30/chapter/2/page/9?sourceId=2');
});

test('originPattern / normalizeBase', () => {
  assert.strictEqual(M.normalizeBase('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
  assert.strictEqual(M.originPattern('http://127.0.0.1:4567/'), 'http://127.0.0.1:4567/*');
  assert.strictEqual(M.originPattern('not a url'), null);
});

// ---------------------------------------------------------------------------
// 自适应节流（服务端并发上限来自用户组，实测管理员组 = 3）
// ---------------------------------------------------------------------------

test('throttle: 初始并发等于配置值', () => {
  const t0 = M.createThrottle(2);
  assert.strictEqual(t0.limit, 2);
  assert.strictEqual(M.throttleWait(t0, 1000), 0);
});

test('throttle: 命中饱和就降并发并冷却，连续饱和冷却时间翻倍', () => {
  let t = M.createThrottle(2);
  const now = 100000;

  t = M.throttleOnSaturated(t, 2, now);
  assert.strictEqual(t.limit, 1, '并发应降到 1');
  assert.strictEqual(M.throttleWait(t, now), 5000, '首次冷却 5s');

  t = M.throttleOnSaturated(t, 2, now);
  assert.strictEqual(t.limit, 1, '并发不会再低于 1');
  assert.strictEqual(M.throttleWait(t, now), 10000, '第二次冷却 10s');

  t = M.throttleOnSaturated(t, 2, now);
  assert.strictEqual(M.throttleWait(t, now), 20000);
});

test('throttle: 冷却上限 60s，不会无限增长', () => {
  let t = M.createThrottle(2);
  for (let i = 0; i < 12; i++) t = M.throttleOnSaturated(t, 2, 0);
  assert.strictEqual(M.throttleWait(t, 0), 60000);
});

test('throttle: 冷却结束后可以继续', () => {
  let t = M.createThrottle(2);
  const now = 1000;
  t = M.throttleOnSaturated(t, 2, now);
  assert.ok(M.throttleWait(t, now) > 0);
  assert.strictEqual(M.throttleWait(t, now + 5000), 0);
});

test('throttle: 连续成功 3 次才恢复一档，且不超过配置值', () => {
  let t = M.createThrottle(3);
  const now = 0;
  t = M.throttleOnSaturated(t, 3, now); // limit 2
  t = M.throttleOnSaturated(t, 3, now); // limit 1

  t = M.throttleOnSuccess(t, 3);
  assert.strictEqual(t.limit, 1, '1 次成功还不该恢复');
  t = M.throttleOnSuccess(t, 3);
  assert.strictEqual(t.limit, 1, '2 次成功还不该恢复');
  t = M.throttleOnSuccess(t, 3);
  assert.strictEqual(t.limit, 2, '3 次成功后恢复一档');

  for (let i = 0; i < 3; i++) t = M.throttleOnSuccess(t, 3);
  assert.strictEqual(t.limit, 3, '恢复到配置值');

  for (let i = 0; i < 6; i++) t = M.throttleOnSuccess(t, 3);
  assert.strictEqual(t.limit, 3, '不应超过配置值');
});

test('throttle: 成功会清空连续饱和计数', () => {
  let t = M.createThrottle(2);
  t = M.throttleOnSaturated(t, 2, 0);
  t = M.throttleOnSaturated(t, 2, 0);
  assert.strictEqual(t.strikes, 2);
  t = M.throttleOnSuccess(t, 2);
  assert.strictEqual(t.strikes, 0, '成功后重新计数');
  t = M.throttleOnSaturated(t, 2, 0);
  assert.strictEqual(M.throttleWait(t, 0), 5000, '冷却时间回到起点');
});

test('throttle: 配置并发为 1 时饱和不会把并发降到 0', () => {
  let t = M.createThrottle(1);
  t = M.throttleOnSaturated(t, 1, 0);
  assert.strictEqual(t.limit, 1);
});
