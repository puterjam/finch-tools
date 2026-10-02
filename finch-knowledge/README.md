# Knowledge Base

A private, local library for Finch. Add documents in the **Knowledge Base** App View and let Finch find relevant passages in conversation with `local_knowledge_search`.

## Use it

1. Open **Knowledge Base** from the mini programs sidebar. Choose a tag on the left (or create one), then select **Add files** in the system file dialog or drag files into the App View. With **All sources** selected, new files go into **Unclassified**; existing files also start there after upgrading.
1. **Asking the assistant:** use the **Knowledge Base** book button in the Composer toolbar, on Home or in a conversation. The button has no document-count badge. Open the menu to see that count, the latest index timestamp among existing documents, **How to ask**, and question templates. A template appends an **editable, unsent question** to the current input without replacing your draft or navigating elsewhere. Edit its placeholders, specify a tag in your question when needed, and send it yourself. An empty library shows **Not indexed yet**, guidance and the article-import template. The App View keeps the magnifier for **Browse passages**; it no longer has an assistant button.

2. Add Markdown (`.md`, `.markdown`), plain text (`.txt`), Word (`.doc`, `.docx`), text-based PDF (`.pdf`), or image files (`.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.tif`, `.tiff`). Images go through local OCR. Scanned PDFs without a text layer cannot be indexed directly; export their pages as images first.
3. The left column manages tags and imports — **All sources** and **Unclassified** stay pinned at the top, while your own tags can be dragged into any order (Alt+↑/↓ does the same from the keyboard) and that order is kept. A new tag appears directly below **Unclassified**, where its input row was, instead of jumping to the bottom of the list. The right column lists files on one line each, sorted by name, date added, or last indexed. Scroll to load another 50 files at a time. A row shows the format icon, the file name, its category as a badge, and the passage count with the indexed date; hovering swaps that status for two actions — open in the file manager, and a menu with **open in file manager**, **set category ›** (a second level listing every category as a checkbox) and **remove**. Clicking the row itself opens that file too. **A file can carry several categories**: the submenu adds and removes them, and each one shows as a badge on the row (a fourth and beyond collapse into a counter). **Unclassified** is not a category you add but the absence of all of them, so ticking it clears the rest. Rename tags freely; deleting a tag takes it off the files that carry it and leaves their other tags alone — only a file that had no other tag moves to **Unclassified**. An empty **Unclassified** is hidden from the tag list and reappears as soon as a file lands in it.
4. Select **Browse passages** for a single search field — no heading, no settings; its placeholder names the tag being searched, and Escape or a click outside closes it. Typing automatically finds indexed passages within the selected tag (or all tags). Each result is two compact lines — the file with its passage number and tag, then the passage windowed on the match with the query's words highlighted. Hover or press ↑/↓ to select a row, then click it (or press Enter) to jump to that file in the list. In conversation, ask Finch about a tag by name: `local_knowledge_search` can list tags and search only that tag. Results include source references, document IDs, and passage numbers. With an explicit request, Finch can also list documents, create, rename (edit) or delete tags, add or remove one tag on a document, and import files from the current workspace (`action=documents|create_tag|rename_tag|delete_tag|tag_document|untag_document|import`). Removing a **document** stays in the App View to avoid accidental loss.
5. `action=delete_tag` never deletes documents. Every file that carried the tag loses it and keeps its other tags, and the reply reports both numbers — how many stopped carrying it, and how many of those landed in **Unclassified** — with their index and managed copies intact. Because that silently re-files a whole batch, a tag that still holds documents is refused once with the count and a `force=true` instruction; an empty tag is removed straight away. **Unclassified** cannot be renamed or deleted — it is the internal default — and `rename_tag` is the tag "edit" (the only field a tag has is its name).
6. `action=import` takes **one file, a whole folder, or several paths in one call**, and can classify as it goes. A folder is read recursively (pass `recursive: false` to read only the folder itself); hidden entries (`.DS_Store`, `.draft.md`) and symlinks are always passed over, and anything that cannot be indexed — wrong type, empty, over 64 MB — is counted in the reply rather than failing the call. Use `paths` for several files that share one tag, or `items` for per-file destinations: after reading the files, send `items: [{"path":"contracts/nda.md","tag":"Contracts"},{"path":"invoices/march.md","tag":"Invoices"}]` to file a batch into categories in a single call. A tag named in `items` is created if it does not exist. One call indexes at most 200 files; a path the caller names directly still reports its own error. Every import keeps a managed copy, exactly like the App View.
7. Hover a file for actions to reveal the indexed file in Finder/file manager, or remove it. Selected, dropped, and Agent-imported files are indexed from managed local copies because sandboxed file inputs cannot expose their original disk path. Agent imports accept regular files in the current workspace only (not symlinks or paths outside it); add files elsewhere through the App View. Removing a file deletes its index and managed copy, never the original.
8. A managed copy keeps the file's own name, so `<library folder>/imports/<tag>/` stays readable — that folder is the tag it was first imported under and does **not** follow later re-tagging, since it is storage rather than a category — `创始人手册-中文版.pdf` is stored under that name. Characters that some platforms reject (`<>:"/\|?*`, control characters) become `_`, names are capped at 120 characters, and a second file with the same name in the same tag is stored as `name (2).pdf`. Where the original name cannot be used, re-importing the same name in the same tag replaces the copy in place.
9. If a document's source file is deleted on disk, its entry is dropped from the index automatically — at startup, when the App View opens, and just before the Agent lists documents. A managed copy that vanished is always treated as deleted, since the library lost its own data. Two situations are deliberately left alone: a file outside the library whose folder is also gone may sit on an unmounted volume, and a library whose `imports/` folder is missing entirely is treated as not fully present rather than as emptied. Deleting a managed copy by hand in Finder is therefore safe and tidy — the stale entry disappears by itself, and the App View reports what it removed.

**Updating an indexed file:** there is no file watcher, so editing a document on disk never re-indexes it by itself. Two paths exist, and which one works depends on where the file came from:

- **Files imported through the Agent** (`action=import`) remember the workspace file they came from. Call `action=sync` — or pick **Refresh changed sources** in the library menu — and every recorded source is re-read: changed ones are re-indexed in place (same document ID, same tag), deleted ones are dropped, and a source whose folder is missing is reported as not reachable and left alone. A source that is unchanged is skipped without rewriting anything.
- **Files added through the App View** (file picker or drag and drop) have no recorded source, because a sandboxed file input cannot expose an original disk path — the index points at the library's own managed copy. To update one, import the changed file again with the same name and tag: identical content is detected and skipped, different content replaces the index. Only then does *Last indexed* move past *Added*.

Nothing runs on a timer: a sync happens when you or the Agent asks for one. Pair `action=sync` with a Finch scheduled task if you want it to happen on a schedule.

**First run:** setup covers the App View until the mandatory engines are in. It installs and verifies the platform's **LanceDB** native engine (a sizeable download) plus the Word/PDF engine, and offers the optional image OCR engine (about 128 MB, skippable — image and document imports need it). Each engine is listed with its own state. Setup leaves by itself the moment the mandatory ones are ready — nobody has to sit and watch the optional OCR engine: it keeps downloading behind a progress hairline in the sidebar footer, and the sidebar menu's **Update runtime** retries it if it fails. The same screen also holds the library's location as one more row: **Choose location…** opens the folder dialog, and the result is decided by the folder itself — a folder that already contains a library is opened, an empty one receives a copy of the current library. There is no create/open choice to make, and the row's check mark turns into a spinner while the switch runs.

Every engine is verified and cached in the mini program's persistent data directory. Indexing and searching run locally afterwards, the index survives mini program updates, and no API key or local model installation is needed.

**Privacy:** files are read locally for indexing. When Finch calls the search tool in an AI conversation, returned passages and their managed-copy paths enter that conversation's model context; a remote model may receive them. The App View's own searches remain local.

**Copies and backups:** Search only needs the saved passages and vectors, but re-indexing and a portable backup need the original source bytes. New imports retain managed copies under `<library folder>/imports/`; older migrated records may still point to external files without copies.

**Where the library lives:** by default everything sits in `~/.finch/extension-data/finch-knowledge/`. Use **Choose location…** in the App View sidebar (or the setup screen's **Choose location…**) to put the library wherever you want — a local folder, a synced drive, or a mounted NAS share. There is no create/open choice to make: the folder decides.

- **A folder that already holds a library** is opened where it lies — for example one restored from a backup, or one synced from another machine. Managed-copy paths are repaired to the folder you opened, and any source that cannot be found is reported.
- **An empty folder** receives a full copy of the current library: catalogue, index and every managed copy are copied in, the stored copy paths are repointed at their new home, the copy is verified against the original, and only then does the app switch. The folder you came from is left completely intact, so you can delete it yourself once you are satisfied.
- **Any other folder** is refused, so a catalogue is never dropped into a folder full of unrelated files.

Engine downloads (`lancedb-engine/`, `anydoc/`, `ocr/`) deliberately stay in Finch's local data directory rather than travelling with the library, so a library on a network share never has to load a native binary over the network; they are re-downloaded automatically when missing. Copying is a full copy, so a large library takes a while and briefly occupies both locations, and it needs no engine to run — a brand-new library can be relocated while the engines are still downloading. Only one library is active at a time, and imports or edits are paused for the duration of a switch.

**Snapshots:** for a point-in-time archive, select **Back up to a folder** and pick any destination. A backup writes a timestamped, self-contained snapshot folder containing `catalog.sqlite` (tags and document metadata), `vectors.lance/` (the index), `imports/` (managed copies), copies of any external originals still referenced by migrated records, and a `manifest.json` that lists every file with its size and SHA-256 hash. The manifest is written last, so an unfinished snapshot is never mistaken for a valid one, and a `.partial` staging directory is used until the snapshot completes. If `manifest.json` reports missing sources, those originals disappeared before the backup and only their indexed text is recoverable. Snapshots are full copies rather than incremental ones, so delete old ones yourself once the newest is verified.

**Engines and imports:** images need the OCR engine, and `.doc`/`.docx`/`.pdf` need the document engine. When one of them is missing, adding such a file is refused with a note while the engine starts installing in the background — deliberately *not* downloading under the library's write lock, which would freeze every read in the App View until it landed. The library stays browsable while the engine arrives, and the same file imports normally once it is ready.

**File-type icons:** the list draws each file with its format's icon from the [JetBrains icon set](https://github.com/Chad-Bruce/jetbrains-icons) (MIT, with an Apache-2.0 portion — `icons/LICENSE.md` ships with the files). Markdown, text and image icons carry a light and a dark drawing, switched by `prefers-color-scheme`, which follows the theme Finch hands its windows; `.doc`/`.docx` have no icon of their own in that set and use the plain file.

**Typography:** Finch loads Outfit and JetBrains Mono with `@font-face` inside its own window only, so an App View that merely reads `--finch-font-body` falls back to the system font and renders visibly heavier. This tool ships both families (SIL OFL 1.1, see `fonts/`) and repeats Finch's own root settings — `font-synthesis: none`, `antialiased` smoothing, `optimizeLegibility` — so Latin text, paths and code match the host exactly. Chinese glyphs come from the system font on both sides, so that text matches once the rendering settings do.

**Search quality:** the 512-dimensional vectors are locally computed character n-grams. They approximate lexical similarity (including Chinese text), **not** semantic AI embeddings: synonyms and cross-language paraphrases can be missed. This keeps indexing offline and independent of an embedding provider. A vector search always returns its nearest neighbours, however far off they are, so results are filtered down to passages that really contain a word of the query — asking for a name nothing contains now returns nothing rather than ten unrelated passages. When no passage contains the query as written, the search falls back to its two-character runs (so a library that only ever says 知识 still answers 知识库), and the reply reports which words matched, so the App View highlights words that are actually in the text. Latin words get no such fallback: their fragments appear in everything.

Supported native engines: LanceDB on macOS Apple Silicon, Linux x64/arm64 (glibc/musl), and Windows x64/arm64; image OCR has no Intel macOS build. The app keeps managed copies of imported source files, plus extracted text chunks, hashes, paths, and vectors under its persistent data directory. Files are capped at 64 MB and 6 million extracted characters.

---

# 知识库

在 Finch 中建立自己的本地资料库：从侧栏打开 **知识库**，添加资料；随后可以在页面内检索，也可以让 Finch 调用 `local_knowledge_search` 查找片段。

## 使用方法

1. 从左栏选择或新建标签，再点击 **添加资料** 用系统文件选择器批量选择文件，或把文件拖入页面。选中「全部资料」时，新资料归入「未分类」；升级前的资料也会保留并归入「未分类」。
1. **向 AI 提问：**在 Home 或会话输入框的工具栏点击 **知识库** 书本按钮，按钮不显示数量；菜单显示数量、当前资料中最近的索引时间、**如何提问** 与提问模板。选择模板后，**只追加到当前输入框，不覆盖草稿、不跳页、不自动发送**；修改关键词、文件名或链接，需要限定范围时在问题里写明标签，再自行发送。空库显示「尚未索引」、使用引导与在线文章导入模板。资料管理页面已去掉提问按钮，放大镜仍打开 **翻阅资料**（片段检索）。

2. 支持 Markdown（`.md`、`.markdown`）、纯文本（`.txt`）、Word（`.doc`、`.docx`）、含文本层的 PDF（`.pdf`）以及图片（`.png`、`.jpg`、`.jpeg`、`.webp`、`.bmp`、`.tif`、`.tiff`）。图片使用本地 OCR；纯扫描 PDF 没有文本层时，需先将页面导出为图片再导入。
3. 左栏负责添加资料与标签分类：**全部资料**与**未分类**钉在最上方、不可拖动，你自己的标签可以拖成任意顺序（键盘用 Alt+↑/↓ 同样可以），顺序会被保存；新建的标签就出现在**未分类**下方——输入框原来的位置，不会跳到列表底部。右栏每份资料占一行，可按文件名、添加时间、最后索引更新时间排序，滚动时每批加载 50 条。一行依次是格式图标、文件名、类目胶囊，以及右侧的片段数与索引时间；悬停时这几项状态让位给两个操作——在文件管理器中打开，以及一个菜单，含**在文件管理器中打开**、**设置分类 ›**（二级菜单把每个分类列成勾选项）、**移除**；直接点整行也会打开该文件。**一份资料可以同时属于多个分类**：在二级菜单里勾选即添加、取消即移除，行上会显示多个胶囊（第四个起折叠成计数）。**「未分类」不是可以添加的分类，而是「一个分类都没有」**，勾它会清掉其余分类。重命名标签不会影响索引；删除标签只是把它从带它的资料上摘掉，其它分类不受影响——只有「本来就只有这一个分类」的资料会移入**「未分类」**。**「未分类」为空时不显示**，有资料落入时立刻回来。
4. 点击 **翻阅资料** 打开一个只有输入框的检索面板（没有标题与说明，占位提示写明检索范围；Esc 或点击空白处关闭）。输入内容即可自动检索当前标签（或全部资料）。每条结果只占两行——文件（含片段号与标签）加一段摘录，摘录的窗口对准命中位置并**高亮查询词**。鼠标悬停或用 ↑/↓ 选中，点击（或回车）即跳到列表中的那份文件。对话中也可以按标签提问，`local_knowledge_search` 会按标签限定检索范围。用户明确要求时，AI 还可以列出资料、创建、重命名（编辑）或删除标签、给资料**加/减一个标签**，以及导入当前工作目录中的文件（`action=documents|create_tag|rename_tag|delete_tag|tag_document|untag_document|import`）；移除**资料**仍在页面操作，避免误删。
5. `action=delete_tag` 不会删除任何资料：带这个标签的资料都会失去它、其它标签保持不变，返回结果会同时报出两个数字——多少份不再带它、其中多少份因此移入**「未分类」**，索引与托管副本原样保留。因为这会静默改动一整批归类，标签里还有资料时会先拒绝一次、报出数量并要求传 `force=true` 重试；空标签则直接删除。**「未分类」**不能重命名或删除（它是内部默认标签）；标签的"编辑"就是 `rename_tag`——标签只有名称这一个字段。
6. `action=import` 一次可以导入**单个文件、整个文件夹，或同时多个路径**，并且能一边导入一边分类。文件夹默认递归读取（传 `recursive: false` 则只读该层）；隐藏文件（`.DS_Store`、`.draft.md`）与符号链接一律跳过，类型不支持、空文件、超过 64 MB 的会被计数汇报而不会让整次调用失败。多个文件归入同一标签时用 `paths`；要为每一份指定标签就用 `items`——AI 先读文件再分类，一次调用即可把一批资料分别归档，例如 `items: [{"path":"合同/保密协议.md","tag":"合同"},{"path":"发票/三月.md","tag":"发票"}]`，其中不存在的标签会自动创建。单次最多索引 200 份；调用方直接点名的路径仍然会单独报错。AI 导入与页面导入一样保留托管副本。
7. 鼠标悬停资料可在 Finder／文件管理器中定位已索引的副本，或移除资料。沙箱无法获取原始磁盘路径，选择、拖入以及 AI 导入时都会在小程序数据目录保存托管副本。AI 只接受当前工作目录内的普通文件，不接受符号链接或越界路径；其他位置请从页面导入。移除只删除索引和托管副本，不动原文件。
8. 托管副本保留文件本名，`<资料库目录>/imports/<标签>/` 里直接就是可读的名字——该目录是**首次导入时**所在的标签，重新归类不会搬动它（它是存放位置，不是分类本身）——`创始人手册-中文版.pdf` 就以此名保存。某些系统不允许的字符（`<>:"/\|?*` 与控制字符）会替换成 `_`，文件名最长 120 字符；同一标签下重名时存为 `name (2).pdf`。因此重新导入同名文件可在原处替换副本。
9. 源文件在磁盘上被删除后，对应记录会自动从索引中剔除——启动时、打开资料页面时，以及 AI 列出资料之前各检查一次。托管副本消失一定按删除处理，因为那是资料库自己丢了数据。两种情况刻意不动：资料库之外的文件若连所在目录也不存在，可能只是磁盘未挂载；而整个 `imports/` 目录都不在时，视为资料库尚未完整就位，而不是被清空。所以直接在 Finder 里删掉托管副本是安全且干净的——残留记录会自行消失，页面也会提示剔除了哪些。

**更新已索引的资料：**系统没有文件监视器，磁盘上的文件被修改**不会**自动重建索引。能不能自动跟上，取决于这份资料是从哪来的：

- **AI 导入的资料**（`action=import`）会记住它来自工作目录里的哪个文件。调用 `action=sync`（或左栏菜单里的 **刷新已改动的资料**）会重新检查每个记录在案的源文件：内容变了的原地重建索引（资料 ID、标签都不变），被删掉的一并剔除，而所在目录也不存在（可能未挂载）的会列为「暂时无法访问」并保留；内容没变的直接跳过，不会重写副本。
- **页面添加的资料**（文件选择器或拖拽）没有源路径记录——沙箱里的文件输入无法暴露原始磁盘路径，索引指向的是资料库自己的托管副本。要更新，就把改好的**同名文件在同一标签下再导入一次**：内容相同会被识别并跳过，内容不同则替换索引。只有这时「索引于」才会晚于「添加于」。

没有任何定时器：同步只在你自己或 AI 主动调用时发生。想让它按计划执行，可以把 `action=sync` 交给 Finch 的定时任务。

****首次使用：**在必需引擎装好之前，初始化界面会覆盖整个资料页面。它会下载并校验对应平台的 **LanceDB** 原生引擎（体积较大）与 Word/PDF 解析引擎，并提供可选的图片 OCR 引擎（约 128 MB，可先跳过——导入图片和文档时才需要）。每个引擎各占一行、各自显示状态。必需的都就绪后，初始化界面会**自动让开**——不必守着可选的 OCR 下载，它在左栏底部的进度细线后继续；万一失败，左栏菜单的 **更新运行环境** 可以重试。同一屏里，资料库位置也作为一行出现：点 **选择位置…** 打开目录对话框，结果由目录自己决定——里面已有资料库就直接打开，空目录则把当前资料库复制过去。不需要用户先想清楚是"新建"还是"打开"，切换过程中该行的对勾会变成转圈。

所有引擎都会校验后缓存在小程序持久数据目录。此后建索引与检索均在本机运行；不需要 API Key，也无需预先安装嵌入模型；更新小程序不会清空索引。

**隐私边界：**建索引时资料仅在本机读取。Finch 在 AI 对话中调用检索工具时，返回的片段与来源路径会进入该对话的模型上下文；若使用远程模型，这些片段可能发送给模型服务。仅在 App View 内检索不会把结果交给 AI。

**副本与备份：**仅检索时，已保存的片段和向量就够用；要重新索引或做可移植备份，仍需要原始文件内容。新导入的副本保存在 `<资料库目录>/imports/`；早期迁移的资料可能只保留外部路径，并没有对应副本。

**资料库位置：**默认位于 `~/.finch/extension-data/finch-knowledge/`。用资料页面左栏的 **选择位置…**（初始化页里的同名按钮也一样）可以把资料库放到任意位置——本地目录、同步盘或已挂载的 NAS。**不需要先想清楚是"新建"还是"打开"，由目录自己决定**：

- **目录里已有资料库** → 就地打开，例如从备份恢复的、或从其他机器同步过来的。托管副本路径会自动修正，找不到的源文件会明确列出。
- **空目录** → 把当前资料库完整复制过去：目录库、索引与全部托管副本一并拷入，改写记录中的副本路径，与原始资料库核对数量，确认无误后才切换。原目录原样保留，你可以确认后再自行删除。
- **其他目录** → 直接拒绝，绝不把目录库随手丢进一个装满无关文件的文件夹。

引擎下载（`lancedb-engine/`、`anydoc/`、`ocr/`）刻意留在 Finch 本机数据目录，不随资料库迁移，这样放在网络盘上的资料库不需要通过网络加载原生程序；缺失时会自动重新下载。复制是完整复制，资料多时耗时较长，且切换期间会短暂占用两份空间；整个复制**不需要引擎参与**——全新的资料库可以在引擎仍在下载时就换好位置。同一时间只有一个生效的资料库，切换过程中会暂停导入与修改。

**快照：**需要某个时间点的归档时，点击 **备份到指定目录** 并选择目标位置。快照是一个带时间戳、内容自足的目录，包含 `catalog.sqlite`（标签与资料元数据）、`vectors.lance/`（索引）、`imports/`（托管副本）、迁移资料仍引用的外部原件副本，以及列出每个文件大小与 SHA-256 的 `manifest.json`。清单最后写入，未完成的快照不会被误认为有效备份；完成前一直使用 `.partial` 暂存目录。若清单报告有缺失原件，说明这些原件在备份前已消失，只能保留已索引的文字。每次都是完整复制而非增量，确认最新快照无误后可自行清理旧快照。

**引擎与导入：**图片需要 OCR 引擎，`.doc`/`.docx`/`.pdf` 需要文档解析引擎。缺哪一个时，导入这类文件会被拒绝并说明原因，同时在后台开始安装——而**不是**在资料库的写锁里下载：那会让 App View 里所有读取一直卡在加载状态，直到下载完成。安装期间资料库照常可用，装好后重新导入即可。

**文件类型图标：**列表里每份资料用该格式的图标，取自 [JetBrains 图标集](https://github.com/Chad-Bruce/jetbrains-icons)（MIT，其中一部分为 Apache-2.0——许可文件随包发布在 `icons/LICENSE.md`）。Markdown、纯文本、图片三种图标各带亮/暗两套画法，由 `prefers-color-scheme` 切换，而它跟随 Finch 给窗口设定的主题；`.doc`/`.docx` 在该图标集里没有专属图标，使用通用文件图标。

**字体一致性：**Finch 的 Outfit 与 JetBrains Mono 只在它自己的窗口里用 `@font-face` 注册，所以只引用 `--finch-font-body` 的 App View 会悄悄退回系统字体、看起来更粗。本工具自带这两套字体（SIL OFL 1.1，见 `fonts/`），并复刻 Finch 根元素的渲染设置——`font-synthesis: none`、`antialiased` 平滑、`optimizeLegibility`——英文、路径与代码因此与主界面完全一致；中文两侧都来自系统字体，渲染设置一致后就对上了。

**检索能力：**512 维向量由本地字符 n-gram 生成，是词面近似检索，**不是语义 AI 嵌入**；同义词、跨语言改写可能检索不到。这样可以不依赖云端嵌入服务。

向量检索永远会返回「最近的」若干行——哪怕它们离得很远，所以结果会先筛掉**没有真正包含查询词**的片段：库里没有的名字，现在返回空，而不是十条无关内容。整句确实查不到时，会退一步用其中的**两字组合**再找（库里只写过「知识」时，搜「知识库」也能命中），并在结果里回报**实际命中的词**，让高亮只标真正在文本里的字。英文词不做这种回退——它的两字母片段在任何文本里都能撞上。

LanceDB 引擎支持 Apple Silicon Mac、Linux x64/arm64（glibc/musl）、Windows x64/arm64；图片 OCR 暂不支持 Intel Mac。索引存提取文字片段、文件哈希、托管副本路径与向量，并在小程序数据目录保留导入文件的副本；单文件最多 64 MB，提取文本最多 600 万字符。
