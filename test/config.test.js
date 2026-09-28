'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/shared.js');

const ROOT = path.join(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

test('deepMerge: 嵌套对象逐层合并，后面的层覆盖前面的层', () => {
  const a = { translator: { target_lang: 'CHS', translator: 'openai' }, kernel_size: 3 };
  const b = { translator: { target_lang: 'CHT' } };
  assert.deepStrictEqual(M.deepMerge(a, b), {
    translator: { target_lang: 'CHT', translator: 'openai' },
    kernel_size: 3
  });
});

test('deepMerge: 数组整体替换而不是拼接', () => {
  assert.deepStrictEqual(M.deepMerge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
});

test('deepMerge: null 整体替换，undefined 被跳过', () => {
  const out = M.deepMerge({ a: { b: 1 }, c: 5 }, { a: null, c: undefined });
  assert.deepStrictEqual(out, { a: null, c: 5 });
});

test('deepMerge: 不修改传入的对象', () => {
  const base = { translator: { target_lang: 'CHS' } };
  const snapshot = JSON.stringify(base);
  M.deepMerge(base, { translator: { target_lang: 'CHT' } });
  assert.strictEqual(JSON.stringify(base), snapshot);
});

// ---------------------------------------------------------------------------
// 内置预设（来自 翻译配置/）
// ---------------------------------------------------------------------------

test('presets: standard 与 high-precision 只差检测精度', () => {
  const standard = readJson('presets/standard.json');
  const high = readJson('presets/high-precision.json');

  assert.strictEqual(standard.detector.detection_size, 2048);
  assert.strictEqual(high.detector.detection_size, 4096);

  // 把差异处归一后，两份配置必须完全相同
  const normalized = JSON.parse(JSON.stringify(high));
  normalized.detector.detection_size = standard.detector.detection_size;
  assert.deepStrictEqual(normalized, standard);
});

test('presets: 自带被 Web 端隐藏的 use_custom_api_params', () => {
  // 服务端 GET /config 会剥掉这个键，默认 False；预设必须自带 True，
  // 否则 custom 模式下 config/custom_api_params.json 会失效。
  for (const rel of ['presets/standard.json', 'presets/high-precision.json']) {
    assert.strictEqual(readJson(rel).use_custom_api_params, true, `${rel} 缺少 use_custom_api_params`);
  }
});

test('presets: 覆盖目标语言不会碰其它字段', () => {
  const standard = readJson('presets/standard.json');
  const merged = M.deepMerge(standard, { translator: { target_lang: 'CHT' } });

  assert.strictEqual(merged.translator.target_lang, 'CHT');
  // 除 target_lang 外必须与原预设逐字节一致
  const expected = JSON.parse(JSON.stringify(standard));
  expected.translator.target_lang = 'CHT';
  assert.deepStrictEqual(merged, expected);
});

test('presets: 覆盖检测精度走的是 detector.detection_size', () => {
  const merged = M.deepMerge(readJson('presets/standard.json'), { detector: { detection_size: 4096 } });
  assert.strictEqual(merged.detector.detection_size, 4096);
  assert.deepStrictEqual(merged, readJson('presets/high-precision.json'));
});

// ---------------------------------------------------------------------------
// 语言表
// ---------------------------------------------------------------------------

test('languages: 目标语言 26 项、保留语言 32 项 + none，且都有中文与英文名', () => {
  const langs = readJson('presets/languages.json');

  const targets = Object.keys(langs.targetLangs);
  assert.strictEqual(targets.length, 26, 'VALID_LANGUAGES 应为 26 项');
  assert.ok(targets.includes('CHS') && targets.includes('CHT') && targets.includes('CNR'));

  const keeps = Object.keys(langs.keepLangs);
  assert.strictEqual(keeps.length, 33, 'KEEP_LANGUAGES(32) + none');
  assert.strictEqual(keeps[0], 'none');
  for (const code of ['SWE', 'DAN', 'NOR', 'FIN', 'MSA', 'CAT']) {
    assert.ok(keeps.includes(code), `保留语言缺少 ${code}`);
  }

  for (const [code, names] of Object.entries(langs.targetLangs)) {
    assert.ok(names.zh && names.en, `${code} 缺少显示名`);
  }
  for (const [code, names] of Object.entries(langs.keepLangs)) {
    assert.ok(names.zh && names.en, `${code} 缺少显示名`);
  }
});

test('languages: 目标语言都包含在保留语言里（与上游 VALID ⊂ KEEP 一致）', () => {
  const langs = readJson('presets/languages.json');
  for (const code of Object.keys(langs.targetLangs)) {
    assert.ok(langs.keepLangs[code], `${code} 不在保留语言表中`);
  }
  assert.strictEqual(langs.defaultTargetLang, 'CHS');
  assert.strictEqual(langs.defaultKeepLang, 'none');
});

test('languages: 中文显示名与 Qt UI 的 lang_* 文案一致（抽查）', () => {
  const langs = readJson('presets/languages.json');
  assert.strictEqual(langs.targetLangs.CHS.zh, '简体中文');
  assert.strictEqual(langs.targetLangs.CHT.zh, '繁体中文');
  assert.strictEqual(langs.targetLangs.PTB.zh, '葡萄牙语（巴西）');
  assert.strictEqual(langs.targetLangs.FIL.zh, '菲律宾语（他加禄语）');
  assert.strictEqual(langs.keepLangs.CAT.zh, '加泰罗尼亚语');
});

// ---------------------------------------------------------------------------
// 配置校验（sanitizeConfig）—— 实测踩到的 500 就是这里防住的
// ---------------------------------------------------------------------------

const OPTIONS = {
  translator: ['openai', 'openai_hq', 'gemini', 'gemini_hq', 'sakura', 'none', 'original'],
  ocr: ['32px', '48px', 'mocr'],
  secondary_ocr: ['32px', '48px', 'mocr'],
  detector: ['default', 'craft', 'none'],
  inpainter: ['default', 'lama_large', 'none'],
  inpainting_precision: ['fp32', 'bf16', 'fp16'],
  renderer: ['default', 'none'],
  alignment: ['auto', 'left', 'center', 'right'],
  direction: ['auto', 'horizontal', 'vertical'],
  upscaler: ['esrgan', 'mangajanai', 'none'],
  colorizer: ['none', 'openai_colorizer']
};

test('sanitizeConfig: 组策略注入的非法翻译器被替换（复现 vertex_hq 500）', () => {
  const live = { translator: { translator: 'vertex_hq', target_lang: 'CHS' } };
  const preset = { translator: { translator: 'openai', target_lang: 'CHS' } };
  const { config, rejected } = M.sanitizeConfig(live, OPTIONS, preset);

  assert.strictEqual(config.translator.translator, 'openai', '应退回到预设里的合法值');
  assert.deepStrictEqual(rejected, [{ path: 'translator.translator', from: 'vertex_hq', to: 'openai' }]);
});

test('sanitizeConfig: 没有可用预设值时退到允许列表首项', () => {
  const live = { render: { renderer: 'ghost_renderer' } };
  const { config, rejected } = M.sanitizeConfig(live, OPTIONS, {});
  assert.strictEqual(config.render.renderer, 'default');
  assert.strictEqual(rejected.length, 1);
});

test('sanitizeConfig: 合法值原样保留，不产生任何改写', () => {
  const live = {
    translator: { translator: 'openai_hq', target_lang: 'CHS' },
    ocr: { ocr: '48px', secondary_ocr: 'mocr' },
    render: { renderer: 'default' }
  };
  const { config, rejected } = M.sanitizeConfig(live, OPTIONS, {});
  assert.deepStrictEqual(config, live);
  assert.deepStrictEqual(rejected, []);
});

test('sanitizeConfig: 自由字符串字段不被动（否则会与 config="{}" 漂移）', () => {
  const live = {
    translator: { target_lang: 'KOR', keep_lang: 'none' },
    render: { font_family: 'Arial Unicode MS', layout_mode: 'balloon_fill' },
    ocr: { ocr_vl_language_hint: 'Japanese' },
    upscale: { upscale_ratio: null }
  };
  const { config, rejected } = M.sanitizeConfig(live, OPTIONS, {});
  assert.deepStrictEqual(config, live, '非枚举字段必须原样保留');
  assert.deepStrictEqual(rejected, []);
});

test('sanitizeConfig: 没有 options 时不做任何改动', () => {
  const live = { translator: { translator: 'vertex_hq' } };
  const { config, rejected } = M.sanitizeConfig(live, null, {});
  assert.deepStrictEqual(config, live);
  assert.deepStrictEqual(rejected, []);
});

test('sanitizeConfig: 不修改传入对象', () => {
  const live = { translator: { translator: 'vertex_hq' } };
  const snapshot = JSON.stringify(live);
  M.sanitizeConfig(live, OPTIONS, {});
  assert.strictEqual(JSON.stringify(live), snapshot);
});

test('buildCustomConfig: 三层合并后过白名单，返回可用的 JSON 字符串', () => {
  const preset = readJson('presets/standard.json');
  const live = { translator: { translator: 'vertex_hq' }, detector: { detection_size: 2048 } };
  const overrides = { translator: { target_lang: 'CHT' } };

  const out = M.buildCustomConfig({ preset, live, overrides, options: OPTIONS });
  const parsed = JSON.parse(out.json);

  assert.strictEqual(parsed.translator.translator, 'openai', '非法值被修掉');
  assert.strictEqual(parsed.translator.target_lang, 'CHT', '用户选择生效');
  assert.strictEqual(parsed.use_custom_api_params, true, '预设自带的隐藏键被保留');
  assert.strictEqual(parsed.detector.detection_size, 2048, '服务端值覆盖预设');
  assert.strictEqual(out.rejected.length, 1);
});

// ---------------------------------------------------------------------------
// 默认设置
// ---------------------------------------------------------------------------

test('DEFAULT_SETTINGS: 默认关闭、跟随服务端、不预填任何账号', () => {
  assert.strictEqual(M.DEFAULT_SETTINGS.enabled, false);
  assert.strictEqual(M.DEFAULT_SETTINGS.configMode, 'server');
  assert.strictEqual(M.DEFAULT_SETTINGS.suwayomiBase, 'http://127.0.0.1:4567');
  assert.strictEqual(M.DEFAULT_SETTINGS.mtBase, 'http://127.0.0.1:8000');
  assert.strictEqual(M.DEFAULT_SETTINGS.username, '', '不应预填任何账号名');
  assert.strictEqual(M.DEFAULT_SETTINGS.password, '');
  assert.strictEqual(M.DEFAULT_SETTINGS.profile.presetId, 'standard');
});
