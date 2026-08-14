# DSH 视觉桥接（view_image）改造文档

> 让纯文本 DeepSeek（无视觉能力）在 DSH 里「看图」：发图后图片正常显示、模型通过 `view_image` 工具桥接到任意 OpenAI 兼容的视觉模型识别图片。
>
> 环境：DSH `0.1.0-rc.6` · 主模型 `pi-ai / deepseek-v4-pro`（纯文本）· 视觉模型 `gpt-5.6-luna`（ohmycdn 中转站）

---

## 一、目标与背景

DeepSeek 模型不支持图片输入，DSH 里粘贴/拖入图片会直接报「当前模型不支持图片」，图片无法进入模型上下文。

本改造解决的问题链：

1. **发图不报错** —— 图片落盘 + 引导模型走桥接
2. **图片正常显示** —— 图片气泡保留在对话里
3. **模型能看图** —— 通过 `view_image` 工具调视觉模型识别
4. **后续对话不崩** —— 历史里的图片块被 adapter 静默剥离，纯文本模型请求不含图片

---

## 二、架构总览

改动分**两层**，性质不同：

| 层 | 内容 | 能否纯插件化 | 位置 |
|---|---|---|---|
| **内核改动** | 图片拦截 + 2 个 adapter 剥离 | ❌ 必须改 dsh 源码 | `deepseek-harness` fork |
| **插件** | `view_image` 工具 + 引导 | ✅ 独立可分发 | `dsh-vision` |

### 发图数据流（最终版）

```
用户发图（base64 image part）
  └─ apiproxy prompt 处理（检测到图片 + 模型不支持 image）
       ├─ durablePromptContent：图片存 attachment → 生成 image block（前端显示气泡）
       ├─ 落盘图片到 <cwd>/.charts/
       ├─ 构造折叠 notice（路径 + 「立即调 view_image」）→ agent.inject
       └─ followup 图片消息（image block + 用户文字）
  └─ agent loop preStep：claim notice + 图片消息
       ├─ 主模型看到 notice（路径引导）
       └─ image block 被 adapter 静默剥离（模型只看到文字）
  └─ 主模型立即调 view_image（工具卡片）
       └─ 视觉模型识别 → tool result（可展开）
  └─ 主模型基于识别结果回答
```

关键机制：

- **图片显示**依赖 session 历史里的 `image` block（前端 `ImageGallery` 渲染）
- **模型请求不含图片**：deepseek / pi-ai 两个 text-only adapter 静默剥离 `image` block，只发文字
- **图片仍进历史**（这是 DSH 架构的硬约束，见「六、限制与权衡」）

---

## 三、内核改动（`scp3500/deepseek-harness` fork）

已推送 commit：`cef85e3` → `773945d`（共 8 个，见文末变更历史）。

### 3.1 `packages/host/apiproxy/src/api-proxy.ts`

**图片入站拦截分支**（`prompt()` 内）：

- 原逻辑：图片 + 模型不支持 image → 直接返回 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝
- 新逻辑：
  1. `durablePromptContent` 存 attachment（图片气泡）
  2. 落盘到 `join(cwd, '.charts')`，文件名 `<时间戳>-<uuid>.<ext>`
  3. 构造折叠 notice（`kind:'plugin', form:'notice', summary:'已接收 N 张图片'`），内容为路径 + 「立即调 view_image」
  4. `agent.inject(notice)` + `agent.followup(图片消息)`

新增辅助：`imageMediaTypeExt()`（mediaType → 扩展名）；import 增加 `writeFile`、`join`、`ImageMediaType`。

**selectModel 修复**（commit `9adf595`）：

- 删掉「切换模型时 session 已有图片就拒绝」的 `model-unavailable` 逻辑（因为 adapter 现在静默剥离图片，切到非视觉模型也安全）

### 3.2 `packages/llm/llm-deepseek/src/serialize.ts`

- 删除 `assertTextOnly`（原来遇 image block 抛 `UNSUPPORTED_CONTENT`）
- 图片块由 `flattenText` 自然跳过，只发文字

### 3.3 `packages/llm/llm-pi-ai/src/adapter.ts` + `src/context.ts`

- 新增 `stripImageBlocks()`（递归剥离 tool-result 里的 image block）
- `stream()` 里：模型不含 image 能力时，剥离 `options.messages` 里的 image block，请求以纯文本继续

> ⚠️ 注意：当前纯文本 provider 只有 deepseek 和 pi-ai 两个，都已改。**将来接入新的纯文本 provider，需给它做同样的剥离**（这是 adapter 层剥离的固有权衡，见「六」）。

---

## 四、插件改动（`dsh-vision`）

本地路径 `C:\Users\33795\.dsh\plugins\dsh-vision`（clone 自 `william-jin-cmu/dsh-vision`，改动**未 push**）。

### 4.1 `lib/vlm.js` + `src/vlm.ts`

- 加 `maxTokensField` 参数，token 上限字段名可配：
  - `max_tokens`（大多数 OpenAI 兼容端点）
  - `max_completion_tokens`（OpenAI 新 o/gpt-5 系模型，**本环境 gpt-5.6-luna 必须用这个**）

### 4.2 `lib/index.js` + `src/index.ts`

- `import z from 'schemastery'` → `'@deepseek-ai/schemastery'`（适配 DSH 作用域包）
- 加 `maxTokensField` 配置项
- 抽出 `describeImages(sources, question, signal)`：多图循环识别
- `ctx.provide('vision', { describe: describeImages })`：暴露视觉识别服务（供 apiproxy 自动识别用，当前已回滚自动识别，服务保留备用）
- `view_image` 工具 `execute` 复用 `describeImages`
- `PROMPT_TEXT` 中文化 + 强化「立即调 view_image、零废话」

### 4.3 `package.json`

- `schemastery` → `@deepseek-ai/schemastery`

---

## 五、运行时部署（npm 目录 + 配置）

### 5.1 npm 部署目录的等价改动

`src` 不重新 build（monorepo 全量编译太重），直接改已编译的 `lib`（运行时实际加载）：

| 文件 | 改动 |
|---|---|
| `dsh-host-apiproxy/lib/index.js` | 同 3.1 |
| `dsh-llm-deepseek/lib/index.js` | 同 3.2 |
| `dsh-llm-pi-ai/lib/index.js` | 同 3.3 |

路径：`C:\Users\33795\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\...`

> ⚠️ `npm update -g @deepseek-ai/dsh` 会覆盖这些 lib 改动。源码在 fork 仓库里，可重新 build 或重打 patch 恢复。

### 5.2 配置

**`~/.dsh/.env`**：视觉模型 key
```
VISION_API_KEY=sk-...
```

**`~/.dsh/profiles/web/cordis.patch.yml`**：挂载 dsh-vision
```yaml
- insert:
    - id: dsh-vision
      name: '@dsh-external/dsh-vision'
      config:
        baseURL: 'https://apic1.ohmycdn.com/v1'
        model: 'gpt-5.6-luna'
        maxTokensField: 'max_completion_tokens'
        maxTokens: 2048
```

**junction 链接**（让 Node 能解析 dsh-vision 及其 peer 依赖）：

- `~/.dsh/profiles/node_modules/@dsh-external/dsh-vision` → `~/.dsh/plugins/dsh-vision`
- `~/.dsh/plugins/dsh-vision/node_modules/@deepseek-ai/{dsh-tools, schemastery, cordis, dsh-system-prompt}` → dsh 部署目录对应包

---

## 六、限制与权衡

| 项 | 说明 |
|---|---|
| **图片进历史** | DSH 有 invariant 强制「模型请求消息 == `deriveMessages()`」，而图片显示又依赖历史里的 image block，两者绑定。图片会永久留在 session 历史（每次重放由 adapter 剥离），无法做到「只显示、连历史都不进」。 |
| **adapter 逐包剥离** | `llm/stream` 是「包装流」型 waterfall（改不了消息），所以剥离只能落在每个 adapter。当前两个纯文本 provider 都改了，新增纯文本 provider 需记得改。 |
| **工具卡片 vs 跳过思考** | 「完全跳过主模型思考」和「显示工具调用卡片」不可兼得：工具卡片由 agent-loop 在「主模型发起工具调用」时写入 `tool/call`+`tool/result` 事件，程序层伪造不了（拿不到 turn/step）。当前选「保留工具卡片」，用 prompt 强化让主模型「立即调工具、零废话」。 |
| **视觉模型格式** | gpt-5.6-luna 必须 `max_completion_tokens`（不能 `max_tokens`），已通过 `maxTokensField` 配置解决。 |
| **schemastery 包名** | DSH 用 `@deepseek-ai/schemastery`（作用域），dsh-vision 原用裸 `schemastery`，已改 import。 |

---

## 七、打包建议（待实施）

内核改动无法纯插件化，所以「装即用」= 「改过的内核 + dsh-vision + 配置」。三个方向：

1. **一键脚本仓库**（推荐）：一个 GitHub 仓库含 dsh-vision + 3 个内核 patch + `install.ps1`（自动应用 patch + 装插件 + 写配置）。缺点：绑定 dsh 版本。
2. **fork 发行版**：维护 `scp3500/deepseek-harness` 作为带视觉桥接的 dsh。最易用但长期维护成本高。
3. **upstream 到官方**：提 PR 给 deepseek-ai，理想但慢、可能改设计。

---

## 八、变更历史（deepseek-harness fork）

| commit | 内容 |
|---|---|
| `cef85e3` | 图片入站落盘 + 改写文字引导（第一版） |
| `b2123c9` | 改为折叠 notice + 图片气泡正常显示 |
| `0a01e12` | llm-deepseek 静默剥离 image block |
| `a07dc29` | llm-pi-ai 静默剥离 image block |
| `9adf595` | 允许 session 含历史图片时切换模型 |
| `980186d` | 图片自动识别（已回滚） |
| `c88ebdc` | 撤销自动识别，恢复主模型自主调 view_image |
| `773945d` | 强化引导，主模型立即调工具零废话 |

---

## 九、验证结论

- ✅ 发图不再报「不支持图片」，图片气泡正常显示
- ✅ 主模型调 `view_image` 工具（工具卡片可展开看识别结果）
- ✅ 视觉模型（gpt-5.6-luna）识别正确（实测：1×1 红图 → "Red"；界面截图 → 正确描述会话列表）
- ✅ 多图兼容（循环落盘 + 循环识别，2 张约 3.7 秒）
- ✅ 后续对话不崩（image block 被 adapter 剥离，pi-ai 不再抛 `does not support image input`）
