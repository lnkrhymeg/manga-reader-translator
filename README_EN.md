# MangaTrans

English | [简体中文](README.md)

[![test](https://github.com/lnkrhymeg/manga-reader-translator/actions/workflows/test.yml/badge.svg)](https://github.com/lnkrhymeg/manga-reader-translator/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4)](https://developer.chrome.com/docs/extensions/mv3/)
[![reader: Suwayomi](https://img.shields.io/badge/reader-Suwayomi-1f8fff)](https://github.com/Suwayomi/Suwayomi-Server)
[![backend: manga-translator-ui](https://img.shields.io/badge/backend-manga--translator--ui-f59e0b)](https://github.com/hgmzhn/manga-translator-ui)

Inside the **[Suwayomi](https://github.com/Suwayomi/Suwayomi-Server)** web reader, MangaTrans **swaps each manga page for the translated version produced by your own [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui)** — in place, as you read. Both run on your own machines; see [Privacy and data flow](#privacy-and-data-flow) for what may leave them.

- **Seamless** — press *Translate* once. It preheats the first N pages of the current chapter and the first N pages of the **next** chapter, then keeps translating ahead of your reading position. Page turns usually land on an already-finished translation.
- **Non-invasive** — it patches neither Suwayomi nor manga-translator-ui; everything goes over plain HTTP.
- **Generic** — reader URL, credentials, target language and presets are all configurable, and page detection is described by two regexes, so pointing it at another site is mostly a regex change.
- **Small** — a Manifest V3 extension, 8 JS source files, **no build step**, and `node --test` with zero dependencies.

## Supported environment

MangaTrans replaces nothing. It only wires two projects together: **fetch the original page from Suwayomi → hand it to manga-translator-ui → swap the translated image back into the page**.

| Role | Project | Status |
|---|---|---|
| Manga reader (front end) | [**Suwayomi-Server**](https://github.com/Suwayomi/Suwayomi-Server) | ✅ Web reader fully supported (verified on v2.3.2243) |
| Translation backend | [**manga-translator-ui**](https://github.com/hgmzhn/manga-translator-ui) | ✅ Must run in `web` mode (verified on v3.0.4) |

Both run on your own machine or LAN. **The translation step itself may call a cloud AI service**, depending on the endpoint configured in manga-translator-ui — see the next section.

> Unofficial project. Not affiliated with Suwayomi or manga-translator-ui; it only talks to them over HTTP.
> Other readers (Komga, Kavita, …): the two page-detection regexes are configurable, but cross-chapter preheating relies on the reader's chapter API and would need a small adapter — see [Known limitations](#known-limitations).

## Privacy and data flow

**The extension itself sends nothing to any external service.** It talks to exactly two things: Suwayomi (to fetch originals) and your own manga-translator-ui (to send originals, receive translations). No telemetry, no analytics, no external CDN assets — the only permissions requested are `storage` and `scripting`.

**manga-translator-ui's translation step, however, may send text to an external service.** The deciding factor is **the endpoint you configured**, not the translator's name:

| Endpoint you set | Where the OCR-extracted text goes |
|---|---|
| `OPENAI_API_BASE=https://api.deepseek.com` | DeepSeek — **leaves your machine** |
| `OPENAI_API_BASE=http://127.0.0.1:11434` (local Ollama / vLLM) | stays on your machine |
| `GEMINI_API_BASE=...googleapis.com` | Google — **leaves your machine** |
| Translator set to `none` / `original` | no translation, nothing sent |

**The same applies to OCR and the renderer**, except this layer decides whether the **images themselves** leave. The rule of thumb is simple — **if the name contains a provider, it's cloud**:

| Stage | Local (images stay) | Cloud (**images leave too**) |
|---|---|---|
| OCR | `48px`, `mocr`, `paddleocr*`, `hayai_ocr_v2`, … (this project was verified with `48px` + `mocr`) | `openai_ocr`, `gemini_ocr` |
| Renderer | `default`, `none` | `openai_renderer`, `gemini_renderer` |

Three typical combinations:

| Combination | Images | Text |
|---|---|---|
| OCR `48px` + `mocr`, translator pointed at a public LLM (**what this project was verified with**) | stay local | sent to that provider |
| OCR `48px`, translator pointed at a local Ollama / vLLM | stay local | stay local |
| OCR set to `openai_ocr` | **leave** | leave |

For a fully offline setup: point the translator at a local model (or choose `none`), and keep OCR and the renderer on their local defaults.

These settings live in manga-translator-ui's admin web UI or in `config/config.json`. MangaTrans's *Follow server* mode uses them verbatim and never overrides them.

---

## Quick start

You need two things already working: a **[Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server)** whose web reader can open a manga, and a **[manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui)** you can start. The three steps below connect them to the extension.

### 1. Start the translator (`web` mode)

manga-translator-ui has four run modes, and **only `web` can serve as this extension's backend**:

| Mode | Usable | Why |
|---|---|---|
| **`web`** (default port 8000) | ✅ | Exposes an HTTP API, returns standard PNGs, keeps models resident in memory |
| `local` (CLI) | ❌ | A browser extension **cannot spawn local processes**, and the CLI listens on no port. It is also a one-shot batch tool that reloads models (tens of seconds) on every invocation |
| `shared` (5003) | ❌ | Returns Python **pickle**, which JS cannot parse |
| `ws` (5003) | ❌ | A protobuf + URL upload/download task protocol, meant for remote workers |

The repo ships a launcher (the first argument is the manga-translator-ui directory):

```bat
scripts\start-mt-web.bat "D:\manga-translator-ui" 8000
```

Or start it manually:

```bash
cd /d "D:\manga-translator-ui"
.venv\Scripts\python.exe -m manga_translator web --host 0.0.0.0 --port 8000 --use-gpu --models-ttl 0
```

> `--models-ttl 0` keeps models resident in memory — that is what brings per-page latency down to a few seconds.
> On first run, create the server admin account at `http://127.0.0.1:8000/`.

`web` mode and the Qt desktop app are two entry points into the same program with the same features. Running both at once loads two copies of the models and doubles VRAM usage, so prefer `web` alone.

### 2. Install the extension

```bash
git clone https://github.com/lnkrhymeg/manga-reader-translator.git
```

1. Open `chrome://extensions` in Chrome/Edge (`edge://extensions` in Edge) and enable **Developer mode**
2. Click **Load unpacked** and select this repository's root directory
3. Click the extension icon → **Settings**

### 3. Configure and grant permissions

| Field | What to enter |
|---|---|
| Suwayomi URL | Suwayomi's web address. `http://127.0.0.1:4567` if it's on the same machine, otherwise `http://<its-ip>:4567` |
| Manga Translator URL | `http://127.0.0.1:8000` by default |
| Username / Password | The **manga-translator-ui server** account (not Suwayomi's) |

Click **Save & grant** → the browser asks for permission (only for those two origins) → the extension then registers the translation script **for the Suwayomi origin only** and immediately runs four connection checks. If Suwayomi is already open, click **Reload open Suwayomi tabs**.

---

## Usage

Open any `http://<suwayomi>/manga/<id>/chapter/<n>` page and a floating panel appears in the bottom-right corner:

```
MangaTrans  translating… · chapter 12/85 · next 6/220 · queued 3
            [Pause] [Re-translate chapter] [Settings] [−]
```

| Action | Description |
|---|---|
| **Translate** | Preheats the first N pages of this chapter + the first N of the next, then follows your reading position |
| **Pause** | Immediately restores the original images; the cache survives, so resuming is instant |
| **Re-translate chapter** | Clears this chapter's cache and translates it again |
| **Master switch** (toolbar popup) | Turning it off returns every page to the original images |

## Configuration

### Translation config

| Mode | `config` sent | Notes |
|---|---|---|
| **Follow server** (default) | `"{}"` | Uses the server's own `config/config.json`; zero drift |
| **Custom** | Full config JSON | Three-layer merge; lets you pick target language, translator, detection resolution, etc. |

The custom mode merges in this order (later layers override earlier ones):

1. **Built-in preset** — `presets/standard.json` (detection 2048) or `presets/high-precision.json` (detection 4096)
2. **Server config** — read live from `GET /config`
3. **Your choices** — the dropdowns on the settings page

> **Why the full config has to be sent**: the server's `parse_config()` calls `Config.parse_raw()` directly on any non-empty string and does **not** merge it with the server defaults. Sending only a few fields silently discards everything else you tuned.

### Scheduling

| Setting | Default | Meaning |
|---|---|---|
| **Concurrency** | 2 | How many translation requests are in flight. On the reference setup **3 was the throughput knee**; see [Measured reference setup](docs/reference-setup.md) |
| **Preheat pages** | 12 | **Anchored at page 0 of this chapter**: on start, translate the first N pages of this chapter **and** of the next one, to remove the initial wait |
| **Lookahead pages** | 8 | **Anchored at your current page**: always keeps `[current, current+N]` translated, to remove the per-page-turn wait. Jump to page 100 and it takes over immediately |
| **Translate whole chapter** | off | Fills in the rest of the chapter (noticeably more traffic and compute) |

When you get within N pages of the end of a chapter, the next chapter's preheat depth automatically grows by the lookahead value, so its opening pages are ready before you turn to it.

When the server's concurrency is saturated, the extension **throttles itself and cools down** (drops one concurrency step, backs off from 5s exponentially up to 60s) and puts the page back in the queue instead of marking it failed; after three consecutive successes it recovers step by step. The panel shows `cooldown Ns · throttled`.

## Multi-language translation config

The target-language dropdown lists the **26 languages** manga-translator-ui supports, with names matching its own UI exactly (taken from the `lang_*` entries in its `desktop_qt_ui/locales/*.json`):

> Simplified Chinese `CHS`, Traditional Chinese `CHT`, Czech `CSY`, Dutch `NLD`, English `ENG`, French `FRA`, German `DEU`, Hungarian `HUN`, Italian `ITA`, Japanese `JPN`, Korean `KOR`, Polish `POL`, Portuguese (Brazil) `PTB`, Romanian `ROM`, Russian `RUS`, Spanish `ESP`, Turkish `TRK`, Ukrainian `UKR`, Vietnamese `VIN`, Arabic `ARA`, Montenegrin `CNR`, Serbian `SRP`, Croatian `HRV`, Thai `THA`, Indonesian `IND`, Filipino (Tagalog) `FIL`

*Keep language* offers another 32 options (adding Swedish / Danish / Norwegian / Finnish / Malay / Catalan).

The option lists are **read live from `GET /config/options`** whenever possible — that endpoint is already filtered by your account's permissions and follows server upgrades automatically. If the server is unreachable, the extension falls back to its bundled `presets/languages.json`.

The advanced section lets you edit, import and export the full config — **manga-translator-ui's own `manga_translator_config*.json` files can be imported directly**.

### Config allow-list validation

`GET /config?mode=authenticated` injects defaults taken from your **user group**, and group policies may still hold values the current server version no longer accepts:

```
pydantic_core.ValidationError: translator.translator
  Input should be 'openai', 'openai_hq', ... [input_value='vertex_hq']
```

Sending that config back results in **HTTP 500**. So before sending anything, the extension validates the merged config against `GET /config/options` and rolls any rejected enum value back to the preset's value, reporting it on the settings page. The fields validated are exactly those the server models as strict pydantic enums (`translator`, `ocr`, `secondary_ocr`, `detector`, `inpainter`, `inpainting_precision`, `renderer`, `alignment`, `direction`, `upscaler`, `colorizer`). Fields such as `target_lang`, `keep_lang` and `font_family` are free-form strings server-side and are deliberately **left alone** — touching them would itself introduce drift versus `config="{}"`.

## How it works

```
Suwayomi reader page (content script, injected only into the granted Suwayomi origin)
 ① location.pathname → mangaId / chapterIndex; sourceId from an existing <img>
 ② GET /api/v1/manga/{id}/chapter/{n} → page count; /chapters → next chapter
 ③ rewrite page numbers using a real image URL as a template, enqueue by priority
 ④ fetch(page image URL) → original Blob (same origin)
 ⑤ POST {mt}/translate/with-form/image/stream   (X-Session-Token)
 ⑥ write to IndexedDB + replace <img>.src with a blob: URL
        ▼
manga-translator-ui web :8000
```

- **Scheduling is driven by page numbers, not by the DOM.** The Suwayomi reader keeps only about 6 `<img>` elements around (a chapter can have 197 pages), so "what's in the DOM" says nothing about "what should be translated next". The current page is derived from the visible image via `IntersectionObserver`; every other page is computed by URL arithmetic.
- **Priority queue**: `0` current page › `1` next N pages › `2` this chapter's preheat › `3` next chapter's preheat › `4` the rest of the chapter (only with *Translate whole chapter*).
- **It uses the streaming endpoint.** The non-streaming endpoint returns HTTP 500 on a page with no text at all, and because that 500 is an ASGI-level exception it carries **no CORS headers** — the browser only reports `blocked by CORS policy` and the status code is unreachable. The streaming endpoint catches the same exception and turns it into `200 + a status-2 error frame`, which lets the extension tell "this page has no text, skip it" apart from "transient failure, retry it". The frame format is `1 status byte + 4-byte big-endian length + data` (0 = image, 1 = progress, 2 = error).
- **The persistent cache uses IndexedDB**, not Cache Storage — see the FAQ below.
- **Cross-chapter preheat**: a `pageCount` of `-1` means Suwayomi has not fetched that chapter's page list yet, in which case constructing page URLs yields 404s. The extension first issues one `GET` for that chapter to trigger the fetch, and gives up on preheating if it still can't get a count, rather than wasting requests.

## FAQ

| Symptom | What to do |
|---|---|
| Panel says "Translator server offline" | Start the `web` mode as in Quick start step 1; double-check the address and port in settings |
| "Suwayomi connection" fails on the settings page | Not authorized yet. Click **Save & grant** and allow the origin in the browser dialog |
| Login fails | The username/password are the **manga-translator-ui server** account |
| "No permission for this translator/OCR" | Your server account's user group restricts it; loosen it in the server admin UI |
| Panel shows "failed N" | Usually the server's concurrency is saturated (the group's `max_concurrent_tasks`). The extension already throttles and retries; if it keeps happening, set *Concurrency* to 1 or raise the group quota. Translating the same chapter in several tabs shares the same budget |
| Page turns still wait | Raise *Preheat pages* / *Lookahead pages*; make sure the server was started with `--use-gpu`; check per-page timings in the server log |
| The cache count is empty even after clearing | The cache lives under the Suwayomi origin, so you must have **any Suwayomi page open** for it to be read or cleared |
| The browser blocks a "local network access" request | If Chrome enforces Private Network Access, a request from `192.168.x.x` to `127.0.0.1` may be blocked. Point the translator URL at the same subnet as Suwayomi, e.g. `http://<same-subnet-ip>:8000` |

### Why not Cache Storage

Suwayomi usually runs at `http://192.168.x.x`, which is **not a secure context**. On such pages `window.caches` is `undefined` in practice, while `indexedDB` works. Cache keys are the page image URLs; the default cap is 1500 pages, evicting oldest-first beyond that.

### Where to find logs

| What you want to see | Where |
|---|---|
| What the extension is doing, and why it failed | F12 → Console on the reader page, filter by `[MangaTrans]` |
| Panel status and failure counts | The bottom-right panel on the reader page; the toolbar popup shows the same |
| Per-task processing on the server | The terminal window running `web` mode (each task carries a `task_id`) |
| Structured server logs | `manga_translator/server/data/logs.json`, `audit.log`; results and metadata under `data/results/` |

A fuller troubleshooting write-up (the three layers of concurrency limits and four upstream pitfalls) is in **[docs/reference-setup.md](docs/reference-setup.md)** *(Chinese)*.

## Measured reference setup

A complete record from one Intel Arc (XPU/DirectML) machine: the concurrency knee, performance numbers, and the pitfalls hit along the way.

- Concurrency 1 / 2 / 3 → 6.6s / 4.3s / **3.7s** per page; **3 is the knee**, and 4 or 6 gained nothing
- 3-way concurrency is only 1.8× faster than serial → the bottleneck is GPU serialization

See **[docs/reference-setup.md](docs/reference-setup.md)** *(Chinese)* for the details.

## Development

```bash
# Unit tests (zero dependencies, Node 18+)
node --test

# Verify the whole chain without installing the extension:
# fetch a page from Suwayomi → log in → read config → translate one page
node tools/verify-contract.js \
  --mt http://127.0.0.1:8000 --user <user> --pass <password> \
  --suwayomi http://127.0.0.1:4567 --manga <id> --chapter 1 --page 0

# Verify multi-language: switch to Traditional Chinese and export the result image
node tools/verify-contract.js --mt http://127.0.0.1:8000 --user <user> --pass <password> \
  --suwayomi http://127.0.0.1:4567 --manga <id> --chapter 1 --page 0 \
  --target-lang CHT --out cht.png
```

```
manifest.json
presets/     standard.json / high-precision.json / languages.json
src/
  i18n.js    UI strings (Chinese / English)
  shared.js  settings, deepMerge, config allow-list validation, URL regexes, planTasks()  ← pure logic, unit-testable
  cache.js   IndexedDB persistent cache
  mt-api.js  translator client + streaming frame parsing
  engine.js  reader engine (session / scheduling / DOM swapping / floating panel)
  content.js content script entry point
  options.*  settings page
  popup.*    toolbar popup
test/        node --test cases
tools/       verify-contract.js
scripts/     start-mt-web.bat
```

`shared.js` only touches `chrome.*` inside functions and ships a `module.exports` at the end of the file, so Node can `require` it directly for unit tests.

## Known limitations

- **Only Suwayomi has been verified as a reader.** The two page-detection regexes (`readerUrlPattern` / `pageUrlPattern`) are configurable, so in principle another reader is a regex change; but **cross-chapter preheating** depends on the reader exposing a chapter API (page count, next chapter), which for other readers (Komga, Kavita, …) would need an adapter. That part is currently Suwayomi-specific.
- Verified only on Chromium (Chrome / Edge, Manifest V3); **Firefox is not packaged**.
- Translation config is global; picking a target language per manga or per chapter is not supported yet.
- The currently visible page is swapped **immediately** (with a 150ms fade-in). Deferring the swap until the next page turn is a possible future option.
- It depends on manga-translator-ui's `web` mode API. Upstream API changes may break the extension.

## License

MIT — see [LICENSE](LICENSE).

This extension reuses no code from [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server) (MPL-2.0) or [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui) (GPL-3.0); it only talks to them over HTTP, which is why this repository is released independently under MIT.
