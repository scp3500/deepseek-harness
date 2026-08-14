#!/usr/bin/env node
/**
 * 视觉桥接内核 patch 应用脚本。
 *
 * 用途：DSH 升级（npm update -g @deepseek-ai/dsh）会覆盖 node_modules 里的
 * 内核 lib 改动。跑本脚本把改动重新打回去，无需手动改文件。
 *
 * 用法：
 *   node vision-patch/apply.mjs
 *   或带参数指定 dsh 安装根目录：
 *   node vision-patch/apply.mjs "C:/path/to/@deepseek-ai/dsh"
 *
 * 原理：对 3 个 lib 文件做「锚点替换」（old → new）。若某处锚点在新版本里
 * 找不到（上游重构了那段代码），脚本会明确报错并列出失效位置，提示手动处理。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'

// 定位 dsh 安装根目录：优先用命令行参数，否则用 `npm root -g`。
function resolveDshRoot(arg) {
  if (arg) return resolve(arg)
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
    return join(globalRoot, '@deepseek-ai', 'dsh')
  } catch {
    throw new Error('无法定位 dsh 安装目录，请用参数显式传入：node apply.mjs "<dsh 根目录>"')
  }
}

// 每个 patch 规则：old 是「升级后的原始代码」锚点，new 是「打上补丁后」的代码。
const PATCHES = [
  {
    file: 'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js',
    replacements: [
      {
        name: 'apiproxy: import writeFile',
        old: `import { mkdir, stat } from "node:fs/promises";`,
        new: `import { mkdir, stat, writeFile } from "node:fs/promises";`,
      },
      {
        name: 'apiproxy: import join',
        old: `import { dirname, extname } from "node:path";`,
        new: `import { dirname, extname, join } from "node:path";`,
      },
      {
        name: 'apiproxy: 图片拦截分支（落盘 + notice 引导）',
        old: `							if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {
								code: "attachment-error",
								message: \`Model "\${current.model}" does not support image input.\`,
								details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }
							});`,
        new: `							if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) {
								// Text-only model: keep the image as a durable attachment so the Web
								// client renders a normal image bubble, and spill it to the workspace
								// as a file. The path + view_image instruction ride a collapsed plugin
								// notice (model-visible, collapsed in the UI) injected for the next
								// pre-step; the DeepSeek adapter drops the image block silently.
								const durable = await durablePromptContent(ctx, content);
								const cwd = agent.session.header.cwd;
								const spillDir = join(cwd, ".charts");
								await mkdir(spillDir, { recursive: true });
								const savedPaths = [];
								const mediaExt = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
								for (const part of content) {
									if (part.type !== "image") continue;
									const bytes = decodeBase64(part.data);
									const filename = \`\${Date.now()}-\${randomUUID().slice(0, 8)}\${mediaExt[part.mediaType] ?? ".png"}\`;
									const target = join(spillDir, filename);
									await writeFile(target, bytes);
									savedPaths.push(target);
								}
								const notice = createUserMessage({
									content: [{ type: "text", text: \`用户发来了图片，文件路径如下：\\n\${savedPaths.map((path) => \`- \${path}\`).join("\\n")}\\n\\n请立即调用 view_image 工具查看这些图片。不要输出任何解释、寒暄或过渡文字，你的第一步就必须是发起工具调用，不要先说话。\` }],
									source: {
										kind: "plugin",
										plugin: "dsh-vision",
										form: "notice",
										summary: \`已接收 \${savedPaths.length} 张图片，将用视觉工具查看\`
									}
								});
								const message = createUserMessage({ content: durable, source });
								agent.inject(notice);
								if (mode === "steer") agent.steer(message);
								else agent.followup(message);
								return ok(request, { accepted: true });
							}`,
      },
    ],
  },
  {
    file: 'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js',
    replacements: [
      {
        name: 'llm-deepseek: assertTextOnly 静默剥离',
        old: `/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The DeepSeek chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");
}`,
        new: `/**
 * The DeepSeek chat-completions route is text-only, so image blocks are dropped
 * silently by the text-flattening path below rather than rejected. The image
 * remains visible to the Web client (which reads it from the session log) while
 * a text-only model inspects it through the \`view_image\` vision-bridge tool.
 */
function assertTextOnly(blocks) {}`,
      },
    ],
  },
  {
    file: 'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
    replacements: [
      {
        name: 'llm-pi-ai: stripImageBlocks 函数',
        old: `/** Join the text blocks of a harness message. */
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Flatten text recursively inside one tool result. */
function toolResultText(blocks) {`,
        new: `/** Join the text blocks of a harness message. */
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Strip image blocks (recursively inside tool results) for a text-only model. */
function stripImageBlocks(blocks) {
	return blocks
		.filter((block) => block.type !== "image")
		.map((block) => block.type === "tool-result" ? { ...block, content: stripImageBlocks(block.content) } : block);
}
/** Flatten text recursively inside one tool result. */
function toolResultText(blocks) {`,
      },
      {
        name: 'llm-pi-ai: stream 剥离逻辑',
        old: `			try {
				const containsImage = options.messages.some((message) => contentHasImage(message.content));
				if (containsImage && !model.input.includes("image")) throw new LlmError(\`pi-ai model "\${model.id}" does not support image input\`, "UNSUPPORTED_CONTENT");
				const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;
				if (containsImage && attachments === void 0) throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
				const context = attachments === void 0 ? toPiContext(options) : await toPiContext(options, attachments);`,
        new: `			try {
				const containsImage = options.messages.some((message) => contentHasImage(message.content));
				const vision = model.input.includes("image");
				// Text-only model: strip image blocks so the request proceeds as pure
				// text instead of throwing. The image stays in the session log (Web
				// client preview) but never reaches the wire; the model inspects it
				// through the \`view_image\` vision-bridge tool instead.
				const effective = containsImage && !vision
					? { ...options, messages: options.messages.map((message) => ({ ...message, content: stripImageBlocks(message.content) })) }
					: options;
				const effectiveImage = effective !== options ? false : containsImage;
				const attachments = effectiveImage ? this.config.resolveAttachments?.() : void 0;
				if (effectiveImage && attachments === void 0) throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
				const context = attachments === void 0 ? toPiContext(effective) : await toPiContext(effective, attachments);`,
      },
    ],
  },
]

const dshRoot = resolveDshRoot(process.argv[2])
let failed = false

for (const patch of PATCHES) {
  const path = join(dshRoot, patch.file)
  if (!existsSync(path)) {
    console.error(`✗ 文件不存在：${path}`)
    failed = true
    continue
  }
  let content = await readFile(path, 'utf8')
  for (const rep of patch.replacements) {
    const count = content.split(rep.old).length - 1
    if (count === 0) {
      console.error(`✗ [${patch.file}] 锚点未找到：${rep.name}（上游可能重构了这段代码，需手动处理）`)
      failed = true
      continue
    }
    if (count > 1) {
      console.error(`✗ [${patch.file}] 锚点出现 ${count} 次：${rep.name}（无法唯一定位，需手动处理）`)
      failed = true
      continue
    }
    content = content.replace(rep.old, rep.new)
    console.log(`✓ ${rep.name}`)
  }
  await writeFile(path, content, 'utf8')
}

if (failed) {
  console.error('\n部分 patch 未应用，请检查上方 ✗ 项并手动处理。')
  process.exit(1)
}
console.log('\n全部 patch 应用完成。重启 DSH 生效。')
