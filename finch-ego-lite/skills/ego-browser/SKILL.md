---
name: ego-browser
description: Use Ego Browser whenever the user needs to open a website, navigate pages, click, type, upload, take screenshots, extract page data, test web apps, log in, or automate browser actions. Ego gives Agents isolated task spaces that reuse the user's login state without competing with normal browser windows.
metadata:
  version: "0.1.0"
---

# Ego Browser

Use the `ego_browser` Agent tool instead of Bash.

## Start

Call `ego_browser` with `action: "status"` when availability or current task spaces matter. For browser work call `action: "run"` with one coherent JavaScript program in `script`.

All Ego helpers are preloaded in the script. Print model-visible output with `cliLog(...)`.

```js
const task = await useOrCreateTaskSpace('inspect example page')
await openOrReuseTab('https://example.com', { wait: true, timeout: 20 })
cliLog(await snapshotText())
```

## Main helpers

- Spaces: `listTaskSpaces`, `useOrCreateTaskSpace`, `claimTaskSpace`, `handOffTaskSpace`, `takeOverTaskSpace`, `waitForAgentControl`, `completeTaskSpace`
- Tabs: `listTabs`, `openOrReuseTab`, `closeTab`, `gotoAndWait`, `currentTab`, `switchTab`, `pageInfo`, `ensureRealTab`
- Observe: `snapshotText`, `captureScreenshot`, `drainEvents`
- Act: `click`, `doubleClick`, `hover`, `dragMouse`, `scrollBy`, `scroll`, `fillInput`, `typeText`, `pressKey`, `uploadFile`
- Wait: `wait`, `waitForLoad`, `waitForElement`, `waitForNetworkIdle`
- Advanced: `js`, `cdp`, `serverFetch`, `browserFetch`

## Task-space rules

Reuse the same short, goal-named task space across follow-ups. Prefer its numeric `id` after creation. Respect `ownership`:

- `agent`: the Agent may act.
- `agentDelegatedToUser`: the user controls it; stop and wait.
- `user`: claim only after explicit user confirmation.

When login, captcha, or manual confirmation is required, call `handOffTaskSpace(id)` and tell the user what to do. Call `takeOverTaskSpace(id)` only after the user explicitly says to continue.

Finish in a dedicated final call with `completeTaskSpace(id, { keep: false })`. Use `keep: true` only when the user explicitly wants the live page left open or must continue manually.

## Workflow

1. Semantic pages: `snapshotText()` then act with `@N`, stable `loc=...`, or CSS selectors.
2. Canvas/rich editors: screenshot, coordinates, and real keyboard input; test a tiny write first.
3. Extraction/state: use one `js(String.raw\`(() => { ... })()\`) expression.

After meaningful actions, verify with a new snapshot, `pageInfo()`, or screenshot. Refs from `snapshotText()` are valid only for the latest snapshot. Wait and timeout values are seconds unless the name ends in `Ms`.
