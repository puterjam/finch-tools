# AGENTS.md · finch-tools 工作区规则

本目录是 Finch 小程序（mini tools / extensions）的多包源码仓库，仓库地址 `github.com/puterjam/finch-tools`。本文件是本空间所有会话自动加载的项目规则。

## 空间定位

- 本空间**只处理 finch-tools 仓库内的事务**：小程序源码、构建、测试、发布。
- 仓库之外的工作（其他项目、运维、日常事务）不在本空间处理，去对应 Space。
- 每个子目录是一个独立 npm 包，一个子目录 = 一个小程序。新小程序在根目录新建子目录。

## 仓库结构约定

```
<pkg>/
  src/          TypeScript 源码（入口 index.ts）
  dist/         构建产物（不入 git，发布前构建）
  i18n/         界面文案多语言，ctx.i18n.t() 读取 i18n/<locale>.json
  skills/       随包分发的内置 skill（如有）
  icon.png      工具图标
  package.json  含 finch manifest（id / name / description / systemPrompt / permissions / activationEvents）
```

- 根 `README.md` 用中英双语列出所有包。
- 包内 `README.md` 随 npm 包发布（在 package.json `files` 里）。

## 开发约定

- TypeScript，开启严格模式；源码与注释用英文，用户可见文案走 i18n。
- **权限最小化**：`permissions.filesystem` / `permissions.network` 默认关闭，shell 按需开启。
- **运行时零依赖**：minitools 不安装 `dependencies`，所有依赖必须在构建期打进产物。
- **`files` 白名单只放运行时产物**：`dist/`、`i18n/`、`skills/`、`icons/`、`icon.png`、`README.md`。`src/`、`tsconfig.json`、`package-lock.json` 一律不发布。
- **运行期数据写 `ctx.storagePath`**（实际落在 `~/.finch/extension-data/<id>/`），不要写进扩展安装目录——安装目录会在 update / remove 时被整体替换。
- 包名用 `finch-<name>` 风格（如 `finch-ego-lite`），manifest `id` 用 kebab-case。
- 所有包 `author.name` 统一为 `PuterJam`（中间无空格），url 为 `https://github.com/puterjam`。

## 构建与发布

1. 修改源码后**必须重新构建**再发布；`dist/` 不入 git。
2. **官方扩展发布必须 esbuild bundle**：tsc 裸产物会报 `Cannot find package`（minitools 不装 dependencies）。构建脚本要确保把依赖完整打包进 `dist/index.js`。
3. 发布前跑 `npx @finchtoys/minitools doctor .` 校验 manifest。
4. **npm 发布交由 agent 执行**；bump version 遵循 semver。
5. 发布后安装到 `~/.finch/extensions` 并在 Toolcase 启用，做一次本地冒烟验证。
6. **改动调度 / 等待这类时序逻辑，必须先跑包内冒烟测试**：`node tools/smoke.mjs`。它是假宿主（自造 ctx + 内存 sessions/artifacts/collaboration），不需要启动 Finch、不花 token，直接调工具的真实 `execute()` 跑完整 dispatch 流程，覆盖「dispatch 是否真的等到整批完成」「worker 会话是否都在工具调用内建好并拿到父会话」「依赖任务是否等上游产物才开跑」。**feat 里最容易出错也最难在真实会话里复现的就是这类时序问题**（例如 finalizeRun 在 run 仍 running 时提前唤醒等待者，导致 dispatch 第 0 秒返回）。正确的做法是先用测试证明它会失败，再修好。

### 本地部署测试必须走 tarball

`minitools add <目录>` 会把整个目录原样复制过去，`src/`、`tsconfig.json`、连同 `node_modules` 里的
devDependencies 全都进了扩展目录（实测 48K 的包会变成 47M），和真实用户装到的东西完全不一样。

本地测试一律先打包再装，确保验证对象就是 npm 上的那份产物：

```bash
npm run build
npm pack --pack-destination /tmp
npx @finchtoys/minitools remove <id>
npx @finchtoys/minitools add /tmp/<package>-<version>.tgz
```

`remove` 不会删除 `~/.finch/extension-data/<id>/`，重装后缓存数据仍在。

## Git 规范

- 提交信息用 Conventional Commits（`feat:` / `fix:` / `chore:` …），一个提交一个原子变更。
- **每个提交必须附带 trailer**，另起一行：
  ```
  Co-authored-by: 帕亚 <noreply@finchwork.app>
  ```

## README 规范

- 用**用户视角**撰写：讲场景与用法，不写技术实现细节。
- 默认**英文完整版在前，中文完整版在后**。

## 当前包状态

| 包 | manifest id | 版本 | 说明 |
|---|---|---|---|
| finch-ego-lite | ego-browser | 0.1.0 | Ego Lite 网页浏览小程序，仅支持 macOS |
| finch-anydoc | anydoc | 0.2.1 | 办公文档转 Markdown 阅读工具，原生引擎（@firecrawl/anydoc-*，锁 0.2.3）首次使用时按需下载并缓存；0.2 起引擎报错带结构化错误码，explainFailure 按码分支；加载成功后自动清理旧版本引擎目录 |
| finch-ocr | ocr | 0.1.0 | 本地离线 OCR，封装 ppu-paddle-ocr 的 standalone binary（GitHub Releases 独立可执行文件，非 npm 包+onnxruntime-node 那 ~258MB 原生依赖路线）；首次调用按 platform/arch 下载对应 slim 版二进制到 ctx.storagePath，用 release asset 的 sha256 digest 校验，macOS 上自动清 xattr 隔离属性；tar.gz/zip 都是纯手写最小解包（无第三方依赖），archive 内文件名是 `ppu-paddle-ocr-<platform>-slim` 而非固定名，按"取唯一文件"而非按名匹配；binary 自身还会在首次 recognize/detect 时下载 OCR 模型到系统缓存目录，这部分下载日志会混进 stdout（不是 doc 说的纯 stderr），parseJson 要从后往前找最后一行 `{`/`[` 开头的行；`recognize --json` 输出 `{text, lines:[[{text,box,confidence}]]}`，`detect --json` 输出裸数组 `[{x,y,width,height}]`，两者 shape 完全不同不要共用同一个类型；引擎版本锁定 6.5.1，暂无 darwin-x64（Intel Mac）构建 |
| finch-image-gen | image-gen | 0.9.0 | 对接 OpenAI 图像 API，支持文生图/图生图/遮罩局部编辑；默认模型 `gpt-image-2.5-sunburst`（精修编辑）/`gpt-image-2.5-flare`（快速日常），模型名走 alias 表（sunburst/flare/gpt-image-2.5 → 全名），**认不出的名字原样透传**，中转站自定义模型名才不会被改写；quality 在 2.5 上多出 `xhigh`/`max`；size 支持任意 `宽x高`，**必须本地先校验**（边长 16 倍数、宽高比 ≤3:1、单边 ≤3840、像素 655360–8294400），否则只能拿到一个看不懂的 400；`background`/`output_format`/`output_compression`/`moderation` 这类新参数**只在调用方显式传了才发**，否则老模型和中转站会因不认识的参数报错；`background=transparent` 遇到 jpeg 自动改回 png；流式预览是**显式 opt-in**（`partial_images`，且仅 n===1），SSE 手写解析，事件名文档没写全，最终图从任何带 `data[]`/`b64_json` 的事件取，一个都没有就退回最后一张预览并在结果里明说，别让已经出图的请求判失败；错误按 `error.code` 分支（`moderation_blocked` 看 `moderation_details.moderation_stage` input/output 给不同建议、`image_generation_user_error` 禁止原样重试），401/403/429 各补一句可操作提示（403 提组织认证）；**设置分两处**：API Key 与 API Base URL 属于「接入配置」，走**工具箱设置菜单**（`contributes.settingsMenu` + `ctx.settingsMenu.register()`，同一个菜单会同时出现在 Toolcase 卡片和会话容器页头，`ctx` 里用 `surface` 区分），同样用 ctx.ui.showModalDialog 弹窗直接输入，存于 ctx.storage；**输入框工具栏按钮只留日常生图默认参数**（默认模型/默认画质/默认尺寸），读取时优先 exec.secrets.get('OPENAI_API_KEY')（如用户走了 permissions.secrets 官方通道）兜底 ctx.storage；默认模型/画质用 select 字段，默认尺寸用 text 字段且**存之前先过 checkSize**，取出来时也要再过一次——存坏了就回退默认值而不是让后续调用全部失败；图标全部得自己带 SVG（`icons/*.svg` + `contributes.iconPacks`/`contributes.icons` + `ext:` 引用，Lucide 直接拿 lucide-static 抽），**`ext:` 引用一律写全限定 `ext:<iconPackId>/<iconId>`**：裸 `ext:<iconId>` 靠「当前图标包」补全，Toolcase 那个 surface 上补不出来，菜单项图标就会维持原样看起来「改了没生效」；侧边栏用 `book-image`、输入框按钮用 `image`、菜单项分别 `cpu-ai`/`paintbrush`/`image-upscale`/`key-round`/`link`；smoke 会断言「每个 `ext:` 引用都在 manifest 里声明且 SVG 文件真的存在」，以及「哪个菜单归属哪项设置」；支持单次调用 base_url 覆盖；生成期间用 setInterval 心跳每 4s 调 exec.progress.report 更新耗时文案，避免切出会话再回来进度卡死不动；界面文案走 i18n（`ctx.i18n.t` 认扁平点号 key）；**默认是最省组合** `gpt-image-2.5-flare` + `quality=low` + `1024x1024`，systemPrompt 里明写「除非用户明说要更好，不要自己升画质/尺寸」，`gpt-image-2.5` 裸名兜底到 flare；**图片库**（appView + appPanel 共用 `src/gallery.html`，逻辑为独立 TS 浏览器 bundle）：单卡封顶 220px、最多 5 列，最短列瀑布流；提示词仅悬停底部渐变显示 2 行，格式尺寸左上、编辑移除右上；移除搜索，标题下分段筛选与成果库一致。编辑是 webview 内 `fixed inset:0` 的全屏 route，不开带固定侧栏的 modal；图片按 stage 实际宽高 fit，工具栏、评论列表在下方；草稿自动保存，后端读改写要排队（单纯 rename 不防丢更新）。`tools/ui-smoke.mjs` 用真实 Chromium + 校验型假 Bridge 回归 280–1600px 陈列、窄 Panel 画线/多评论插入、附件像素证据、失败保留草稿、作用域切换、深色与慢图。记录写 `ctx.storagePath/gallery.json`（tmp+rename 原子写、上限 2000、newest first），`readImageSize()` 直接嗅 PNG/JPEG/WebP 文件头拿**真实像素**——瀑布流要在图片字节加载前拿到宽高比，而 `size:auto` 时请求方根本不知道出图多大；`ctx.ui.onDidOpenPanel` 是拿到 appView 那个 AppPanel 句柄的**唯一**途径（`panel.view==='appView'`），用 livePanels 集合 + broadcastGallery 让新生成实时推到已打开的面板；webview 读不了本地文件，图片字节只能走 data URL 过 postMessage（>12MB 直接拒）；`composer.addContexts` **只在 `view==='session'`/`'home'` 有效**，`appView`/`container` 会 reject，所以插入按钮按 view **直接隐藏**而不是摆个 disabled（舜子：空态入口优先隐藏）；**更正：`image-region.regions` 要用 0..1 归一化坐标，不能乘回像素**；旧 `pixelRegions()` 正是标注插入被拒的原因。0.9 改用自由画线和多条定位评论，原始数据一直保持归一化；将画线和编号点预合成 PNG，走 `annotation.image` + 全部评论 `note/promptText` + 原图地址 `reminder`，不覆盖原文件。`addContexts` 必须在插入按钮的 click 中直接调用，不能先 await 加载/截图；图片与标注字节提前准备；`finch:env` 由平台在 createPanel 后自动下发（各 scope 都带 locale），但仍把自己的 env 兜在业务 payload 里一起发，防旧宿主；build 必须同时 bundle `src/index.ts` 和浏览器入口 `src/gallery.ts`，并复制 `src/gallery.html`、`src/gallery.css` 到 dist；`files` 白名单包含 `dist/`，运行时零依赖；Playwright 仅 devDependency；`tools/smoke.mjs` 用假 ctx + 桩掉 global fetch 断言「哪些参数真的发出去了 / 哪些必须保持省略」、尺寸校验、错误码提示、流式回退，以及图片库记录和整条 panel 消息桥（requestGallery/requestImage/saveNote/deleteRecord），**改参数组装逻辑先跑它**；**appView/appPanel 图标**：IconRef 的裸 Lucide 名只认 Finch 打包的固定集合，`images` 不在里面，侧边栏就变成一个空方块——要把 Lucide 的 SVG 落到 `icons/`，用 `contributes.iconPacks` + `contributes.icons` 注册后引用，且 `files` 白名单必须含 `icons/`（照 finch-delivery 抄）；包根 `icon.png`（300x300 白底）是 Toolcase 卡片图，和入口图标是两套东西，`files` 里列了就得真有其文件。注：finch.settings.fields 目前在 Toolcase 未渲染，要暴露配置项请用 `contributes.settingsMenu` + `ctx.settingsMenu.register()`；ctx.secrets 只读、无 write 方法，需要用户手填的密钥只能靠 permissions.secrets 官方通道或自建 ctx.storage 弹窗 |
| finch-delivery | finch-delivery | 0.1.0 | 交付物记录小程序，用 Panel 卡片画廊展示 AI 生成的文档类产物（md/word/ppt/pdf/excel/web/image），md 有文字缩略预览，支持当前 Session / 全部 Session 筛选、点击跳转原 Session；通过 ctx.ui.delivery.set() 维护侧边栏行，点击打开 panelEntry 声明的 Panel App；数据存 ctx.storage，零权限（不读文件系统） |
| finch-multi-agent | multi-agent | 0.2.1 | 一句话目标拆成并行子智能体，就在当前会话里发起：**不用 sessionContainer**，worker 投放为 Space/普通会话，默认 `activity: interactive`（每个 worker 都是用户可打开的普通会话，同批带同一个 `topic` 分组显示；`background: true` 才转成隐藏不打扰）；**没有 Panel/看板 UI**，进度靠工具的 status 文本 + 各 worker 会话本身；编排完全走 ctx.sessions + ctx.artifacts + ctx.collaboration——每份产出 = 不可变快照（带 contentHash），整轮报告 = 带版本号的 Document（走 CAS，冲突显式重取基线重试），依赖边 = 结构化 Handoff，任务 = Task claim/lease（5 分钟续租）；ctx.models 把模糊模型名（键 / provider:modelId / 显示名 / 别名 / 子串）解析成合法 modelKey，解析不到回退应用默认（不报错）；运行状态存 ctx.storagePath 下的 SQLite（`node:sqlite`，Electron 42 / Node 24 内置，零原生依赖，wal + busy_timeout，首次激活需自建 storagePath 目录否则报 unable to open database file）；持久 `onDidReceiveEvent` 监听器驱动调度器（turn.started 记录真实生效模型与排队时长），工具返回后继续在后台推进，重载后用 `waitForTurn` 兜底对账；工具名 `multi_agent_run`，action: dispatch/wait/add/drop/start/status/collect/cancel/list/**models**；**模型选择闭环**：`models` 把 `ctx.models.list()` 透传给 AI（provider 分组 + `provider:model` 键 + instant/supportsThinking/别名标记 + 当前默认），描述里要求「用户点名模型前先调 models，再传真实键，不许凭记忆写模型名」；dispatch/add 的 `model`（整轮）与 `tasks[].model`（单任务）走 matchModel 模糊匹配（键 / provider:modelId / 显示名 / 别名 / 子串），**用户没提模型就不传，直接用默认**；解析成功会把真实 key 写回任务行（让 status 显示真正在用的模型）；解析失败不仅 warn，还在任务行 `model_note` 写明「请求的 X 没匹配上，已改用默认模型」并在结果里显示，绝不静默回退（tasks 表的 model_note 是后加列，用 ALTER TABLE 试错式迁移）；**产品模型是「提问 → 结果」两步**：中间的分派/执行/等待都在一次连续调用链里完成，描述与 systemPrompt 明令「不要汇报机械过程、不要问要我等吗」，跑完一次性给结果；**0.2 起接口原子化**：`add`（往在跑的 run 追加任务；**复用同一 taskKey = 原地替换**，会先掐掉旧回合，靠 `upsertTask`(INSERT OR REPLACE) + advanceRun 的「依赖恢复则解除 blocked」回补，依赖它的下游自动改用新结果）、`drop`（停任务不替换）、`start`（释放 `hold` 的任务），取代 0.1 的 `revise`；`tasks[].hold` 让角色先建好会话（归在发起会话下）但不烧回合，等 `start`；**worker 之间用 `NEED: <任务 id>` 协议互相索要**（worker 提示词教它写这一行；工具把它变成依赖边，对方已交付就 `resumeTaskWithPeer` 把产物补给同一个会话让它接着做，未交付就 park 成 blocked，对方完成后由 un-block 回补 + `startTask` 的 `task.turnId` 分支发「续做」消息而不是重发完整提示词），并记录成 Handoff；**blocked 不再是终态**（TERMINAL_TASK_STATES 只剩 completed/failed/cancelled）——它是「等协调者补东西」的挂起态，否则「索要一个还没创建的角色」会让整轮直接判失败而无法补救；`holdForRun` 新增 `attention` 结果：有任务 blocked 或有未应答卡片时提前返回（用 `reportedAttention` 按签名去重，避免协调者选择继续等时死循环）；**「只剩 hold 待启动的任务」也必须算 attention**——否则整轮没有可跑的活、`deriveStatus` 又不把 queued 当终态，dispatch 就会干等满 540s 预算（实测用户第一次跑剧本就卡在这里：fe/arch 完成后 qa 一直 hold 着，dispatch 卡了 9 分钟直到人说「卡住了」），现在用 `heldTasks`/`heldDetail`/`nextStart` 文案明确提示 action=start/drop；判定函数是 `needsCoordinator()`（blocked/等待卡片优先，其次「无 running/starting/非 hold 的 queued」），`onlyHeldLeft()` 只用于选文案；**attention 去重必须带上「整轮进度」而不能只看卡住的任务集合**——`reportedAttention` 是「同一个问题不要反复打扰」的机制，但只按卡住任务做签名会把同一条消息在整轮里永久静音：dispatch 先报一次「qa 待启动」（fe/arch 跑完后），协调者接着 add 统稿，统稿也跑完了，此时卡住的还是那个 qa、签名一模一样 → 第二次 attention 被吞掉 → add 那次调用干等满 540s，用户看着「一直在等」只能自己来问（实测用户第三次跑剧本就撞上：dispatch 17:19:04 正常报了 held，add 之后 17:19:21 draft 完成直到 17:20:28 用户开口才继续）；现在签名是 `«已终态数»/«任务总数»#«卡住任务明细»`，整轮往前走一步就会重新报（而原地不动仍然保持安静，不会自旋）；smoke 里对应「a held role is reported again once the run has moved on」；`holdForRun` 认 `exec.signal`：用户打断 = 'aborted' 而非失败，run 继续在后台跑，由下一轮决定是 wait 还是 add/drop；**事件处理器必须校验 `task.sessionId === event.sessionId`**——被替换的旧会话迟到的 turn.completed 否则会被算到新任务头上（另一个被 smoke 抓到的真 bug）；`minVersion: 1.7.0`（ctx.artifacts / ctx.collaboration / ctx.sessions 的 wait 与 listWaits 这一套是 1.7.0 起才齐的；早期误写 1.6.4，在 1.6.4-beta.1 上虽然能激活但能力不完整，0.2.1 起改正）；**worker 会话必须全部在 dispatch 时一次性建好**——延迟到后台调度时创建的会话没有工具调用上下文，Finch 不会给它记 parentSessionId，于是会在会话列表里变成一个孤立会话（实测 t4 就是这个问题）；**幂等键必须按「尝试」生成，不能按任务生成**——宿主把重复的 idempotencyKey 当作「这条是上次的重试」，直接**回放旧回执**（`SessionSendReceipt.state === 'duplicate'`，带的是**旧 turnId**）并且**根本不派发新回合**；被释放的 hold 任务、被 park 后又唤醒的任务都是新尝试，必须换新键（`nextAttemptKey()`，键里带自增序号），否则会出现最隐蔽的一种卡死：任务记成 running 但那是个**已死的旧回合**，永远不会有事件回来，整轮再也不会终态（实测用户第二次跑剧本就撞上：qa 第一轮 16:32 发出 `NEED: draft` 被 park，16:35 draft 完成后重新放行，重发用了同一个键 → 被宿主判为重复、把旧回执还给工具，qa 会话从头到尾只有一轮，任务永远 running）；回执里的 `state: 'duplicate'` 必须显式处理（换键重发一次，仍重复就 failTask 报 `result.noNewTurn`），不能当 accepted 用；**另有兜底对账 `settleStaleTurns(runId, probeMs)`**——`waitForTurn(turnId, { timeoutMs: 1 })` 对已结算的回合会立刻返回，所以在 holdForRun 开头、每 30s、以及 action=status 里都扫一遍，把「回合早已结束但完成事件没到」（重载、崩溃、被吞掉的 send）结算掉，否则这类 run 没有任何事件能把它唤醒，只会白白耗完 540s 预算；**标题规则**写进 tool description 与 manifest systemPrompt：每个任务的 title 必须是「角色 · 在做什么」（如「竞品调研 · 摸清三家定价」），它就是 worker 会话的标题；**等待全在小程序内部**：dispatch 默认一次调用内等满 540s，每 4s 用 `exec.progress.report` 轮换进度文案（progress.running.1-6 / progress.scope.1-3，i18n 扁平点号 key），文案明令禁止模型 sleep + 循环调 status；**模型在 send 时指定**（minitool-api 0.3.13 起 SessionSendOptions.model 可用，0.3.12 只有 delivery；不传则沿用会话当前模型）——未知/已禁用的 key 会让整条 send 抛错且不入队，所以要 resolve 成合法 key，并在 send 失败时回退到会话默认重试一次，别让 worker 因为模型记账挂掉；设置菜单三级：默认工作模型（已选时灰字显示「模型名 · provider 名」、行图标用该模型品牌 icon）→ provider（icon 用 cloud，与模型品牌图标区分）→ model（icon 直接用 ModelSummary.icon（形如 model:claude），未知品牌兜底 bot；Finch 的品牌图标表在 app.asar 里：le="model:" + 品牌白名单 ["claude","codex","deepseek","doubao","hunyuan","meta","minimax","mistral","moonshot","nvidia","openai","qwen","stepfun","xiaomimimo","zai"]，品牌 SVG 是 asar 内 `<brand>-<hash>.svg`；其中 codex 品牌标是紫色终端徽章，要按用户预期映射成 model:openai 的结形标）；**等待必须外显在工具调用里**：finalizeRun 只在 run 真正终态时才 resolveWaiter，否则 advanceRun 每轮结束都会提前唤醒等待者、dispatch 会在第一批任务刚下发时就返回（已用 tools/smoke.mjs 复现并修复）；工具 description 明令「想拿结果就调 wait，不要停下来问用户」 |
