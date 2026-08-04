---
name: ego-browser
description: Use Ego Browser whenever the user needs to open a website, navigate pages, click, type, upload, take screenshots, extract page data, test web apps, log in, or automate browser actions. Ego gives Agents isolated task spaces that reuse the user's login state without competing with normal browser windows.
metadata:
  version: "0.1.1"
---

# Ego Browser 工具使用指南

本 skill 说明如何通过 `ego_browser` 工具完成浏览器自动化。**不要用 Bash 或其他方式模拟浏览器操作，也不要学习或深入 Ego Browser 的内部脚本 API**——`ego_browser` 是唯一入口。

## 使用方式

`ego_browser` 工具只有两个 action：

1. **`action: "status"`** — 先调用它检查：Ego 是否可用、当前有哪些任务空间、各自归属（agent / user）与打开的页面。
2. **`action: "run"`** — 执行浏览器任务：`script` 参数写一段完整的 JavaScript，**以目标为导向**描述要完成的操作（打开哪些页面、点击什么、填什么、提取什么）。脚本运行在 Ego 预置环境中，浏览器操作由工具内部完成；结果用 `cliLog(...)` 输出给用户可见。

执行顺序永远是：`status` 确认环境 → `run` 执行任务 → 需要续做时复用同一任务空间继续 `run` → 完成后关闭。

## 规则

- **复用任务空间**：同一目标的多步操作复用同一个短命名（目标语义）的任务空间，不要每次新建。创建后优先用其数字 `id`。
- **尊重归属**：`ownership` 为 `agent` 时可操作；`agentDelegatedToUser` 时用户正控制，停下等待；`user` 时必须先征得用户明确同意再接管。
- **登录/验证码/人工确认**：交给用户处理，明确告诉用户需要做什么；用户说继续后再接管。
- **验证关键操作**：点击、提交、填表等有意义的操作后，通过新的快照/页面信息确认结果，不要盲目继续。
- **完成后关闭**：任务结束用 `completeTaskSpace(id, { keep: false })` 关闭；仅当用户明确要求保留页面时用 `keep: true`。
- **超时控制**：复杂任务用 `timeout_seconds` 适当调大（默认 60 秒）；脚本内部等待用秒为单位。

## 典型任务怎么写 script

脚本只需描述目标与关键步骤，不需要用户可见的中间细节：

- **打开页面**：打开 URL → 等待加载 → `cliLog` 输出页面摘要
- **点击 / 填表**：基于最新页面快照定位目标 → 执行点击或输入 → 验证结果
- **提取数据**：读取页面关键内容 → `cliLog` 结构化返回
- **截图**：截取当前页面 → 说明截图已获取

一次 `run` 只做一件连贯的事；中间结果通过 `cliLog` 反馈，不要在脚本里堆叠无关操作。
