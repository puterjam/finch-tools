# Yuanbao Search / 元宝搜索

Live web search inside Finch, powered by Tencent Yuanbao Search (腾讯云元宝搜索).

Ask a question in chat and the AI looks it up on the open web, then answers from
ranked results with a title, link, source site, publish date and snippet for
each one — so you can click through and check the source yourself.

---

## English

### What it is for

- Questions about things that changed recently: news, releases, prices, schedules.
- Facts the AI is not sure about and should verify instead of guessing.
- Anything you'd normally open a browser for: "look up how X configures Y".

Just ask in plain language:

> 用元宝搜索查一下本周的 AI 行业新闻
>
> Search the web for how to enable HTTP/3 on nginx

### One-time setup

You need a Tencent Cloud API key for a sub-user that is allowed to call
`wsa:SearchPro` (the Yuanbao Search action). Nothing else.

1. Open **Toolbox → Yuanbao Search → settings (gear)**.
2. Choose **Configure Tencent Cloud key** and paste your **SecretId** and **SecretKey**.
3. Done. The key is stored in your system keychain — it never goes into a file in
   your project, the chat log, or the repository.

Alternatively, set `TENCENTCLOUD_SECRETID` and `TENCENTCLOUD_SECRETKEY` in the
environment Finch starts from, and the mini tool will pick them up.

If you call the tool before configuring anything, it asks for the key right
there in the chat and continues as soon as you submit it.

### What you can ask for

The AI can pass these along when you ask:

| You say | Effect |
|---|---|
| "give me 20 results" | Result count: 10 / 20 / 30 / 40 / 50 |
| "only from the last week" | Time range: last N days, months, or years, or a date range |
| "only from zhihu.com" | Restrict to one site |
| "skip qq.com" | Exclude up to five sites |
| "prefer news / finance / academic sources" | Vertical source filter |
| "give me the fuller text" | Longer summary per result (much longer output) |

Results are truncated by default so a search does not flood the conversation.
Ask for the full text of a specific result if you need it.

### Checking it works

Open the settings menu and choose **Test connection**. It sends one real search
request and tells you the result count, or exactly what went wrong.

### Common problems

| Message | What to do |
|---|---|
| **No Tencent Cloud key configured** | Open the settings menu → Configure Tencent Cloud key. |
| **SecretId not found** / **Signature check failed** | The key was mistyped, or it is disabled in the CAM console. Re-enter it. |
| **Not authorized (CAM policy)** | Attach a policy allowing `wsa:SearchPro` to that sub-user, wait a few seconds, retry. |
| **Service not available (not activated / region unsupported)** | This mini tool deliberately sends no region header — the action rejects every named region. If you still see this, activate Yuanbao Search (联网搜索) in the Tencent Cloud console for this account. |
| **Too many requests** | Wait a few seconds. If it persists, your quota is used up. |
| **Cannot connect / TLS error** | Usually a corporate proxy. Allow `*.tencentcloudapi.com`. |

Every failure prints an error code and a `RequestId`. Include the `RequestId`
when opening a Tencent Cloud ticket.

---

## 中文

### 用来做什么

在 Finch 对话里直接做联网搜索。背后是腾讯云「元宝搜索」，返回按相关性排序的
结果列表：标题、链接、来源站点、发布时间、摘要，方便你自己点回去核对。

适合：最近发生的事、版本变化、价格、你不确定的事实，以及任何你本来要开浏览器查的问题。

直接说就行：

> 用元宝搜索查一下本周的 AI 行业新闻
>
> 上网查一下 nginx 怎么开启 HTTP/3

### 首次配置（一次性）

需要一个允许调用 `wsa:SearchPro`（元宝搜索）的腾讯云 API 密钥，不需要别的权限。

1. 打开 **工具箱 → 元宝搜索 → 设置（齿轮）**。
2. 点 **配置腾讯云密钥**，粘贴 **SecretId** 和 **SecretKey**。
3. 完成。密钥存在系统钥匙串里，不会落到项目文件、聊天记录或仓库里。

也可以在启动 Finch 的环境里设置 `TENCENTCLOUD_SECRETID` 与 `TENCENTCLOUD_SECRETKEY`，
小程序会自动读取。

如果还没配置就调用了工具，它会直接在对话里弹出输入框让你填，填完继续跑，不用重问一遍。

### 可以说哪些要求

| 你说 | 效果 |
|---|---|
| 「给我 20 条」 | 结果条数：10 / 20 / 30 / 40 / 50 |
| 「只看最近一周」 | 时效范围：近 N 天 / 月 / 年，或指定日期区间 |
| 「只搜知乎」 | 限定单个站点 |
| 「排除 qq.com」 | 排除最多五个站点 |
| 「偏新闻 / 财经 / 学术来源」 | 垂直领域信源 |
| 「把正文也给我」 | 每条返回更长的摘要（输出会明显变长） |

默认只返回摘要，避免一次搜索把对话刷屏。确实需要原文时再单独要。

### 确认是否可用

设置菜单里点 **测试连接**，它会发一次真实搜索请求，然后告诉你返回了几条结果，
或者具体错在哪。

### 常见报错

| 提示 | 怎么处理 |
|---|---|
| **还没有配置腾讯云密钥** | 设置菜单 → 配置腾讯云密钥。 |
| **SecretId 不存在** / **签名校验失败** | 密钥填错或在 CAM 控制台被停用了，重新填一次。 |
| **权限不足（CAM 未授权）** | 给这个子用户附加允许 `wsa:SearchPro` 的策略，等几秒重试。 |
| **服务当前不可用（未开通 / 地域不支持）** | 本小程序故意不发送任何地域头——这个接口对所有具名地域都报错。如果还是这个提示，请到腾讯云控制台开通「元宝搜索 / 联网搜索」。 |
| **请求过于频繁** | 等几秒再试；持续出现说明配额用完了。 |
| **无法连接 / TLS 证书校验失败** | 多半是公司代理。放行 `*.tencentcloudapi.com`。 |

每次失败都会给出错误码和 `RequestId`。给腾讯云提工单时请附上 `RequestId`。

---

## Notes

- The key pair is only ever read to sign one request. It is never written to
  logs, tool results, or plain-text settings.
- Nothing is sent anywhere except `wsa.tencentcloudapi.com`.
- Requires a Finch release at version 1.7.0 or newer.
