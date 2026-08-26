# finch-cloudbase

把腾讯云开发（Tencent CloudBase）接入 Finch 的小程序。

## 它做什么

- 只暴露 **一个** Agent 工具 `cloudbase_setup`（`action: connect | login | status | disconnect`），
  负责收集凭证并把官方 `@cloudbase/cloudbase-mcp` 作为**运行时 MCP server** 挂载到 Finch 的
  MCP Client 上。真正的数据库 / 云函数 / 静态托管 / 存储 / 鉴权能力，全部来自这个官方 MCP
  server 按需暴露的 `mcp__cloudbase__*` 工具，不在本小程序里重复实现。
- 提供统一设置菜单（Toolcase 卡片 + 会话头部）：一键登录、手动配置凭证、连接状态、打开云开发控制台、断开连接。

## 连接方式

### 一键登录（推荐）

`login` 直接调用 CloudBase MCP 自带的 `auth` 工具（`action=start_auth, authMode=device`），
拿到设备授权码登录链接后弹窗展示给用户（解析 `auth_challenge.user_code` /
`verification_uri_complete`），用户在浏览器完成授权即可 —— 不需要手动复制粘贴任何密钥，随后
自动轮询 `auth(action="status")` 直到 `auth_status === "READY"`。

> 为什么不直接用 Finch MCP Client 内置的「统一设备码登录框」（`ctx.oauth` Device Flow，或
> Notion 那种 `registerServer({ url, oauth })` 远程 OAuth 发现）？两者都不适用：
> - Notion 走的路径只认**远程 Streamable HTTP MCP server**（RFC 9728/8414/7591 发现 + DCR +
>   PKCE）；CloudBase MCP 是**本地 stdio 子进程**，架构上不是同一种 transport。
> - `ctx.oauth` 的 Device Flow 假定标准 RFC 8628（`form-urlencoded` 请求、标准 token 响应）；
>   CloudBase 的设备码是腾讯云私有变体（JSON 请求体、`{code,result,reqId}` 信封，轮询时还要带
>   本机 MAC 地址哈希做设备指纹），协议对不上，也没法把结果写进 CloudBase 工具箱自己的本地凭证
>   槽（`~/.config/.cloudbase/`）。
>
> 所以采用的方案是：让已经在本机跑起来的 CloudBase MCP 子进程自己完成这套私有流程（它会自动
> `openUrl` 打开浏览器、在后台轮询、登录成功后自己写本地凭证），本小程序只是调用它暴露的
> `auth` 工具拿到结构化的登录信息展示给用户，再轮询确认状态。

### 手动配置凭证

`connect` 表单收集：

| 字段 | 说明 |
|---|---|
| 环境 ID (EnvId) | 可选 |
| API Key（推荐） | 环境级长期凭证，只授权到单个环境，安全性优于账号级密钥。对应 `CLOUDBASE_API_KEY` |
| SecretId / SecretKey（高级） | 传统腾讯云账号级密钥，对应 `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY` |

全部留空也可以连接 —— 首次调用 CloudBase 工具时，MCP server 会引导在浏览器完成登录并选择环境
（个人开发默认路径），效果等同于「一键登录」。

凭证只写入 `ctx.secrets`（系统安全存储），EnvId 写入 `ctx.storage`（非敏感）。设备码登录成功后
的凭证由 CloudBase MCP 自己写入 `~/.config/.cloudbase/auth.json`，不经过本小程序存储。

## 开发

```bash
npm install
npm run typecheck
npm run build
npx @finchtoys/minitools doctor .
npx @finchtoys/minitools add "$(pwd)"
```

装好后到 Finch → Toolcase → Mini Tools 启用「CloudBase」，并在权限弹窗里确认 `network` 权限。

## 参考

- CloudBase AI ToolKit: https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/
- 本地模式环境变量: https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/connection-modes
