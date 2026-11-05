# Knowledge Base

Search documents where they already live. Choose a local directory, keep its folder structure, and organize documents with independent tags.

## Install

```bash
npx @finchtoys/minitools add finch-knowledge
```

Enable **Knowledge Base** in Finch’s Toolcase, then open it from the sidebar.

For a local offline installer, run `npm run pack:fapp` from this package directory (Node.js required). It builds the runtime files and creates `../finch-knowledge-<version>-fixed.fapp` without replacing an existing file. ZIP entries always use `/`, including on Windows. Double-click the package or drag it into Finch’s main window, confirm installation, then review permissions and enable it in Toolcase.

## Set up your library

The setup page shows three local engines and your source directory together. Search and document engines prepare automatically; choose a directory with the system folder picker while they run. Once these required engines are ready and a directory is selected, click **Enter Knowledge Base**. OCR is prepared silently in the background on the first image and does not block entry; that image continues automatically after preparation. Progress and failures remain visible. Empty and populated directories are both accepted; no source index is created before your choice.

- An existing `.knowledge/` opens that directory’s library.
- Otherwise, `.knowledge/` is created for its catalogue, tags and search index.
- Files stay in their original locations. Switching directories never copies the previous library into the next one.
- Downloadable engines remain in Finch’s local cache, not your source directory.
- On Windows, creating or opening a local library automatically marks its `.knowledge/` folder as Hidden, without changing source files or their attributes. macOS/Linux already hide dot-prefixed folders. File managers can still show it when **Show hidden items** is enabled; an attribute-permission failure does not prevent indexing.

Each time a directory is opened, Knowledge Base checks it in the background: new files are indexed, changed files are refreshed, and confirmed missing files are removed from the index. Files that cannot be read, or whose parent directory is unavailable, keep their previous indexes and are reported. Hidden files, symbolic links and `.knowledge/` are skipped.

## Switch knowledge bases

Click anywhere on the bottom-left library card (except its scan button) and choose **Add knowledge base…** to select another source directory. Each directory stays in a compact list showing only its friendly name; hover for the source path. Click a library to switch; the current library is checked, and the list and selection are remembered after restart. Your previous single-library selection is kept automatically.

Hover or focus a library row to reveal its compact pencil and remove buttons. The pencil changes that row into an input: **Enter** saves, **Esc** cancels, and a failed save retains your draft. No rename dialog opens and the source directory is never renamed. The trailing status distinguishes checking, accessible, offline and unavailable folders; it is refreshed in the background and does not claim the content is indexed. Touch devices show both status and actions. Use its remove button to open a confirmation: **Also delete the index and tags** is off by default. Without it, only the registration is removed and adding the folder again reuses its index. With it, the owned index and tags go to the system trash after indexing has stopped and its handles have closed; source files and shared engine caches stay untouched. Unsafe, shared or unidentifiable indexes are not removed. If trash cleanup fails, a warning explains that the index was retained where possible. Removing the current library clears its view; choose another registered library from the setup selector. Removed entries do not return after restart.

Browsing, tags, indexing and both in-app and assistant searches use **only the currently selected library**. There is no cross-library search. Switching clears the previous library’s filters and search results without copying files or merging indexes. Each local directory retains its own `.knowledge/` and tags; mounted network directories keep independent indexes and tags on this computer. If a drive is unavailable or a switch fails, the current usable library remains selected and the unavailable entry stays registered for a later retry.

### Mounted SMB/NAS and network folders

Mount or map the share in your operating system first, then add its folder through the same library picker. Windows UNC paths and mapped network drives, macOS SMB/NFS mounts, and Linux CIFS/NFS mounts are detected automatically. A local disk or USB drive continues using its existing `.knowledge/`.

For a network source, **no index or tags are written to the share**. Each selected remote directory has a separate index under Finch’s local mini-program data (`remote/<opaque-id>/`). Reopening the same share subdirectory reuses its index; another share or subdirectory gets a different one. Reusing a mapped drive letter for another share does not reuse the previous share’s index. The footer explains when an index is local, and the assistant’s library information reports its location.

The share must already be mounted and readable; this tool does not log in, mount shares, or store credentials. An interrupted scan never treats an unavailable root as an empty library. Reconnect and retry to continue; this is not a file backup or a guaranteed offline browsing mode. Existing `.knowledge/` data on a network share is left untouched, not opened, copied or automatically migrated: the first local scan rebuilds its index, and tags on the old share are not imported.

## Use your documents

Pages use the existing catalogue before checking source availability, content hashes or vector coverage. Refreshing the same library keeps its rows and reading position until the replacement arrives; verification updates individual rows in the background. File size and modified time initially use cached metadata, or remain unknown until checked. Seeing a file is not proof that its content is indexed. Discovery publishes bounded batches before content indexing. All six list sort orders and forward/backward pagination use indexed SQL catalogue queries; the persistent content-job queue remains future work. A missing source and an unavailable drive/share have different, actionable messages, and neither notice deletes cached records.

- Manage source files in your system file manager. Use **Open source folder** to get there, then **Scan and update** to reconcile indexes.
- Scanning is progressive: discovered files appear as **Pending**, smaller files are processed first, and each committed file is searchable immediately. The list refreshes in batches without clearing it or resetting your reading position. Existing searchable versions stay available until a replacement commits. While scanning, the same button becomes **Pause indexing**: it stops after the current file, keeps completed work, and stays paused across restarts. Click **Scan and update** to continue; unchanged committed files reuse their indexes. Pending files count toward source totals, not the issue filter. Closing the view does not stop a scan. PDF/image extraction is unchanged in this release.
- Knowledge Base manages indexes and tags, never original files: it cannot import copies, save web pages, create Markdown, rename, move, delete or back up source files.
- Browse **Source folders** at the top of the sidebar. After scanning, the tree mirrors the source structure, including empty folders and folders containing only unsupported files; private/hidden and system folders remain excluded. **All sources** shows and counts every unique source file, including unsupported, empty, unrecognized and failed files. **Not indexed / issues** filters those exceptions from the same total, never counting an old index and its failed update twice. Ordinary folder/tag lists and their counts include only indexed or pending supported files. All sources also includes files directly in the root folder. Selecting a folder includes its subfolders; search still uses only searchable indexed content.
- Choose **Not indexed / issues** in the sidebar to see unsupported formats, empty files, unrecognized images and processing failures—even files that never had an index. This built-in filter is a peer of the top-level source folders and is mutually exclusive with directory and tag selections. Reasons appear on one line in the existing **Index status** column; long text is truncated, with the full reason available on hover. Row heights remain unchanged. Scan again after fixing a file; resolved or confirmed removed entries disappear automatically. Unavailable subtrees keep their last known records.
- **Tags** live below the folders. Only user-created tags appear here. Hovering or focusing a tag replaces its count with rename/delete actions without shifting the label. Apply one or more tags from the **Tags** context submenu; its checkboxes stay open without instructional text. For files, choose **Tags → New tag** from the context menu; creating a tag is never a separate top-level file action. The tag section also has a right-click creation shortcut. Context menus and tag submenus open to the right by default and flip left near the window edge. Click the dot before a tag to open its color plane and hue strip directly—no hover-only color button, large preview, or second popup. HEX input and presets stay synchronized; cancel leaves the tag unchanged, and Default restores gray. Tags do not move files or duplicate their search indexes.
- Search a tag with the magnifier, or use the book button in chat to draft a question for your assistant.
- Ask the assistant to index a new file or scan the directory after edits. Tool paths are relative to the selected knowledge directory, not the chat’s working directory.

The directory is the source of truth. Scanning follows moved folders, removes confirmed obsolete paths, and repairs duplicate old/new mappings. Uniquely identifiable moved files keep their document IDs and tags. Unreadable locations remain indexed until absence can be confirmed. Empty files and sources without searchable text stay out of the search index; their reasons remain available in **Not indexed / issues**, without exception toasts. Original files are never changed.

Drag the boundary between the sidebar and document list to resize the sidebar between **220 and 420 px**. The two panes have a compact **8 px** gap; the resize guide disappears immediately after release, even when the pointer stays over it. Your width is remembered; double-click resets it, and arrow keys also resize. Smaller windows tighten the upper limit to preserve room for documents; narrow views stack vertically.

New and renamed tags use a padded, rounded input row with a neutral fill, not an isolated underline. Opening a system folder clears temporary row highlights and actions when Finch loses focus; returning does not replay stale hover, and editing drafts are preserved.

Opening the library triggers an automatic scan only when the directory has not been scanned within the last **30 minutes**. This interval is remembered per directory across reloads/restarts. **Scan and update** and assistant-requested scans remain available at any time. Completed scans show only **Scan finished**; there is no warning triangle or per-file notice popup.

Folders get the remaining sidebar space. Tags retain a 160 px minimum area when space permits, reduced in short sidebars, and grow with their content up to a capped height; each list scrolls independently. The empty-tag guide is centered in that area rather than squeezed against the footer. Scrollbars appear only on hover or while scrolling, then fade after scrolling stops. Sidebar scrollbars use the existing right padding rather than narrowing tag/folder rows; file columns stay aligned.

Scan completion appears briefly at the top center and dismisses automatically, never at the bottom. System directories such as `$RECYCLE.BIN` and `System Volume Information` are silently skipped. The trailing status/actions slot has no visible heading. It shows index status at rest and switches to file actions on hover or keyboard focus without moving other columns. Unassigned files have no placeholder badge.

The top-right **Settings** menu contains scanning, runtime checks, opening the source folder and **Hide unsupported files**. This display preference is remembered after restart; it filters before pagination and updates the visible totals without deleting files or index records. The footer card adds/switches libraries; its separate refresh button scans or pauses indexing. Hover or focus a source folder to open it directly without shifting its name or count. Empty lists use a directory-aware guide; empty tag scopes and active scans have separate messages, without duplicate action buttons.

## File details and search

Click a tag badge in a file row to switch directly to that tag, just like the sidebar; this filters the list without opening the file or modifying its tags.

The list shows **Name, Date modified, Type and Size**, followed by an unlabeled status/actions slot. Modification dates and sizes come from the original files, not their indexes. Click a column heading again to reverse sorting across the current folder/tag, including later pages. Unavailable attributes show a dash. Narrow panes hide secondary columns; hover a row for its complete details.

An empty search shows only a short prompt. Results appear after typing; no matches get a separate suggestion to try other keywords.

## Document states

Each row shows one actionable state: **Processing**, **Indexed**, **Update needed**, **Index needed**, **Incomplete index**, **Processing failed**, **Source missing**, **Unavailable**, or **Not checked**. Hover for the cause and passage coverage. A complete index is not enough to show Indexed: the source must still match it. Failed updates retain previous passages; failure details survive reopening. Scanning repairs missing/incomplete passages even when the original is unchanged. Status changes patch rows without resetting scroll.

## Existing installations

Use your filesystem backup software for originals. Knowledge Base has no source-copy or backup route; its catalogue, vectors and tags live in `.knowledge/`.

Current `.knowledge` indexes, tags and colors are retained. When an older catalogue cannot be read, the entire index directory is moved to `.knowledge-backup-<time>-<id>` beside the source directory's new `.knowledge` index. Original documents and historical managed copies remain untouched. The new index is rescanned; old tags are not migrated. Newer-format or corrupt databases are not automatically replaced.

Switching libraries interrupts the previous library's search and indexing work. The new library does not wait for slow native reads to finish; old results are discarded and native handles are released safely afterward.

## Supported files and privacy

Markdown, plain text, Word, Excel (`.xls` / `.xlsx`), PowerPoint (`.ppt` / `.pptx`), PDFs with a text layer, and images; up to **200 MB** per file. Scanned PDFs need a text layer or separately exported images for OCR. Supported platforms: Apple Silicon macOS, Linux x64/arm64, Windows x64/arm64.

Click a file row to use Finch's built-in document preview for text, PDF and Office files; older hosts fall back to the file manager. Images use the image viewer. The row's folder button reveals the original, including unsupported files; this action is not duplicated in the row menu.

Search is **lexical, not semantic**: use words that appear in your documents. Indexing and page searches stay local. When the assistant retrieves passages, their contents and original paths enter the conversation and may be sent to your selected model provider.

---

# 知识库

直接检索已有目录中的资料，保持原来的目录结构，用独立标签整理资料。

## 安装

```bash
npx @finchtoys/minitools add finch-knowledge
```

在 Finch 工具箱启用 **知识库**，从侧栏打开。

需要本地离线安装包时，在本包目录运行 `npm run pack:fapp`（需要 Node.js）。命令会先构建运行文件，再生成 `../finch-knowledge-<版本>-fixed.fapp`，不会覆盖已有文件。包内路径在 Windows 上也统一使用 `/`。双击安装包或拖入 Finch 主窗口，确认安装后，在工具箱审查权限并启用。

## 一次完成准备

初始化页同时显示三个引擎和资料目录。检索与文档引擎自动准备，期间也能通过**系统文件夹选择器**选择资料目录，不需要手输路径。OCR 标记为按需加载，首次处理图片时才在后台准备，准备后自动继续当前识别，不弹窗口；进度与失败原因仍可查看。

**检索、文档引擎就绪＋目录已选定**后，点击 **进入知识库**。空目录和已有资料的目录都可以；选定前不会在资料目录建立索引。

- 有 `.knowledge/`：打开该目录已有的知识库。
- 没有 `.knowledge/`：创建它，用来保存数据库、标签和检索索引。
- 文件保持原位；切换目录不会把旧库复制进新目录。
- 引擎下载缓存留在 Finch 本机数据目录，不放进资料目录。
- Windows 创建或打开本地知识库时，自动为 `.knowledge/` 文件夹补上「隐藏」属性，不修改原文件或原文件的属性；macOS/Linux 的点号目录本就默认隐藏。文件管理器开启「显示隐藏的项目」后仍能看到；无权设置隐藏属性时不影响索引使用。

每次打开目录，会在后台增量核对：新增文件入索引，修改文件更新索引，确认删除的文件清理索引。文件暂不可读或父目录不可用时保留旧索引，避免误删。跳过隐藏文件、符号链接和 `.knowledge/`。

## 切换知识库

打开左下角知识库菜单，点 **添加知识库…**，通过系统选择器选择另一个资料目录。每个目录会保留在紧凑列表中，只显示知识库名称，悬停可查看源路径；点击即可切换，当前库带勾选标记，列表与当前选择在重启后保留。旧版已选目录会自动加入列表。

悬停或键盘聚焦知识库行时显示小号铅笔与移除按钮。点铅笔直接把原行切换成输入框，**Enter 保存、Esc 取消**，保存失败保留草稿；不弹改名窗口，也不给源文件夹改名。右侧状态区分检查中、可访问、离线与无法访问，后台刷新不打断输入，也不代表内容已完成索引；触屏设备同时显示状态与操作。移除按钮会打开确认框，**同时删除索引和标签**默认不勾选。不勾选只移除列表记录，重新添加仍可复用索引；勾选则在索引任务停止、文件句柄关闭后，将该库的索引和标签移入系统回收站，原资料与共享引擎缓存始终保留。无法安全确认位置或仍被其他库使用的索引不会删除；清理失败会明确提示保留情况。移除当前库会清空其视图，可从初始化页选择其他已登记的库；已移除条目不会在重启后自动回来。

浏览、标签、索引、页面搜索与 AI 检索都**仅针对当前选中的知识库**，不做跨库检索。切换会清除上一库的筛选和搜索结果，不复制文件、不合并索引；每个本地目录继续使用自己的 `.knowledge/` 和标签；网络挂载目录则使用各自独立的本机索引和标签。磁盘暂不可用或切换失败时，保留当前可用知识库，离线目录仍留在列表中以便稍后重试。

### 已挂载的 SMB/NAS 与网络目录

先在操作系统中挂载或映射共享，再通过同一个知识库选择器添加目录。自动识别 Windows UNC 路径与映射网络盘、macOS SMB/NFS 挂载，以及 Linux CIFS/NFS 挂载；本地硬盘和 USB 外接盘继续使用原来的 `.knowledge/`。

网络目录**仅读取，不在共享中写索引或标签**。每个选中的远端目录分别使用 Finch 本机小程序数据目录中的 `remote/<独立标识>/` 索引；重新打开同一共享子目录会复用，换共享或子目录则隔离。同一网络盘符改为映射另一个共享时，不会误用上一共享的索引。左下菜单会说明索引保存在本机，AI 的知识库信息也会显示实际索引位置。

需要共享已挂载且可读；小程序不负责登录、挂载或保存凭据。扫描时根目录断连不会按空库清理索引，恢复连接后可重试；这不是原文件备份，也不承诺完整离线浏览。远端已有的 `.knowledge/` 原样保留，不打开、不复制、不自动迁移；首次本机扫描重新建立索引，旧远端标签不会自动导入。

## 使用资料

分页先显示已有目录清单，不等待源目录可用性、内容哈希或向量覆盖校验。同库刷新保留现有行和阅读位置，新快照到达后才替换，后台核验只更新对应行。大小和修改时间先用缓存，尚无缓存时待核验后补齐；看得到文件不等于内容已索引。发现阶段按有界批次发布，不等待内容索引；六种排序与前后分页均查询 SQL 清单索引，持久内容任务队列尚未实现。源文件缺失与磁盘／共享暂不可访问使用不同的可操作提示，提示本身不删除缓存记录。

- 在系统文件管理器中管理原文件；右上角 **设置 → 打开资料目录** 可直达原目录，完成后点底部卡片的刷新按钮，或 **设置 → 扫描更新**。
- 索引渐进完成：文件清单先显示 **待索引**，优先处理小文件，每完成一份即可检索；列表按小批次更新，不先清空，也不把阅读位置拉回顶部。更新时旧的可检索版本保留到新版本提交。扫描期间原按钮变为 **暂停索引**：当前文件处理完后停下，保留已完成进度，重启后仍保持暂停；再点 **扫描更新** 继续，已完成且未变化的文件复用索引。待处理文件计入文件总数，但不计入异常筛选；关闭页面不停止扫描。本次不改 PDF／图片的文字提取方式。
- 知识库只管理索引与标签，不管理原文件；不提供复制导入、保存网页、新建 Markdown、改名、移动、删除原件或复制备份入口。
- 左侧上方是 **资料目录**：扫描后按源端结构展示，包含空目录、只有不支持文件的目录；私有、隐藏及系统目录仍排除。**全部资料** 显示并计入所有资料，包含不支持格式、空文件、未识别及处理失败的文件，按路径去重；旧索引与同一文件的失败记录不会重复计数。**未索引／异常** 单独筛选其中的异常。普通目录及标签仍只显示、统计已索引或待索引的正常资料。「全部资料」还包含根目录中的文件。选中目录包含其子目录，搜索仍只检索已有可用索引的内容。
- 点侧栏 **未索引／异常**，可查看不支持格式、空文件、图片未识别出文字及处理失败的文件，首次索引失败的文件也会保留记录。它是与一级子目录同级的内置筛选项，与目录、标签选择互斥，不会同时高亮。原因在现有 **索引状态** 列单行显示，过长省略，悬停查看完整原因，不撑高行。处理后重新扫描，已恢复或确认删除的项会自动消失；暂不可访问的子目录保留上次记录。
- 下方的 **标签** 仅显示用户创建的标签，不显示系统占位标签；未打标签的资料仍在「全部资料」中。悬停或键盘聚焦标签时，计数由编辑/删除按钮替换，名称和行宽保持不变。在右键菜单的 **标签** 中独立勾选或取消，菜单保持打开，不再显示多选说明。文件右键菜单中通过 **标签 → 新建标签** 创建，外层不再单列入口；标签区右键也可新建标签。右键菜单和标签子菜单默认向右展开，靠近窗口右边缘时自动向左。点标签名前的色点直接打开色板与色相条，不用悬停找颜色按钮，也没有大块预览或第二层弹窗；HEX 与预设颜色同步，取消不改动标签，默认可恢复灰色；一份资料可带多个标签，不移动文件、不复制索引。
- 用放大镜检索当前标签，或用对话工具栏的书本按钮编辑提问模板。
- 可以请 AI 索引新文件，或在编辑后扫描目录。工具的相对路径以知识库目录为根，不以当前聊天工作目录为根。

目录实际内容是唯一依据。扫描会跟随目录移动，清理确认消失的旧路径，并修复新旧路径重复计数；可唯一识别的移动保留索引标识和标签。无法访问时保留映射，待可确认后再清理。空文件、图片未识别到文字、没有可检索文字不进入检索索引，原因保留在「未索引／异常」列表，不弹异常气泡；原文件始终不变。

左右栏之间可拖动调整左栏宽度，范围为 **220–420px**，两栏间距为 **8px**，松手后分隔线立即隐藏，即使鼠标仍停在原处。会记住调整结果；双击恢复默认，也可用左右方向键调整。窗口较小时会自动收紧上限，为右侧资料列表保留空间；窄窗口保持上下排列。

新建和重命名标签使用带留白、浅底和完整圆角边框的输入行，不再只有一条下划线。打开系统文件夹导致 Finch 失焦时，临时行高亮和操作状态会清除；切回不会恢复旧悬停，编辑中的文字仍保留。

打开知识库时，同一目录 **30 分钟内不重复自动扫描**，记录在重开或重启后仍有效；手动点 **扫描更新** 或让 AI 主动扫描不受限制。扫描结束只提示 **扫描完成**，不再显示三角警告或逐项异常弹层。

目录占用侧栏的主要空间，标签区在空间足够时保留 160px 最小高度，较短侧栏随可用空间收紧，按内容增长并限制最高高度，两个列表独立滚动；没有标签时提示居中，不再挤在底栏上方，空目录也保留简洁引导。滚动条只在悬停或滚动时显示，停止后自动隐藏；侧栏滚动条放入原有右侧留白，不挤压目录、标签和计数，文件信息列也保持对齐。

扫描完成统一在顶部居中短暂提示，几秒后自动消失，不在底部显示；`$RECYCLE.BIN`、`System Volume Information` 等系统目录静默跳过。末尾共用槽不显示表头文字，平时显示索引状态，悬停或键盘聚焦时切换为操作按钮，不挤动其他列；未打标签文件不显示占位标签。

右上角 **设置** 收纳扫描、运行环境检测、打开资料目录与 **隐藏不支持的文件**。过滤偏好重启后保留，分页与可见计数同步变化，不删除原文件或索引记录。左下知识库卡片整块点击可添加／切换库，卡片右侧的刷新按钮用于扫描或暂停。目录行悬停或键盘聚焦时显示打开目录按钮，名称和计数位置保持不变。空库显示目录与操作指引，无资料的标签、加载和扫描中分别提示，不再重复放置操作按钮。

## 文件信息与搜索

点击文件行中的标签可直接切换到该标签，效果与侧栏一致；只切换筛选，不打开文件，也不改变它的标签。

列表显示 **文件名、修改日期、类型、大小、索引状态**。修改日期与大小读取原文件属性，不是索引的日期或体积。点击列头排序，再点切换升降序；排序覆盖当前目录或标签的全部资料，包含后续页面。无法读取的属性显示横线；窄栏自动隐藏次要列，悬停文件行可看完整信息。

搜索框为空时只显示一行提示，输入后才展示检索结果，未匹配时单独提示换关键词。

## 文件状态

每行显示最重要的一项：**处理中、已检索、待更新、待索引、索引不完整、处理失败、原文件缺失、暂不可访问、待检查**。悬停可查看原因和片段完整度，不显示数据库名称。只有原文件与完整索引一致才标记已检索；失败更新保留旧索引，重新打开仍能看到失败原因。扫描可修复未改动文件的缺失索引，处理进度原位更新，不重置列表滚动。

## 旧版本兼容

原文件请使用系统备份软件备份。知识库不提供复制或备份路由，只在 `.knowledge/` 中维护目录、向量索引与标签。

当前结构的目录索引、标签和颜色继续保留。遇到不兼容的旧版索引时，先将整个索引目录移到同目录下的 `.knowledge-backup-<时间>-<标识>`，再创建新的 `.knowledge` 并重新扫描。原资料和旧托管库中的历史文件均不改动，旧标签不自动迁移。更新版本的结构或损坏数据库不会被自动替换。

切换知识库会中断旧库的检索与索引任务，不再等待耗时的底层读取完成；旧结果丢弃，句柄在后台安全释放。

## 文件类型与隐私

支持 Markdown、纯文本、Word、Excel（`.xls`／`.xlsx`）、PowerPoint（`.ppt`／`.pptx`）、有文本层的 PDF 与图片，单文件不超过 **200 MB**。扫描 PDF 需补文本层，或将页面导出为图片再做 OCR。支持 Apple Silicon Mac、Linux x64/arm64、Windows x64/arm64。

单击文件行可在 Finch 中预览文本、PDF 和 Office 文档；旧宿主无法预览时回落到文件管理器，图片使用图片查看器。悬停文件行的文件夹按钮用于定位原文件，不支持的格式也保留该入口，菜单不再重复列出。

当前是**词法检索，不是语义检索**，请尽量使用资料中出现的词语。索引与页面检索都在本地完成；AI 引用的片段及原文件路径会进入对话，可能发送给所选模型服务商。
