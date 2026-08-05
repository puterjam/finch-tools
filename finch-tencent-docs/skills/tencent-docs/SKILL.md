---
name: tencent-docs
description: 腾讯文档（docs.qq.com）在线文档操作——创建、读取、搜索、编辑在线文档。涉及"新建/创建/编辑/读取/查看/搜索文档"、"云文档"、"腾讯文档"、"docs.qq.com"等需求时使用本 skill。能力：创建智能文档/Word/Excel/PPT/思维导图/流程图/智能表格/收集表，读取与搜索文档，编辑智能表格与在线表格，文件管理（重命名/移动/删除/复制），网页剪藏，OCR 图片识别。
---

# 腾讯文档使用指南

通过 Finch MCP 客户端连接四个腾讯文档服务，全部共享同一个 Token。工具以 `mcp__<服务名>__<工具名>` 形式通过 ToolSearch 发现。

## 四个服务（工具前缀）

| 服务名 | 端点 | 工具前缀 | 用途 |
|---|---|---|---|
| `tencent-docs` | /openapi/mcp | manage.* / create_* / get_content / smartsheet.* / scrape_url / ocr.* | 通用：创建、搜索、读取、管理、智能表格 |
| `slide-mcp` | /api/v6/slide/mcp | slide_* | PPT 精细编辑 |
| `doc-mcp` | /api/v6/doc/mcp | doc.* | Word 文档精细编辑 |
| `sheet-mcp` | /api/v6/sheet/mcp | sheet.* | Excel 表格精细编辑 |

## 鉴权

首次使用调用 `tdocs_auth`（action=start）完成 QQ/微信授权；Token 过期（错误码 400006 / 提示 expired）时重新调用。状态查询用 `tdocs_status`。也可调用 `tdocs_auth` action=set_token 手动粘贴 Token。

## 场景路由

1. **创建文档**（从无到有）：
   - 智能文档/报告/笔记/总结/Markdown → `create_smartcanvas_by_mdx`（mdx 参数直接填 Markdown，向下兼容全部语法）
   - 思维导图 → `create_mind_by_markdown`；流程图 → `create_flowchart_by_mermaid`
   - PPT/幻灯片 → 走 slide 工作流（slide-mcp 的 slide_* 工具）
   - Word → 先 `manage.create_file`（file_type=doc）再 `doc.get_last_operable_pos` + `doc.insert_markdown`
   - Excel → sheet 品类（sheet-mcp）
   - 空白/兜底 → `manage.create_file`
2. **编辑已有文档**：先确认文档类型（`manage.query_file_info` 或链接前缀），**必须用对应品类的工具集**——严禁用 A 品类工具改 B 品类文档（错误码 400016）。
3. **读取文档**：`get_content`（file_id）通用读取；搜索用 `manage.search_file`。
4. **文件管理**：`manage.*`（重命名/移动/删除/复制/权限）；空间/文件夹用 query_space_node / create_space_node / manage.folder_list。
5. **网页剪藏**：用户给 URL → `scrape_url` → `scrape_progress` 轮询（status=2 完成，返回 file_id/file_url）。
6. **OCR**：图片转 Word/Excel 用 ocr.* 工具；本地图片需 base64 传入。
7. **本地文件上云**：用 `manage.async_import` 通路保留原文件结构，不要用 create_* 重新生成。

## 核心规则

- **批量写入**：对同一文档连续 3 次及以上写入，必须用批量接口一次提交（smartsheet.add_records / smartsheet.update_records、sheet.set_range_value / sheet.set_range_value_by_csv），严禁循环单条写入。
- **node_id 即 file_id**：空间节点的 node_id 同时是文档的 file_id。
- **删除节点**：delete_space_node 默认只删当前节点，`remove_type=all` 才递归删除。
- **创建位置**：create_* 支持 parent_id 可指定目录；create_smartcanvas_by_mdx 不支持 parent_id。
- **URL 链接**：一律走 scrape_url 网页剪藏通路，不要用其他方式访问。

## 常见错误码

| 错误码 | 含义 | 处理 |
|---|---|---|
| 400006 | Token 鉴权失败 | 重新授权（tdocs_auth） |
| 400007 | VIP 权限不足 | 引导用户升级 VIP |
| 400008 | 积分不足 | 引导用户购买积分 |
| 400016 | 文档类型不匹配 | 确认类型后换对应品类工具 |
| -32601 / -32603 | 工具或参数错误 | 检查工具名与参数 |

## 常用字段

- `file_id`：文档唯一标识（也可传 file_url 二选一）
- `sheet_id`：子表 ID，操作前先 `sheet.get_sheet_info` 或 `smartsheet.list_tables` 获取
- 行/列索引均为 0-based
- 所有响应含 `error`（成功为空）与 `trace_id`
