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
| finch-anydoc | anydoc | 0.2.0 | 办公文档转 Markdown 阅读工具，原生引擎（@firecrawl/anydoc-*，锁 0.2.3）首次使用时按需下载并缓存；0.2 起引擎报错带结构化错误码，explainFailure 按码分支；加载成功后自动清理旧版本引擎目录 |
| finch-image-gen | image-gen | 0.5.1 | 对接 OpenAI 图像 API，支持文生图/图生图；API Key 与 API Base URL 都走同一个 Composer 工具栏齿轮按钮（composerActions + ctx.ui.showModalDialog 弹窗直接输入），存于 ctx.storage，读取时优先 exec.secrets.get('OPENAI_API_KEY')（如用户走了 permissions.secrets 官方通道）兜底 ctx.storage；支持单次调用 base_url 覆盖；生成期间用 setInterval 心跳每 4s 调 exec.progress.report 更新耗时文案，避免切出会话再回来进度卡死不动。注：finch.settings.fields 目前在 Toolcase 未渲染，勿用于必须暴露的配置项；ctx.secrets 只读、无 write 方法，需要用户手填的密钥只能靠 permissions.secrets 官方通道或自建 ctx.storage 弹窗 |
| finch-delivery | finch-delivery | 0.1.0 | 交付物记录小程序，用 Panel 卡片画廊展示 AI 生成的文档类产物（md/word/ppt/pdf/excel/web/image），md 有文字缩略预览，支持当前 Session / 全部 Session 筛选、点击跳转原 Session；通过 ctx.ui.delivery.set() 维护侧边栏行，点击打开 panelEntry 声明的 Panel App；数据存 ctx.storage，零权限（不读文件系统） |
