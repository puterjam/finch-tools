# Knowledge Base

Keep documents in Finch, organize them with tags, and find passages locally or ask the assistant to look them up.

## Install

```bash
npx @finchtoys/minitools add finch-knowledge
```

Enable **Knowledge Base** in Finch’s Toolcase. First use downloads the local engines; no extra API key is needed for indexing or search.

## Get started

1. Open **Knowledge Base** from the sidebar. Choose a tag and click **Add files**, or drag files into the page.
2. Use a file’s **Set category** menu to add or remove tags. A file can have several tags.
3. Click the magnifier to search the selected tag, or use the book button in the chat toolbar to draft a question for the assistant.

For example: “Find passages about onboarding in the Product tag and cite the sources.”

The library menu lets you change its location, back it up, or refresh changed sources. Removing a file deletes its library copy and index, not the original.

## Supported files

Markdown, plain text, Word, PDFs with a text layer, and images. Each file can be up to **200 MB**. Export scanned PDF pages as images before importing.

Supported platforms: Apple Silicon macOS, Linux x64/arm64, and Windows x64/arm64.

## Keep in mind

- **Search by keywords.** Search matches wording, not meaning; use terms that appear in your documents.
- **Updates are manual.** Refresh files imported by the assistant from a workspace. For files added through the page, re-import the changed file with the same name and tag.
- **Indexing and page searches stay local.** When the assistant retrieves passages, those passages and source paths enter the conversation and may be sent to your model provider.

---

# 知识库

把资料放进 Finch，用标签整理，在本地查找片段，也可以让 AI 根据资料回答问题。

## 安装

```bash
npx @finchtoys/minitools add finch-knowledge
```

在 Finch 工具箱中启用 **知识库**。首次使用会下载本地运行环境，建索引和检索无需额外 API Key。

## 开始使用

1. 从侧栏打开 **知识库**，选择标签，点击 **添加资料**，或直接把文件拖入页面。
2. 在资料菜单的 **设置分类** 中勾选或取消标签；一份资料可以属于多个分类。
3. 点击放大镜检索当前分类，或点击对话输入框工具栏的书本按钮，选择并编辑提问模板。

例如：「在『产品』标签里查找用户引导相关的片段，并注明来源。」

资料库菜单可更换存放位置、备份或刷新已改动的资料。移除资料只删除库内副本和索引，不会删除原文件。

## 支持的文件

Markdown、纯文本、Word、含文本层的 PDF 和图片。单文件最大 **200 MB**。纯扫描 PDF 请先将页面导出为图片再导入。

支持 Apple Silicon Mac、Linux x64/arm64 和 Windows x64/arm64。

## 使用须知

- **按关键词检索。** 匹配文字而非语义，尽量使用资料中出现的词。
- **修改后需更新。** AI 从工作目录导入的文件可通过刷新更新；页面添加的文件，请在同一标签下重新导入改好的同名文件。
- **索引和页面检索在本地完成。** AI 调用资料时，片段及来源路径会进入对话，可能发送给所用模型的服务商。
