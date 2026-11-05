# finch-knowledge 当前架构梳理

基于 2026-10-30 工作区源码，包版本 0.25.2，最低宿主版本 1.7.0。本次仅静态阅读源码与测试，不修改运行代码、不安装引擎、不执行测试；以下风险是代码审阅发现，未作为运行时复现结论。

## 1. 产品与技术定位

当前是「本地资料管理 + 本地词法检索 + 宿主 AI 问答入口」，不是独立的语义 RAG 服务。

- 页面负责资料导入、分类、浏览、片段检索、备份与更换资料库位置。
- AI 通过统一工具获取片段，再用当前会话模型组织答案；插件不自己调用聊天模型。
- 没有语义 embedding 模型、reranker 或问答服务。`vectorize()` 是本地字符 n-gram 特征哈希。
- 索引、OCR 与页面搜索在本地；AI 检索返回的内容及来源路径会进入会话。
- 一个安装实例当前打开一个资料库；并非按 Space 分库。工作区边界主要限制 AI 文件导入，检索针对当前资料库。

## 2. 总体链路

```text
侧栏 App View（view.html / view.ts / view.css）
  ↕ requestId + postMessage 请求/响应、变更广播
activate(ctx) / index.ts
  ├─ 页面消息路由、AI 工具路由、资料库切换
  ├─ EnvironmentManager：引擎探测、安装与状态广播
  ├─ BackupGate：普通写入与备份/迁移互斥
  └─ KnowledgeStore
       ├─ SQLite：文档、标签、多对多关系
       ├─ LanceDB：按标签分表的片段与 512 维向量
       ├─ imports/：托管原文件副本
       └─ 文本提取：文本直读 / AnyDoc / OCR

输入框 book 按钮 → 写入可编辑提问模板 → 用户发送
  → 当前会话 AI → local_knowledge_search → 检索片段 → AI 回答
```

## 3. 模块职责

| 模块 | 当前职责 |
|---|---|
| `src/index.ts` | 约 864 行；启动、共享状态、资料库切换、引擎安装、页面消息、AI action、同步与错误翻译的综合入口 |
| `src/store.ts` | SQLite schema v6、历史迁移、托管路径、提取与分块、向量化、标签操作、索引写入、搜索、快照 |
| `src/view.ts` | 约 1400 行；原生 DOM 页面、全局状态、分类与菜单、列表分页、搜索、上传、环境向导、备份及桥接 |
| `src/uploads.ts` | 分块写 staging、大小校验、替换旧副本、失败时恢复文件 |
| `src/tool-import.ts` | 工作区边界检查、递归展开目录、批量限制、复用上传通道 |
| `src/article.ts` | HTTP 抓取、HTML 启发式去噪与 Markdown 提取、可疑内容标记 |
| `src/library.ts` | 检查、复制或接管资料库、重写 SQLite 中的托管路径 |
| `src/backup.ts` / `backup-gate.ts` | 备份快照、清单/校验及并发准入 |
| `src/environment.ts` | 引擎生命周期管理，必需/可选步骤、失败重试、共享安装任务 |
| `*-engine.ts` / `ocr-runner.ts` | 下载、校验、缓存、加载原生引擎与运行 OCR |
| `src/composer.ts` | 提问模板、资料数与最后索引时间；不直接启动 AI 回合 |
| `src/snippet.ts` | 检索词拆分、弱匹配候选、命中摘要与高亮 |
| `src/preview.ts` / `scope.ts` | 原生预览路由与页面分类范围辅助逻辑 |

## 4. 数据模型与磁盘布局

```text
ctx.storagePath/
  catalog.sqlite             # 默认资料库目录
  vectors.lance/
  imports/<首次导入标签 ID>/<文件名>
  imports/.staging/
  lancedb-engine/0.39.0/...
  anydoc/...
  ocr/...
```

用户可以选择其他资料库目录。数据随库复制，引擎缓存仍留在本机 `ctx.storagePath`。`ctx.storage.libraryRoot` 记录当前资料库位置。

### SQLite

- `tags(id, name, created_at, sort_order)`。
- `documents(id, path, name, hash, added_at, indexed_at, chunks, source_path)`。
- `document_tags(document_id, tag_id, added_at)`。
- “全部资料”是查询范围，不是标签；“未分类”表示没有 document_tags 关系，兼容 ID 为 `default`。
- 文档主要按托管路径识别，同路径且 hash 相同跳过；不是全库按内容 hash 去重。
- 同路径内容更新尽量保留 document ID，但片段 ID 每次重新生成。

### LanceDB

- 未分类表：`passages_v1`。
- 每个标签一张表：`passages_tag_<UUID去连字符>`。
- 每条片段携带 document_id、path、name、hash、indexed_at、chunk、text、vector。
- 同一文档属于多个标签时，片段和向量会完整复制到多张表。
- 标签操作因此不只是修改分类关系，也会读写向量库。

## 5. 导入与更新方案

### 页面导入

浏览器 File → 每块 192 KiB base64 → Bridge → UploadReceiver → staging → 托管文件 → KnowledgeStore.importFile。

单文件最大 200 MiB；同一首次导入目录下同名文件会被视为替换。替换前备份旧文件，索引失败时恢复文件。浏览器拿不到可信本地原始路径，因而不记录 source_path。

### AI 导入

支持单文件、多个路径、递归目录和逐文件指定标签；单批最多 200 个文件。路径必须在调用会话工作区，拒绝符号链接，检查真实路径边界。复用 UploadReceiver 创建托管副本，并额外保存 source_path，供后续 sync 使用。

### 网页与模型整理稿

- `import_url`：Node fetch → 本地启发式提取 → Markdown 托管文件 → 同一索引链。
- `refine=true`：先返回最多 60000 字符供 AI 整理，不立即入库。
- `save_document`：将调用方提供的标题和 Markdown 内容写入库。
- URL 目前主要作为 Markdown 正文中的来源，不是结构化可同步 source 记录。

### 提取与分块

- Markdown/TXT：UTF-8 文本直读。
- DOC/DOCX/文本层 PDF：AnyDoc 0.2.3。
- 图片：ppu-paddle-ocr 6.5.1。
- 扫描 PDF 无自动逐页 OCR 链。
- 提取后最多索引 600 万字符；按 1000 字符切块，重叠 160 字符。
- 未保留结构化章节、页码、段落位置、OCR 坐标等引用定位信息。

### 同步

显式 sync 检查有 source_path 的资料，流式 hash 比较内容：改变则重新导入，删除则移除，路径暂不可达则保留。页面导入依靠重新添加同名文件更新。另有启动/浏览时的托管文件缺失清理，不等于自动监控源文件更新。

## 6. 检索方案

1. NFKC 归一化、转小写、压缩空白。
2. 提取字母/数字 token；短 token 加整词特征，再加字符二元组与三元组。
3. FNV 风格哈希投影到 512 维、有符号累加、L2 归一化。
4. 在目标标签表进行向量近邻检索，每表先取 `limit × 4` 条。
5. 候选必须包含查询词，或者在无完整命中时包含弱匹配字符片段，避免无关最近邻。
6. 汇总后按完整词命中数、弱命中数、向量距离排序，截到 limit（1–20）。

这套方案不需要 embedding API，但理解不了同义词或语义关系。全库查询会遍历所有标签表；多标签文档可能返回重复片段，当前汇总未按 document_id + chunk 去重。

## 7. 宿主接口与构建

- 一个 Agent 工具 `local_knowledge_search`，包含 search、tags、documents、library、environment、import、sync、import_url、save_document、create_tag、rename_tag、delete_tag、tag_document、untag_document。
- 一个 Composer 菜单按钮，一个 application-level App View；没有独立问答 Panel。
- 权限声明为 filesystem readwrite、network、shell、sessions。
- esbuild 分别打包 Node 后端和浏览器前端；LanceDB JS SDK 打进 bundle，原生绑定单独下载并通过 native.cjs 加载。
- AnyDoc、OCR、LanceDB 引擎按需下载并缓存；环境向导中 OCR 可选，不阻塞基本使用。
- package 无运行期 dependencies；TypeScript/SDK 等为 devDependencies。

## 8. 已有测试基础

`npm test` 会先 build，再执行 `node --test tools/*.test.mjs`。已有测试涵盖存储、迁移、标签、多标签、批导入、上传、同步、网页、备份、迁库、环境安装状态、模板、预览、片段及多种页面行为。

本轮只读测试定义，未运行。已有测试可作为重构保护网，但不能据此声称所有路径现已通过或没有缺陷。

## 9. 重构前值得优先核对的问题

### 数据一致性：优先级最高

1. **多标签更新未同步所有索引表。** `importFile()` 内容改变时，只替换本次 tagId 对应表的片段，却保留文档已有的多个标签关系；其他标签表可能继续保留旧内容。sync 也只传第一个标签。应先补多标签更新回归。
2. **元数据、向量索引、文件三方不具备原子提交。** Promise 写队列仅限当前实例；SQLite 事务不包含 LanceDB 和文件。UploadReceiver 的文件恢复不等于索引事务回滚，需要显式可恢复写入协议。
3. **迁库只重写 SQLite path。** LanceDB 片段里冗余保存的 path 没有随迁库更新，而搜索直接返回片段 path；可能出现列表能用、AI 引用仍指旧位置。应验证原目录移走后的搜索来源。
4. **标签切换逻辑存在额外边界。** 例如从未分类通过 setTags 加入标签时没有显式删除旧未分类片段；应审计“无标签→多标签→无标签”的重复与残留。

### 检索与性能

- 标签既是组织维度又是物理分片，造成数据复制、跨表扇出及全库重复命中。
- 固定字符分块易切断章节和表格，缺少精确引用位置。
- 哈希词法向量有碰撞且不提供语义能力；应以检索评测决定保留、替换或混合，不宜仅因使用 LanceDB 就当作语义 RAG。
- 导入提取发生在全局写队列内；多数读取等待 writes，较慢的解析会阻塞列表和搜索。引擎下载虽已移到锁外，解析仍在锁内。

### 模块与产品边界

- index.ts 同时充当装配入口、业务服务和两套接口控制器；view.ts 也集中管理大量状态。
- 前后端各维护消息类型和部分常量，缺少共享的判别联合协议与统一请求校验。
- 网页、工作区文件、浏览器上传的来源与更新规则不同，尚无统一 Source 模型。
- UI 文案有英文内置兜底，需在拆分时保留 i18n 与失联兼容，不宜只搬 DOM。

## 10. 初步重构边界建议（非已确定方案）

先确定产品目标：仅整理工程边界、改善关键词检索，还是升级为语义/混合 RAG。

无论目标选哪条，建议先拆出：

- Source / Document / Passage / Tag 领域模型。
- ImportService：准备、提取、分块、提交，长耗时准备不占全局提交锁。
- CatalogRepository 与 SearchIndex 接口：文档片段单份存储，标签以元数据过滤。
- SearchService：召回、过滤、去重、排序、引用组装。
- LibraryService：切库、迁移、备份、路径解析与修复。
- HostAdapters：AI actions、页面 Bridge、Composer 仅做协议适配。
- 前端按资料列表、分类、搜索、导入与环境状态分模块。

先补齐多标签更新、迁库后引用、失败恢复与重复命中的测试，再改存储布局。保留旧库迁移和回滚方案，避免把代码重排与不可逆数据迁移放在同一步。
