# MangaTrans

[![test](https://github.com/lnkrhymeg/manga-reader-translator/actions/workflows/test.yml/badge.svg)](https://github.com/lnkrhymeg/manga-reader-translator/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4)](https://developer.chrome.com/docs/extensions/mv3/)

**MangaTrans** 是一个浏览器扩展：在网页漫画阅读器里，把漫画页**原图实时替换成 [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui) 翻译后的图**。翻译器跑在你自己机器上，图片不出局域网。

- **无感**：点一次「开始翻译」，它会先预热本章前若干页、同时预热**下一话**的前若干页，之后持续跑在你阅读速度前方。翻页时目标页通常已经译好，直接秒换。
- **无侵入**：不改阅读器，也不改 manga-translator-ui，纯 HTTP 对接。
- **通用**：站点地址、账号、目标语言、翻译预设全部可配；页面识别用两条正则描述，换漫画站只需改正则。
- **够简单**：Manifest V3 扩展，8 个 JS 源文件，**无构建步骤**，`node --test` 零依赖跑测试。

> **目前完整适配的是 [Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) 的网页阅读器。** 页面识别的两条正则在设置里可改；跨话预热依赖阅读器的章节接口，其他阅读器需要补一个适配器——见[已知限制](#已知限制)。
>
> 非官方项目，与 Suwayomi、manga-translator-ui 均无隶属关系，只是通过 HTTP 与它们对接。

---

## 快速开始

### 1. 启动翻译服务（`web` 模式）

manga-translator-ui 有四种运行模式，**只有 `web` 能作为本扩展的后端**：

| 模式 | 能否用 | 原因 |
|---|---|---|
| **`web`**（默认 8000） | ✅ | 提供 HTTP 接口、返回标准 PNG、模型常驻内存 |
| `local`（CLI） | ❌ | 浏览器扩展**无法启动本地进程**，CLI 没有监听端口；且它是一次性批处理，每次调用都要重新加载模型（数十秒） |
| `shared`（5003） | ❌ | 返回 Python **pickle**，JS 解析不了 |
| `ws`（5003） | ❌ | protobuf + URL 上传下载的任务协议，给远程 worker 用的 |

仓库自带一键启动脚本（第一个参数是 manga-translator-ui 的目录）：

```bat
scripts\start-mt-web.bat "D:\manga-translator-ui" 8000
```

或者手动：

```bash
cd /d "D:\manga-translator-ui"
.venv\Scripts\python.exe -m manga_translator web --host 0.0.0.0 --port 8000 --use-gpu --models-ttl 0
```

> `--models-ttl 0` 让模型常驻内存，这是单页响应能压到几秒的前提。
> 首次运行需要先在 `http://127.0.0.1:8000/` 创建服务端管理员账号。

`web` 模式和 Qt 桌面版是同一个程序的两个入口，功能一致；但两者同时运行会各加载一套模型、显存翻倍，建议只跑 `web`。

### 2. 安装扩展

```bash
git clone https://github.com/lnkrhymeg/manga-reader-translator.git
```

1. Chrome / Edge 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角**开发者模式**
2. 点**加载已解压的扩展程序**，选择本仓库根目录
3. 点扩展图标 →「打开设置」

### 3. 配置并授权

| 字段 | 填什么 |
|---|---|
| Suwayomi 地址 | Suwayomi 的网页地址。同机填 `http://127.0.0.1:4567`，在别的机器上填 `http://<它的IP>:4567` |
| Manga Translator 地址 | 默认 `http://127.0.0.1:8000` |
| 用户名 / 密码 | **manga-translator-ui 服务端**的账号（不是 Suwayomi 的） |

点「保存并授权」→ 浏览器弹出权限确认（只申请上面这两个站点）→ 授权后扩展把翻译脚本**只注册到 Suwayomi 这一个站点**，并立即跑一遍四项连接测试。若 Suwayomi 标签页已开着，点「重新加载已打开的 Suwayomi 标签页」。

---

## 使用

打开任意 `http://<suwayomi>/manga/<id>/chapter/<n>` 阅读页，右下角出现悬浮面板：

```
MangaTrans  翻译中… · 本章 12/85 · 下一话 6/220 · 队列 3
            [暂停] [重译本话] [设置] [−]
```

| 操作 | 说明 |
|---|---|
| **开始翻译** | 先预热本章前 N 页 + 下一话前 N 页，然后跟着阅读进度走 |
| **暂停** | 立刻恢复原图；缓存保留，继续时秒回 |
| **重译本话** | 清掉本话缓存重新翻 |
| **总开关**（工具栏弹窗） | 关闭后所有页面都回到原图 |

## 配置

### 翻译配置

| 模式 | 发送的 `config` | 说明 |
|---|---|---|
| **跟随服务端**（默认） | `"{}"` | 完全用服务端自己的 `config/config.json`，零漂移 |
| **自定义** | 完整配置 JSON | 三层合并，可选目标语言、翻译器、检测精度等 |

自定义模式的合并顺序（后者覆盖前者）：

1. **内置预设** — `presets/standard.json`（检测 2048）或 `presets/high-precision.json`（检测 4096）
2. **服务端配置** — 实时读 `GET /config`
3. **你的选择** — 设置页下拉框

> **为什么必须发完整配置**：服务端 `parse_config()` 对非空字符串直接 `Config.parse_raw()`，**不会**与服务端默认值合并。只发几个字段会把其它调好的参数一起丢掉。

### 调度

| 参数 | 默认 | 含义 |
|---|---|---|
| **并发数** | 2 | 同时向服务端发几个翻译请求。参考环境实测 **3 是吞吐拐点**，详见 [实测参考环境](docs/reference-setup.md) |
| **预热页数** | 12 | **固定锚在本话第 0 页**：开始翻译时先把本章前 N 页 + 下一话前 N 页翻掉，解决"开场等待" |
| **预读页数** | 8 | **锚在你当前所在页**：始终保证 `[当前页, 当前页+N]` 已译好，解决"翻页等待"。你跳到第 100 页时它会立刻接管 |
| **翻译整章** | 关 | 打开后补全本章剩余所有页（流量与算力明显上升） |

读到本章末尾前 N 页时，下一话的预热深度会自动加上「预读页数」，避免你翻过去时开头还没译完。

服务端并发被占满时，扩展会**自动降速 + 冷却**（并发降一档，退避 5s 起、指数增长、上限 60s），把该页放回队列而不是记成失败；连续成功 3 次后再逐步恢复。面板会显示「冷却 Ns · 已降速」。

## 多语言翻译配置

目标语言下拉列出 manga-translator-ui 支持的 **26 种**，中文名与它自带界面完全一致（取自其 `desktop_qt_ui/locales/*.json` 的 `lang_*` 文案）：

> 简体中文 `CHS`、繁体中文 `CHT`、捷克语 `CSY`、荷兰语 `NLD`、英语 `ENG`、法语 `FRA`、德语 `DEU`、匈牙利语 `HUN`、意大利语 `ITA`、日语 `JPN`、韩语 `KOR`、波兰语 `POL`、葡萄牙语（巴西）`PTB`、罗马尼亚语 `ROM`、俄语 `RUS`、西班牙语 `ESP`、土耳其语 `TRK`、乌克兰语 `UKR`、越南语 `VIN`、阿拉伯语 `ARA`、黑山语 `CNR`、塞尔维亚语 `SRP`、克罗地亚语 `HRV`、泰语 `THA`、印度尼西亚语 `IND`、菲律宾语（他加禄语）`FIL`

「保留语言」另有 32 项（多出瑞典语 / 丹麦语 / 挪威语 / 芬兰语 / 马来语 / 加泰罗尼亚语）。

选项列表**优先实时读取 `GET /config/options`** —— 它已按你的账号权限过滤，也会随服务端升级自动更新；连不上服务端时退回仓库内置的 `presets/languages.json`。

高级区可以直接编辑、导入、导出完整配置 —— **manga-translator-ui 的 `manga_translator_config*.json` 可以直接导入**。

### 配置白名单校验

`GET /config?mode=authenticated` 会把**用户组**里的默认值注入进来，而组策略里可能残留服务端当前版本已不认识的取值：

```
pydantic_core.ValidationError: translator.translator
  Input should be 'openai', 'openai_hq', ... [input_value='vertex_hq']
```

直接把这个配置发回去会 **HTTP 500**。所以扩展在发送前会拿 `GET /config/options` 做一遍白名单校验，把不被接受的枚举值退回预设值，并在设置页提示。受校验的字段恰是服务端 pydantic 严格枚举的那些（`translator` / `ocr` / `secondary_ocr` / `detector` / `inpainter` / `inpainting_precision` / `renderer` / `alignment` / `direction` / `upscaler` / `colorizer`）；`target_lang`、`keep_lang`、`font_family` 等在服务端是自由字符串，**不动**，否则反而会与 `config="{}"` 产生漂移。

## 工作原理

```
Suwayomi 阅读器页（content script，只注入到已授权的 Suwayomi 源）
 ① location.pathname → mangaId / chapterIndex；从已有 <img> 取 sourceId
 ② GET /api/v1/manga/{id}/chapter/{n} → 总页数；/chapters → 下一话
 ③ 用真实图 URL 当模板改写页号，按优先级入队
 ④ fetch(页图 URL) → 原图 Blob（同源）
 ⑤ POST {mt}/translate/with-form/image/stream   (X-Session-Token)
 ⑥ 写入 IndexedDB + 用 blob: URL 替换 <img>.src
        ▼
manga-translator-ui web :8000
```

- **按页号调度，不是按 DOM**。Suwayomi 阅读器只保留约 6 个 `<img>`（一话可能有 197 页），"DOM 里有什么"完全不能代表"该翻什么"。当前页由 `IntersectionObserver` 从可见图反解，其余页用 URL 算术推导。
- **优先级队列**：`0` 当前页 › `1` 当前页后 N 页 › `2` 本章预热 › `3` 下一话预热 › `4` 本章剩余（仅"翻译整章"）。
- **走流式接口**：非流式端点在"整页没有文字"时会 HTTP 500，而 500 是 ASGI 层异常、**不带 CORS 头**，浏览器只报 `blocked by CORS policy`，状态码完全拿不到。流式端点把异常接住、改成 `200 + 状态 2 的错误帧`，于是能区分「这页没文字，跳过」与「临时故障，该重试」。分帧格式 `1 字节状态 + 4 字节大端长度 + 数据`（0=图片，1=进度，2=错误）。
- **持久缓存用 IndexedDB**，不是 Cache Storage —— 见下方常见问题。
- **跨话预热**：`pageCount: -1` 表示 Suwayomi 还没抓这一话的页列表，此时构造页 URL 会 404。扩展会先 `GET` 一次该章节触发抓取，拿不到就放弃预热，不浪费请求。

## 常见问题

| 现象 | 处理 |
|---|---|
| 面板显示「翻译服务未启动」 | 按快速开始第 1 步启动 `web` 模式；确认设置里的地址与端口 |
| 设置页「Suwayomi 连接」失败 | 还没授权。点「保存并授权」，在弹窗里允许该站点 |
| 登录失败 | 用户名/密码是 **manga-translator-ui 服务端**的账号 |
| 提示没有权限使用某翻译器/OCR | 服务端账号的用户组限制了，去服务端管理后台放开 |
| 面板出现「失败 N」 | 多半是服务端并发被占满（用户组 `max_concurrent_tasks`）。扩展已会自动降速重试；若一直不降，把「并发数」改成 1，或调大用户组配额。同一话在多个标签页同时翻译会叠加占用额度 |
| 翻页仍然要等 | 调大「预热页数 / 预读页数」；确认服务端带 `--use-gpu`；看服务端日志里的单页耗时 |
| 缓存清了但设置页看不到数量 | 缓存建在 Suwayomi 页面的源下，需要**打开任意 Suwayomi 页面**才能读取 / 清空 |
| 浏览器提示"访问本地网络"被拦截 | 若 Chrome 启用 Private Network Access，从 `192.168.x.x` 请求 `127.0.0.1` 可能被拦。把翻译服务地址改成与 Suwayomi 同网段（如 `http://<同网段IP>:8000`） |

### 缓存为什么不用 Cache Storage

Suwayomi 通常跑在 `http://192.168.x.x`，**不是安全上下文**，实测那种页面上 `window.caches` 是 `undefined`，而 `indexedDB` 可用。缓存键就是页图 URL，默认上限 1500 页，超出按时间淘汰。

### 怎么看日志

| 想看什么 | 去哪里 |
|---|---|
| 扩展在干什么、为什么失败 | 阅读页 F12 → Console，过滤 `[MangaTrans]` |
| 面板状态与失败数 | 阅读页右下角面板；点扩展图标也有 |
| 服务端每个任务的处理过程 | 运行 `web` 模式的那个终端窗口（每个任务带 `task_id`） |
| 服务端结构化日志 | `manga_translator/server/data/logs.json`、`audit.log`；结果与元数据在 `data/results/` |

更完整的排错案例（并发上限的三层结构、四个踩过的上游坑）见 **[docs/reference-setup.md](docs/reference-setup.md)**。

## 实测参考环境

一台 Intel Arc（XPU/DirectML）机器上的完整实测记录：并发拐点、性能数字、踩过的坑。

- 并发 1 / 2 / 3 → 6.6s / 4.3s / **3.7s** 每页，**3 是拐点**，4 与 6 无增益
- 3 并发相对串行只有 1.8× 加速 → 瓶颈在 GPU 串行化

详见 **[docs/reference-setup.md](docs/reference-setup.md)**。

## 开发

```bash
# 单元测试（零依赖，Node 18+）
node --test

# 不装扩展也能验证整条链路：Suwayomi 取图 → 登录 → 读配置 → 翻一页
node tools/verify-contract.js \
  --mt http://127.0.0.1:8000 --user <账号> --pass <密码> \
  --suwayomi http://127.0.0.1:4567 --manga <id> --chapter 1 --page 0

# 验证多语言：切繁体并导出结果图
node tools/verify-contract.js --mt http://127.0.0.1:8000 --user <账号> --pass <密码> \
  --suwayomi http://127.0.0.1:4567 --manga <id> --chapter 1 --page 0 \
  --target-lang CHT --out cht.png
```

```
manifest.json
presets/     standard.json / high-precision.json / languages.json
src/
  i18n.js    界面文案（中文 / English）
  shared.js  设置、deepMerge、配置白名单校验、URL 正则、planTasks()   ← 纯逻辑，可单测
  cache.js   IndexedDB 持久缓存
  mt-api.js  翻译服务客户端 + 流式分帧
  engine.js  阅读器引擎（会话 / 调度 / DOM 替换 / 悬浮面板）
  content.js 内容脚本入口
  options.*  设置页
  popup.*    工具栏弹窗
test/        node --test 用例
tools/       verify-contract.js
scripts/     start-mt-web.bat
```

`shared.js` 只在函数内部访问 `chrome.*`，文件尾附带 `module.exports`，因此 Node 可以直接 `require` 做单测。

## 已知限制

- **阅读器只验证过 Suwayomi。** 页面识别的两条正则（`readerUrlPattern` / `pageUrlPattern`）可以在设置里改，理论上换阅读器只改正则；但**跨话预热**依赖阅读器暴露章节接口（页数、下一话），其他阅读器（Komga / Kavita 等）需要补一个适配器。目前那部分是 Suwayomi 专属的。
- 只在 Chromium 系（Chrome / Edge，Manifest V3）验证过；**Firefox 未打包**。
- 翻译配置是全局的，暂不支持"按漫画 / 按话"分别指定目标语言。
- 当前可见页的译文是**立即替换**的（带 150ms 淡入）；"等翻页时再替换"是后续可选项。
- 依赖 manga-translator-ui 的 `web` 模式接口。上游接口变动可能导致本扩展失效。

## License

MIT — 见 [LICENSE](LICENSE)。

本扩展不复用 [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server)（MPL-2.0）或 [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui)（GPL-3.0）的任何代码，只通过 HTTP 对接，因此本仓库独立以 MIT 发布。

---

## English summary

**MangaTrans** is a Manifest V3 browser extension that replaces manga pages in a web manga reader with images translated by a local **manga-translator-ui** server, aiming for a seamless reading flow: it preheats the first N pages of the current chapter and of the **next** chapter, then keeps translating ahead of your reading position.

Currently the only fully supported reader is **Suwayomi**'s web reader. Page detection is driven by two configurable regexes, so other readers mostly need those adjusted; seamless cross-chapter preheating additionally needs the reader's chapter API, which would require a small adapter (see *Known limitations*).

Only the `web` mode of manga-translator-ui can be used as a backend — a browser extension cannot spawn local processes, and its `local` CLI mode has no listening port, reloads models on every invocation, and is a one-shot batch tool. `shared` returns Python pickle (unparsable in JS) and `ws` speaks a protobuf task protocol meant for remote workers.

Setup: start `python -m manga_translator web --port 8000`, load the unpacked extension, fill in the Suwayomi URL, the translator URL and the translator's server credentials, then click *Save & grant*. Open a chapter and press **Translate**.

Target language can be picked from the 26 languages manga-translator-ui supports, or you can import a full manga-translator-ui config JSON. See [docs/reference-setup.md](docs/reference-setup.md) for a measured reference setup (concurrency ceiling, per-page timings, and the upstream pitfalls found along the way).
