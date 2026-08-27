# Markdown Editor

A focused Markdown editor for Finch with WeChat Official Account preview, selection-based AI edits, and AI-designed custom styles.

## Use it

1. Open **Markdown Editor** from Finch's right Panel and click the **folder** icon to open a `.md` file.
2. Edit Markdown directly. Use the **save** button or `Cmd/Ctrl+S` to write changes to disk; external file changes refresh automatically.
3. Click the **toggle** button to switch to the WeChat preview. Choose one of bm.md's 8 built-in styles from the **palette** menu.
4. Select text in the editor or preview, describe the desired revision in the popup, and add it to the Finch Composer as precise AI context.
5. Click the **wand** icon to ask Finch AI to design custom CSS based on the bm.md output structure.
6. Use **Copy HTML** to copy inline-styled rich text for the WeChat editor.

## Architecture

The Markdown editor is implemented by this mini tool with CodeMirror 6, not by bm.md. CodeMirror owns Markdown parsing, syntax highlighting, line wrapping, selections, active-line rendering, undo history, and keyboard editing. The Panel integration owns file I/O, selection annotations, save state, toolbar interactions, and preview presentation.

bm.md is only the rendering engine. The mini tool installs the `bmmd` CLI once into its private storage, then sends the current Markdown to `bmmd render --platform wechat`. The returned inline-styled HTML is displayed in a sandboxed iframe. Article content stays local and no long-running bm.md web service is used.

The mini tool is MIT licensed. bm.md / `bmmd` is AGPL-3.0 and is installed separately at runtime rather than bundled into this package.

---

# Markdown 编辑器

一个专注于 Markdown 编辑体验的 Finch 小程序，同时提供微信公众号样式预览、框选文字请求 AI 修改，以及 AI 自定义排版。

## 使用方式

1. 从 Finch 右侧 Panel 打开 **Markdown 编辑器**，点击工具栏「文件夹」图标选择 `.md` 文件。
2. 直接编辑 Markdown；使用工具栏**保存**按钮或 `Cmd/Ctrl+S` 写入磁盘。文件被外部修改时，编辑器会自动刷新。
3. 点击「切换」按钮进入公众号预览，可在「调色板」菜单选择 bm.md 内置的 8 种排版风格。
4. 在编辑器或预览中框选文字，在浮层里描述修改要求，即可把精确上下文加入 Finch Composer。
5. 点击「魔杖」图标，让 Finch AI 基于 bm.md 的输出结构设计自定义 CSS。
6. 使用**复制 HTML**复制带内联样式的富文本，再粘贴到微信公众号编辑器。

## 架构关系

Markdown 编辑器不是 bm.md 内置编辑器，而是小程序内集成的 CodeMirror 6。Markdown 解析、语法高亮、自动换行、选区、当前行、撤销历史和键盘编辑由 CodeMirror 负责；文件读写、选区批注、保存状态、工具栏交互和预览容器由 Finch 小程序负责。

bm.md 只负责渲染。小程序会把 `bmmd` CLI 一次性安装到自己的私有存储目录，然后将当前 Markdown 交给 `bmmd render --platform wechat`；返回的内联样式 HTML 再显示到沙箱 iframe 中。文章内容全程留在本机，也不需要常驻 bm.md Web 服务。

小程序本身采用 MIT 许可证；bm.md / `bmmd` 为 AGPL-3.0，因此运行时独立安装，不直接打包进小程序。
