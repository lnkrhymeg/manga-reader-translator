# 实测参考环境

本扩展是在一台具体的机器上开发并实测出来的。这份文档记录**去敏后**的实测数据与踩过的坑，供你在自己环境里做对照。

> 文档里不包含任何真实 IP、路径、账号或作品信息。数字来自一次实测，你的硬件不同会不一样，**趋势比绝对值重要**。

---

## 1. 参考环境

| 项 | 值 |
|---|---|
| 操作系统 | Windows |
| GPU | Intel Arc（走 XPU / DirectML 后端） |
| 浏览器 | Chrome（Manifest V3） |
| Suwayomi-Server | v2.3.2243 |
| manga-translator-ui | v3.0.4 |
| 服务端翻译参数 | `translator=openai`（OpenAI 兼容端点）、`target_lang=CHS`、`ocr=48px + hybrid(mocr)`、`inpainter=lama_large`、`detector` 检测分辨率 2048 |
| 部署形态 | Suwayomi 与翻译服务在同一局域网的不同主机上，浏览器在第三台机器上 |

## 2. 性能实测

同一张页面图重复请求，模型已预热（首次请求要额外等模型加载约 36 秒）：

| 并发 | 成功 / 总数 | 墙钟 | 单页有效耗时 | 吞吐 |
|---|---|---|---|---|
| 1 | 1/1 | 6.6s | 6.61s | 0.15 页/s |
| 2 | 2/2 | 8.7s | 4.33s | 0.23 页/s |
| **3** | 3/3 | 11.1s | **3.68s** | **0.27 页/s** |
| 4 | 3/4 | 11.6s | 3.87s | 0.26 页/s |
| 6 | 3/6 | 10.9s | 3.65s | 0.27 页/s |

正文页（文字多）与封面页（文字少）的差异不大，都在 3.1–3.7s 区间，所以**页面的文字量不是主要变量**。

**两个结论：**

1. **3 是吞吐拐点。** 并发 3 相比串行只有 **1.8×** 加速（3 张 11.1s vs 单张 6.6s），不是理想的 3×。加到 4 和 6 完全不涨 —— 说明瓶颈在 **GPU 串行化**，不在配额。所以设置页「并发数」填 3 就够，再高只是浪费。
2. 单页 3.7s 意味着**预读 8 页 ≈ 30 秒缓冲**。大多数阅读速度下够用；读得很快就把「预读页数」调到 12–15。

## 3. 并发上限的三层结构

排查「为什么并发上不去」时，要注意服务端有三层限制，而且它们的行为完全不同：

### 第一层：用户组配额（会掐断连接）

```
group_config.json →  <组>.parameter_config.quota.max_concurrent_tasks
```

**优先级是「用户组 > 账号」**，而且这个值**只有 `> 0` 才生效**：

```python
group_max = quota_config.get('max_concurrent_tasks')
if group_max is not None and group_max > 0:
    return group_max
return account.permissions.max_concurrent_tasks   # 设 0 / -1 会退回到账号值
```

所以把组配额设成 0 或负数，得到的是**账号级的值**，而不是无限。

超限时的报错长这样：

```
fastapi.exceptions.HTTPException: 429:
  {'error': {'code': 'CONCURRENT_LIMIT_EXCEEDED',
             'details': {'current_tasks': 4, 'max_concurrent_tasks': 3}}}
```

### 第二层：服务端全局信号量（会排队）

```
task_manager.server_config['max_concurrent_tasks']   # 默认 3
```

这是真正决定**同时跑几个翻译**的值。超出的请求不会失败，而是**排队**（服务端会发一条 `stage: "queued"` 的进度帧）。它可以通过新建 `manga_translator/server/data/admin_config.json` 修改，而且是**热加载**的，不用重启：

```json
{ "max_concurrent_tasks": 6 }
```

### 第三层：GPU 真实吞吐

参考环境里这一层是最紧的 —— 见上一节的 1.8× 加速比。把前两层放开也换不来线性提升。

## 4. 踩过的四个坑

### 4.1 整页没有文字 → HTTP 500，而且拿不到状态码

非流式端点 `/translate/with-form/image` 在检测到 0 个文本框时，会走到：

```
File ".../routes/translation.py", line 67, in _png_response_from_ctx
    ctx.result.save(img_byte_arr, format="PNG")
File ".../PIL/Image.py", line 726, in _ensure_mutable
ValueError: Operation on closed image
```

这时它抛的是 **ASGI 层异常，响应不带 CORS 头**，浏览器只会报：

```
Access to fetch at '.../translate/with-form/image' ... has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

**状态码完全拿不到**，客户端只能当成未知网络错误反复重试，白白烧 GPU。

**解法**：改用流式端点 `/translate/with-form/image/stream`。它把 `transform()` 包在 try/except 里，异常变成 `200 + 状态 2 的错误帧`，于是可以精确区分「这页没文字」（跳过，不重试）和「临时故障」（该重试）。

### 4.2 `pageCount: -1` → 下一话预热全打 404

Suwayomi 只有在**该话被打开过**之后才会抓取它的页列表，在那之前：

```json
{ "index": 2, "pageCount": -1 }
```

此时按 `chapter/2/page/0` 构造 URL 一律 404，每页还要重试 3 次。

**解法**：预热下一话之前先 `GET /api/v1/manga/{id}/chapter/{next}` 触发一次抓取，拿到真实 `pageCount` 再排期；仍然拿不到（`-1`）就放弃预热，不浪费请求。

### 4.3 用户组默认值注入非法枚举 → 回发必然 500

`GET /config?mode=authenticated` 会把**用户组**里的默认值注入进来，而组策略里可能残留当前版本已不认识的取值：

```
pydantic_core._pydantic_core.ValidationError: 1 validation error for Config
translator.translator
  Input should be 'openai', 'openai_hq', 'gemini', 'gemini_hq', 'sakura', 'none' or 'original'
  [type=enum, input_value='vertex_hq', input_type=str]
```

这个值在代码库里搜不到任何定义，是历史残留。把它原样发回翻译接口 → **HTTP 500**。

**解法**：合并后的配置在发送前，拿 `GET /config/options` 做一次白名单校验。受校验的字段恰是服务端 pydantic **严格枚举**的那些；`target_lang`、`keep_lang`、`font_family`、`layout_mode`、`ocr_vl_language_hint`、`high_quality_prompt_path` 在服务端是**自由字符串**，绝不能「顺手校验」，否则反而会与 `config="{}"` 产生漂移。

顺带一提：这个残留值同样会让服务端自己的 Web 管理端在提交参数时 500，值得顺手清掉。

### 4.4 `GET /config` 会剥掉隐藏键 → 自定义配置必须自带

服务端 `/config` 与 `/config/defaults` 会过滤掉一批 Web 端不该暴露的键，其中有一个很关键：

```
use_custom_api_params      # 默认 False
```

它控制是否启用 `config/custom_api_params.json`（例如 `temperature: 0.3, top_p: 0.95`）。如果自定义配置以 `/config` 的返回值为基底，这个键就会丢失 → 退回模型默认值 → **译文和桌面版不一致**。

**解法**：内置预设必须是**完整配置**（仓库里的 `presets/*.json` 自带 `use_custom_api_params: true`），合并顺序是「完整预设 → `/config` 的真实值 → 用户在下拉框里的选择」。同时 `/config?mode=authenticated` 只用来**发现**上面 4.3 那种非法值，不用来当合并基底。

### 4.5 附加：`window.caches` 在 http 站点不可用

Suwayomi 一般跑在 `http://192.168.x.x`，**不是安全上下文**。实测该页面上：

```js
window.isSecureContext   // false
typeof caches            // "undefined"
typeof indexedDB         // "object"
```

所以持久缓存不能用 Cache Storage，得用 IndexedDB。

## 5. 给你的建议

1. **并发从 3 起步**，用 `tools/verify-contract.js` 确认链路通了之后，再按自己的硬件微调。
2. **先确认第一层上限**：如果组配额是 3，那设再高也没用，超出的部分会被掐断。可以直接 grep `group_config.json` 里的 `max_concurrent_tasks`。
3. **别指望无限并发**：参考环境里 GPU 在 3 并发就饱和了。真正的提速手段是换更强的 GPU，或者让翻译端的 API 更快。
4. **预热与预读按阅读速度调**：单页耗时 × 预读页数 ≈ 你能接受的翻页等待时间上限。
