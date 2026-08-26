# WeChat Preview

A Markdown editor and WeChat Official Account style preview in Finch's Panel, with selection-based AI edits and AI-designed custom styles. All actions live in the panel's own toolbar.

## Use it

1. Open **WeChat Preview** from Finch's right Panel and click the **folder** icon to open a `.md` file. The first render downloads and caches the local `bmmd` CLI through npx.
2. Type or paste Markdown directly in the **editor**; it autosaves to the source file a moment after you stop typing. External edits (including from Finch AI) refresh the editor automatically.
3. Click the **toggle** icon to switch to **preview**, rendered as a WeChat article with one of bm.md's 8 built-in styles from the **palette** menu.
4. Select a passage — in either the editor or the preview — to get a compact popup with just an input and a send button. Describe the change and it's added to your Composer draft as precise context for Finch AI.
5. Click the **wand** icon to ask Finch AI to design a **custom layout style** (CSS) inspired by the 8 built-in styles; once generated, it applies to the preview immediately.
6. Use **Copy HTML** to paste inline-styled HTML into the WeChat editor. The **⋯** menu has manual save, re-render, and about.

## Rendering

The mini tool runs `npx -y bmmd render` locally for each preview, without a long-running web service or uploading article content to bm.md's public service. Custom AI-designed styles are passed through bm.md's `--custom-css`, which is inlined together with the base style. bm.md is AGPL-3.0, so its CLI source is not bundled inside this MIT-licensed mini tool; npx downloads it into the user's local cache on first use.

---

# 公众号预览

在 Finch 右侧 Panel 中编辑 Markdown 并预览为微信公众号文章样式，支持框选文字请求 AI 修改、以及 AI 设计自定义排版风格。全部操作都在面板自带的工具栏上。

## 使用方式

1. 从 Finch 右侧 Panel 打开 **公众号预览**，点击工具栏「文件夹」图标打开一个 `.md` 文件；首次渲染会经 npx 下载并缓存本机 `bmmd` CLI。
2. 直接在**编辑器**中输入或粘贴 Markdown；停止输入片刻后会自动保存到源文件。外部改动（包括 Finch AI 的修改）会自动刷新编辑器内容。
3. 点击「切换」图标进入**预览**，以微信公众号样式渲染，可在「调色板」菜单里选择 bm.md 内置的 8 种排版风格。
4. 在编辑器或预览中框选一段文字，会弹出一个极简的小浮层——只有一个输入框和一个发送按钮。描述你想要的修改，即可作为精确上下文加入 Composer 草稿，交给 Finch AI 处理。
5. 点击「魔杖」图标，可请 Finch AI 参考 8 种内置风格**设计一套自定义排版 CSS**；生成后会立即应用到预览。
6. 使用 **复制 HTML** 将内联样式 HTML 粘贴至公众号编辑器；「⋯」菜单里还有手动保存、重新渲染与关于信息。

## 渲染说明

本小程序每次预览在本机执行 `npx -y bmmd render`：无需常驻 Web 服务，也不会将文章内容上传到 bm.md 公共服务。AI 设计的自定义风格通过 bm.md 的 `--custom-css` 传入，与基础风格一起内联渲染。`bm.md` 仓库采用 AGPL-3.0，CLI 源码不能打包进 MIT 小程序；首次使用时由 npx 下载到用户本机缓存。
