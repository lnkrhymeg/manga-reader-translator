'use strict';

const test = require('node:test');
const assert = require('node:assert');
const API = require('../src/mt-api.js');
const { packFrame, readFrames } = API;

const enc = (text) => new TextEncoder().encode(text);

/** 把若干帧拼成一个 ReadableStream，可按任意位置切块以模拟网络分片 */
function streamOf(frames, chunkSize) {
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) { all.set(f, offset); offset += f.length; }

  const size = chunkSize || total;
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < all.length; i += size) {
        controller.enqueue(all.slice(i, Math.min(i + size, all.length)));
      }
      controller.close();
    }
  });
}

test('packFrame/readFrames: 状态 0 的帧被当作最终结果', async () => {
  const image = enc('\x89PNG-fake-image-bytes');
  const result = await readFrames(streamOf([packFrame(0, image)]));
  assert.strictEqual(result.error, null);
  assert.ok(result.data, '应拿到数据');
  assert.strictEqual(new TextDecoder().decode(result.data), '\x89PNG-fake-image-bytes');
});

test('readFrames: 进度帧被收集且不污染结果', async () => {
  const image = enc('IMAGE');
  const seen = [];
  const result = await readFrames(
    streamOf([
      packFrame(1, JSON.stringify({ stage: 'start' })),
      packFrame(1, JSON.stringify({ stage: 'translating' })),
      packFrame(0, image)
    ]),
    (m) => seen.push(m.stage)
  );
  assert.strictEqual(result.progress.length, 2);
  assert.deepStrictEqual(seen, ['start', 'translating']);
  assert.strictEqual(new TextDecoder().decode(result.data), 'IMAGE');
});

test('readFrames: 状态 2 的错误帧被识别，且不返回结果', async () => {
  const result = await readFrames(streamOf([
    packFrame(1, JSON.stringify({ stage: 'detecting' })),
    packFrame(2, JSON.stringify({ error: 'Transform failed', stage: 'transform' }))
  ]));
  assert.strictEqual(result.data, null);
  assert.strictEqual(result.error.stage, 'transform');
  assert.strictEqual(result.error.error, 'Transform failed');
});

test('readFrames: 按字节切碎也能正确重组（网络分片）', async () => {
  const image = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const chunkSize of [1, 2, 3, 7, 13]) {
    const result = await readFrames(
      streamOf([packFrame(1, JSON.stringify({ stage: 'x' })), packFrame(0, image)], chunkSize)
    );
    assert.strictEqual(result.progress.length, 1, `chunkSize=${chunkSize}`);
    assert.deepStrictEqual(Array.from(result.data), Array.from(image), `chunkSize=${chunkSize}`);
  }
});

test('readFrames: 大图长度不被 32 位有符号位移截断', async () => {
  // 1 << 24 在 JS 里是 16777216，用 << 会变成负数；这里用约 2MB 验证
  const big = new Uint8Array(2 * 1024 * 1024 + 7);
  big[0] = 137; big[1] = 80; big[2] = 78; big[3] = 71;
  const result = await readFrames(streamOf([packFrame(0, big)]));
  assert.ok(result.data, '大帧应被解析');
  assert.strictEqual(result.data.length, big.length);
  assert.deepStrictEqual(Array.from(result.data.slice(0, 4)), [137, 80, 78, 71]);
});

test('readFrames: 空流返回空结果', async () => {
  const result = await readFrames(streamOf([]));
  assert.strictEqual(result.data, null);
  assert.strictEqual(result.error, null);
  assert.deepStrictEqual(result.progress, []);
});

test('readFrames: 截断的尾部帧被忽略而不是抛错', async () => {
  const good = packFrame(0, enc('OK'));
  const truncated = packFrame(0, enc('THIS IS INCOMPLETE')).slice(0, 9);
  const all = new Uint8Array(good.length + truncated.length);
  all.set(good, 0);
  all.set(truncated, good.length);
  const result = await readFrames(streamOf([all]));
  assert.strictEqual(new TextDecoder().decode(result.data), 'OK');
});

test('packFrame: 与 Python 的 1 字节状态 + 4 字节大端长度一致', () => {
  const frame = packFrame(2, enc('abc'));
  assert.deepStrictEqual(Array.from(frame), [2, 0, 0, 0, 3, 97, 98, 99]);
});

test('client: 只暴露预期的接口', () => {
  assert.strictEqual(typeof API.createClient, 'function');
  assert.strictEqual(typeof API.probe, 'function');
  assert.strictEqual(typeof API.MTError, 'function');
});
