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
| finch-image-gen | image-gen | 0.5.1 | 对接 OpenAI 图像 API，支持文生图/图生图；API Key 与 API Base URL 都走同一个 Composer 工具栏齿轮按钮（composerActions + ctx.ui.showModalDialog 弹窗直接输入），存于 ctx.storage，读取时优先 exec.secrets.get('OPENAI_API_KEY')（如用户走了 permissions.secrets 官方通道）兜底 ctx.storage；支持单次调用 base_url 覆盖；生成期间用 setInterval 心跳每 4s 调 exec.progress.report 更新耗时文案，避免切出会话再回来进度卡死不动。注：finch.settings.fields 目前在 Toolcase 未渲染，勿用于必须暴露的配置项；ctx.secrets 只读、无 write 方法，需要用户手填的密钥只能靠 permissions.secrets 官方通道或自建 ctx.storage 弹窗 |
| finch-delivery | finch-delivery | 0.1.0 | 交付物记录小程序，用 Panel 卡片画廊展示 AI 生成的文档类产物（md/word/ppt/pdf/excel/web/image），md 有文字缩略预览，支持当前 Session / 全部 Session 筛选、点击跳转原 Session；通过 ctx.ui.delivery.set() 维护侧边栏行，点击打开 panelEntry 声明的 Panel App；数据存 ctx.storage，零权限（不读文件系统） |
| finch-multi-agent | multi-agent | 0.2.0 | 一句话目标拆成并行子智能体，就在当前会话里发起：**不用 sessionContainer**，worker 投放为 Space/普通会话，默认 `activity: interactive`（每个 worker 都是用户可打开的普通会话，同批带同一个 `topic` 分组显示；`background: true` 才转成隐藏不打扰）；**没有 Panel/看板 UI**，进度靠工具的 status 文本 + 各 worker 会话本身；编排完全走 ctx.sessions + ctx.artifacts + ctx.collaboration——每份产出 = 不可变快照（带 contentHash），整轮报告 = 带版本号的 Document（走 CAS，冲突显式重取基线重试），依赖边 = 结构化 Handoff，任务 = Task claim/lease（5 分钟续租）；ctx.models 把模糊模型名（键 / provider:modelId / 显示名 / 别名 / 子串）解析成合法 modelKey，解析不到回退应用默认（不报错）；运行状态存 ctx.storagePath 下的 SQLite（`node:sqlite`，Electron 42 / Node 24 内置，零原生依赖，wal + busy_timeout，首次激活需自建 storagePath 目录否则报 unable to open database file）；持久 `onDidReceiveEvent` 监听器驱动调度器（turn.started 记录真实生效模型与排队时长），工具返回后继续在后台推进，重载后用 `waitForTurn` 兜底对账；工具名 `multi_agent_run`，action: dispatch/wait/add/drop/start/status/collect/cancel/list/**models**；**模型选择闭环**：`models` 把 `ctx.models.list()` 透传给 AI（provider 分组 + `provider:model` 键 + instant/supportsThinking/别名标记 + 当前默认），描述里要求「用户点名模型前先调 models，再传真实键，不许凭记忆写模型名」；dispatch/add 的 `model`（整轮）与 `tasks[].model`（单任务）走 matchModel 模糊匹配（键 / provider:modelId / 显示名 / 别名 / 子串），**用户没提模型就不传，直接用默认**；解析成功会把真实 key 写回任务行（让 status 显示真正在用的模型）；解析失败不仅 warn，还在任务行 `model_note` 写明「请求的 X 没匹配上，已改用默认模型」并在结果里显示，绝不静默回退（tasks 表的 model_note 是后加列，用 ALTER TABLE 试错式迁移）；**产品模型是「提问 → 结果」两步**：中间的分派/执行/等待都在一次连续调用链里完成，描述与 systemPrompt 明令「不要汇报机械过程、不要问要我等吗」，跑完一次性给结果；**0.2 起接口原子化**：`add`（往在跑的 run 追加任务；**复用同一 taskKey = 原地替换**，会先掐掉旧回合，靠 `upsertTask`(INSERT OR REPLACE) + advanceRun 的「依赖恢复则解除 blocked」回补，依赖它的下游自动改用新结果）、`drop`（停任务不替换）、`start`（释放 `hold` 的任务），取代 0.1 的 `revise`；`tasks[].hold` 让角色先建好会话（归在发起会话下）但不烧回合，等 `start`；**worker 之间用 `NEED: <任务 id>` 协议互相索要**（worker 提示词教它写这一行；工具把它变成依赖边，对方已交付就 `resumeTaskWithPeer` 把产物补给同一个会话让它接着做，未交付就 park 成 blocked，对方完成后由 un-block 回补 + `startTask` 的 `task.turnId` 分支发「续做」消息而不是重发完整提示词），并记录成 Handoff；**blocked 不再是终态**（TERMINAL_TASK_STATES 只剩 completed/failed/cancelled）——它是「等协调者补东西」的挂起态，否则「索要一个还没创建的角色」会让整轮直接判失败而无法补救；`holdForRun` 新增 `attention` 结果：有任务 blocked 或有未应答卡片时提前返回（用 `reportedAttention` 按签名去重，避免协调者选择继续等时死循环）；`holdForRun` 认 `exec.signal`：用户打断 = 'aborted' 而非失败，run 继续在后台跑，由下一轮决定是 wait 还是 add/drop；**事件处理器必须校验 `task.sessionId === event.sessionId`**——被替换的旧会话迟到的 turn.completed 否则会被算到新任务头上（另一个被 smoke 抓到的真 bug）；`minVersion: 1.6.4` 可在 1.6.4-beta.1 上正常激活；**worker 会话必须全部在 dispatch 时一次性建好**——延迟到后台调度时创建的会话没有工具调用上下文，Finch 不会给它记 parentSessionId，于是会在会话列表里变成一个孤立会话（实测 t4 就是这个问题）；**标题规则**写进 tool description 与 manifest systemPrompt：每个任务的 title 必须是「角色 · 在做什么」（如「竞品调研 · 摸清三家定价」），它就是 worker 会话的标题；**等待全在小程序内部**：dispatch 默认一次调用内等满 540s，每 4s 用 `exec.progress.report` 轮换进度文案（progress.running.1-6 / progress.scope.1-3，i18n 扁平点号 key），文案明令禁止模型 sleep + 循环调 status；**模型在 send 时指定**（minitool-api 0.3.13 起 SessionSendOptions.model 可用，0.3.12 只有 delivery；不传则沿用会话当前模型）——未知/已禁用的 key 会让整条 send 抛错且不入队，所以要 resolve 成合法 key，并在 send 失败时回退到会话默认重试一次，别让 worker 因为模型记账挂掉；设置菜单三级：默认工作模型（已选时灰字显示「模型名 · provider 名」、行图标用该模型品牌 icon）→ provider（icon 用 cloud，与模型品牌图标区分）→ model（icon 直接用 ModelSummary.icon（形如 model:claude），未知品牌兜底 bot；Finch 的品牌图标表在 app.asar 里：le="model:" + 品牌白名单 ["claude","codex","deepseek","doubao","hunyuan","meta","minimax","mistral","moonshot","nvidia","openai","qwen","stepfun","xiaomimimo","zai"]，品牌 SVG 是 asar 内 `<brand>-<hash>.svg`；其中 codex 品牌标是紫色终端徽章，要按用户预期映射成 model:openai 的结形标）；**等待必须外显在工具调用里**：finalizeRun 只在 run 真正终态时才 resolveWaiter，否则 advanceRun 每轮结束都会提前唤醒等待者、dispatch 会在第一批任务刚下发时就返回（已用 tools/smoke.mjs 复现并修复）；工具 description 明令「想拿结果就调 wait，不要停下来问用户」 |
