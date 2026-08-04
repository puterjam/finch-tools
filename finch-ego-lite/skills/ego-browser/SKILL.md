---
name: ego-browser
description: Use Ego Browser whenever the user needs to open a website, navigate pages, click, type, upload, take screenshots, extract page data, test web apps, log in, or automate browser actions. Ego gives Agents isolated task spaces that reuse the user's login state without competing with normal browser windows.
metadata:
  version: "0.1.2"
---

# Ego Browser 工具使用指南

本 skill 说明如何通过 `ego_browser` 工具完成浏览器自动化。日常浏览**不需要写脚本**——工具提供声明式 action，直接传参数即可。只有高级场景（CDP、自定义 JS、复杂逻辑）才使用 `action=run`。

## 使用流程

1. **`action: "status"`** — 检查 Ego 是否可用、任务空间与页面。任务开始时先调一次。
2. **`action: "open_url"`** — 打开网址：传 `url`（可选 `space_name` 给任务空间起个语义名）。返回 `spaceId`，后续操作复用它。
3. **按需执行操作**（见下表），关键操作后验证结果。
4. **`action: "close_space"`** — 任务完成，关闭任务空间（`space_id`）。

`space_id` 规则：多数 action 接受 `space_id`；省略时若恰好只有一个 agent 空间会自动使用，否则需要先从 `status`/`open_url` 拿到。

## Action 一览

| action | 参数 | 说明 |
|---|---|---|
| status | - | 环境、任务空间、页面状态 |
| open_url | url, space_name? | 打开网址，返回 spaceId |
| snapshot | space_id? | 读取页面为文本（语义树） |
| click | space_id?, selector | 按 CSS selector 点击 |
| fill | space_id?, selector, value | 填写表单字段 |
| type | space_id?, selector?, text | 输入文本；传 selector 先聚焦 |
| press_key | space_id?, key | 按键：Enter/Tab/Escape… |
| scroll | space_id?, delta_y? | 向下滚动（默认 300px） |
| screenshot | space_id? | 截图并作为图片返回 |
| extract | space_id?, selector? | 提取区域 innerText 或整页文本 |
| close_space | space_id | 关闭任务空间 |
| run | script, timeout_seconds? | 高级：执行原始 Ego 脚本 |

## 规则

- **复用任务空间**：同一目标的多步操作复用同一个 `space_id`，不要每次新建。
- **尊重归属**：`ownership` 为 `agent` 时可操作；`agentDelegatedToUser` 时用户正控制，停下等待；`user` 时必须先征得用户明确同意再接管。
- **登录/验证码/人工确认**：交给用户处理，明确告诉用户需要做什么；用户说继续后再接管。
- **验证关键操作**：点击、提交、填表后，用 `snapshot` 或 `pageInfo` 确认结果，不要盲目继续。
- **选择器优先**：定位元素用 CSS selector；`snapshot` 输出的语义树可帮助挑选 selector。
- **完成后关闭**：任务结束用 `close_space`；仅当用户明确要求保留页面时留着。
- **超时控制**：复杂操作适当调大 `timeout_seconds`（默认 60 秒）。
