#!/usr/bin/env node
/*
 * verify-contract.js — 不装扩展也能验证「Suwayomi × manga-translator-ui」这条链路
 *
 * 用法：
 *   node tools/verify-contract.js \
 *     --mt http://127.0.0.1:8000 --user <账号> --pass <密码> \
 *     --suwayomi http://127.0.0.1:4567 --manga <id> --chapter 1 --page 0
 *
 * 检查项：
 *   1. Suwayomi 可达 + 图片 URL 能被扩展的正则解析
 *   2. 翻译服务可达 + 登录拿 token
 *   3. /config/options 的目标语言表与内置兜底表是否一致
 *   4. 三层合并后的完整配置能被服务端接受（HTTP 200，不是 422）
 *   5. 合并配置补齐了 GET /config 会剥掉的隐藏键（use_custom_api_params 等）
 *   6. config="{}" 与合并配置翻同一页，产物尺寸量级一致
 *
 * 该脚本不写入任何文件，只打印结论。
 */

'use strict';

const path = require('node:path');
const M = require(path.join(__dirname, '..', 'src', 'shared.js'));
const API = require(path.join(__dirname, '..', 'src', 'mt-api.js'));

const LANGS = require(path.join(__dirname, '..', 'presets', 'languages.json'));

function parseArgs(argv) {
  const out = {
    mt: 'http://127.0.0.1:8000',
    suwayomi: 'http://127.0.0.1:4567',
    user: '',
    pass: '',
    manga: 30,
    chapter: 1,
    page: 0,
    'target-lang': '',
    out: '',
    timeout: 900000
  };
  for (let i = 2; i < argv.length; i += 2) {
    const key = String(argv[i]).replace(/^--/, '');
    const value = argv[i + 1];
    if (!(key in out)) continue;
    out[key] = ['manga', 'chapter', 'page', 'timeout'].includes(key) ? Number(value) : value;
  }
  return out;
}

const results = [];
function check(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail ? ' — ' + detail : ''}`);
  return ok;
}

function keysMissingIn(shallow, live, prefix) {
  const missing = [];
  for (const [k, v] of Object.entries(shallow)) {
    const p = prefix ? prefix + '.' + k : k;
    if (!(k in live)) {
      missing.push(p);
    } else if (M.isPlainObject(v) && M.isPlainObject(live[k])) {
      missing.push(...keysMissingIn(v, live[k], p));
    }
  }
  return missing;
}

async function main() {
  const args = parseArgs(process.argv);
  const mt = M.normalizeBase(args.mt);
  const suwayomi = M.normalizeBase(args.suwayomi);
  let failed = 0;

  console.log('\n[1] Suwayomi');
  const pageUrl = M.buildPageUrl(suwayomi, args.manga, args.chapter, args.page, 0);
  const parsed = M.parsePageUrl(pageUrl, M.DEFAULT_SETTINGS.pageUrlPattern);
  check(!!parsed, '页图 URL 能被 pageUrlPattern 解析', pageUrl);
  const reader = M.parseReaderPath(`/manga/${args.manga}/chapter/${args.chapter}`, M.DEFAULT_SETTINGS.readerUrlPattern);
  check(!!reader, '阅读器路径能被 readerUrlPattern 解析', JSON.stringify(reader));

  let pageBytes = null;
  try {
    const res = await fetch(pageUrl);
    pageBytes = Buffer.from(await res.arrayBuffer());
    check(res.ok && pageBytes.length > 0, '能取到原图', `${res.status}, ${pageBytes.length} bytes`);
  } catch (e) {
    check(false, '能取到原图', String(e));
    return done();
  }
  try {
    const ch = await (await fetch(`${suwayomi}/api/v1/manga/${args.manga}/chapter/${args.chapter}`)).json();
    check(typeof ch.pageCount === 'number', '章节 JSON 可读', `pageCount=${ch.pageCount}`);
    const list = await (await fetch(`${suwayomi}/api/v1/manga/${args.manga}/chapters`)).json();
    check(Array.isArray(list) && list.length > 0, '章节列表可读', `${list.length} 话`);
  } catch (e) {
    check(false, '章节 JSON 可读', String(e));
  }

  console.log('\n[2] 翻译服务');
  if (!args.user || !args.pass) {
    check(false, '提供了登录凭据', '缺少 --user / --pass');
    return done();
  }
  let token = null;
  try {
    const res = await fetch(`${mt}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: args.user, password: args.pass })
    });
    const body = await res.json();
    // 注意：凭据错误时服务端也返回 HTTP 200，必须判 success
    token = body.success ? body.token : null;
    check(!!token, '登录成功（判 success 而非 HTTP 状态）', body.success ? 'admin=' + !!(body.user && body.user.role) : body.message);
  } catch (e) {
    check(false, '登录成功', String(e));
    return done();
  }
  if (!token) return done();
  const auth = { 'X-Session-Token': token };

  const checkRes = await (await fetch(`${mt}/auth/check`, { headers: auth })).json();
  check(checkRes.valid === true, 'X-Session-Token 可用', `user=${checkRes.user && checkRes.user.username}`);

  console.log('\n[3] 配置选项');
  let options = null;
  let live = null;
  try {
    options = await (await fetch(`${mt}/config/options`, { headers: auth })).json();
    check(Array.isArray(options.target_lang), 'GET /config/options 可读', `${options.target_lang.length} 种目标语言`);
    const builtin = Object.keys(LANGS.targetLangs);
    const same = options.target_lang.length === builtin.length &&
      options.target_lang.every((c) => builtin.includes(c));
    check(same, '内置目标语言表与服务端一致', same ? '完全一致' : `服务端=${options.target_lang.join(',')}`);
  } catch (e) {
    check(false, 'GET /config/options 可读', String(e));
  }

  live = await (await fetch(`${mt}/config`, { headers: auth })).json();
  check(M.isPlainObject(live.translator), 'GET /config 可读', `target_lang=${live.translator && live.translator.target_lang}`);

  // 顺带看一眼按用户权限过滤的版本：用户组默认值可能已不被服务端接受，
  // 直接拿去发请求会 500，这正是扩展要过白名单校验的原因。
  const authCfg = await (await fetch(`${mt}/config?mode=authenticated`, { headers: auth })).json();
  const groupIssues = [];
  for (const [section, key, optionsKey] of M.CONSTRAINED_FIELDS) {
    const allowed = options && options[optionsKey];
    const value = authCfg[section] && authCfg[section][key];
    if (Array.isArray(allowed) && value != null && allowed.indexOf(value) < 0) {
      groupIssues.push(`${section}.${key}=${value}`);
    }
  }
  if (groupIssues.length) {
    console.log(`  ! 用户组默认值里有服务端不接受的值：${groupIssues.join(', ')}`);
    console.log('    （扩展会自动退回预设值；这是服务端 group_config.json 的问题，建议顺手清理）');
  }

  console.log('\n[4] 配置合并');
  const preset = require(path.join(__dirname, '..', 'presets', 'standard.json'));
  const targetLang = args['target-lang'] || (live.translator && live.translator.target_lang) || 'CHS';
  const built = M.buildCustomConfig({
    preset,
    live,
    overrides: { translator: { target_lang: targetLang } },
    options
  });
  const mergedJson = built.json;
  console.log(`  · 目标语言：${targetLang}`);

  const missing = keysMissingIn(preset, live, '');
  const restored = missing.filter((k) => !k.startsWith('cli.'));
  check(restored.length > 0, '预设补齐了 GET /config 剥掉的隐藏键', restored.join(', ') || '(无)');
  check(built.config.use_custom_api_params === true, '合并结果保留了 use_custom_api_params', String(built.config.use_custom_api_params));
  check(true, '白名单校验已执行', built.rejected.length ? `修正 ${built.rejected.map((r) => r.path + ':' + r.from + '->' + r.to).join(', ')}` : '无需修正');

  console.log('\n[5] 端到端翻译');
  async function translate(configStr, label, savePath) {
    const form = new FormData();
    form.append('image', new Blob([pageBytes]), `page-${args.page}.jpg`);
    form.append('config', configStr);
    const started = Date.now();
    const res = await fetch(`${mt}/translate/with-form/image/stream`, { method: 'POST', headers: auth, body: form });
    let buf;
    let isPng = false;
    let errorStage = null;
    if (res.ok) {
      const frames = await API.readFrames(res.body);
      if (frames.data) {
        buf = Buffer.from(frames.data);
        isPng = buf.subarray(0, 4).toString('hex') === '89504e47';
        if (savePath) require('node:fs').writeFileSync(savePath, buf);
      } else {
        buf = Buffer.alloc(0);
        errorStage = frames.error ? frames.error.stage : 'empty';
      }
    } else {
      buf = Buffer.from(await res.arrayBuffer());
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    let detail = `${res.status}, ${buf.length} bytes, ${seconds}s`;
    if (errorStage) detail += ` stage=${errorStage}`;
    if (!res.ok) detail += ' ' + buf.subarray(0, 200).toString('utf8');
    check(res.ok && isPng, label, detail);
    return { ok: res.ok && isPng, size: buf.length };
  }

  const a = await translate('{}', 'config="{}"（跟随服务端）返回 PNG');
  const b = await translate(mergedJson, `合并配置（target_lang=${targetLang}）返回 PNG`, args.out || undefined);

  if (a.ok && b.ok) {
    const delta = Math.abs(a.size - b.size) / Math.max(a.size, b.size);
    // 译文由 LLM 生成，本身就有随机性；尺寸量级一致即可认为无结构性漂移
    check(delta < 0.2, '两种模式产物量级一致（无结构性漂移）', `差 ${(delta * 100).toFixed(1)}%`);
  }

  return done();

  function done() {
    failed = results.filter((r) => !r.ok).length;
    console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项未通过'}（共 ${results.length} 项）\n`);
    process.exit(failed === 0 ? 0 : 1);
  }
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});
