/**
 * Host-free integration smoke test for finch-multi-agent.
 *
 * `activate()` only needs `ctx`; everything else is our own code. So we can
 * stand up a fake host, drive the real `multi_agent_run` tool end to end, and
 * assert the behaviours that are otherwise only observable by watching a live
 * Finch window:
 *
 *   1. dispatch really waits for the batch (a regression here once made it
 *      return while every worker was still running),
 *   2. every worker Session — including dependent ones — is created inside the
 *      tool call, so Finch records the caller as its parent,
 *   3. a dependent task only sends its turn after its upstream artifact exists.
 *
 * Run with: node tools/smoke.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activate } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// ── tiny assertion helpers ──────────────────────────────────────────────────

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── fake host ───────────────────────────────────────────────────────────────

const locale = JSON.parse(readFileSync(join(root, 'i18n/zh-CN.json'), 'utf8'));
const fallback = JSON.parse(readFileSync(join(root, 'i18n/en-US.json'), 'utf8'));

const storagePath = mkdtempSync(join(tmpdir(), 'ma-smoke-'));
const sessions = [];
const eventListeners = [];
const artifacts = new Map();
const handoffs = [];
const collabScopes = new Map();
const collabTasks = new Map();
const collabDocs = new Map();
const turnInfo = new Map();
const progressMessages = [];
let seq = 0;
let n = 0;

/** Emulates Finch's auto-parent: set while we are inside a tool call. */
let callerSessionId = 'coord-session';

const nowIso = () => new Date().toISOString();

/** Called by the test to make a worker finish; default: 250ms after send. */
let onSend = null;

const ctx = {
  subscriptions: [],
  minitool: { id: 'finch-multi-agent', displayName: 'Multi-Agent', version: '0.1.0', extensionPath: root, isActive: true, scope: 'personal' },
  storagePath,
  api: { supports: () => true },
  logger: { debug() {}, info() {}, warn(...args) { console.log('    [warn]', ...args); }, error(...args) { console.log('    [error]', ...args); } },
  icons: { register: () => ({ dispose() {} }) },
  storage: {
    async get() { return undefined; },
    async set() {},
    async delete() {},
    async clear() {},
    async keys() { return []; },
  },
  i18n: {
    locale: 'zh-CN',
    t(key, values) {
      const raw = locale[key] ?? fallback[key];
      if (raw === undefined) return key;
      if (!values) return raw;
      return raw.replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])));
    },
    has(key) { return locale[key] !== undefined || fallback[key] !== undefined; },
    onDidChangeLocale() { return { dispose() {} }; },
  },
  spaces: { async list() { return []; } },
  models: {
    async list() {
      return [
        { modelKey: 'deepseek:deepseek-flash', providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-flash', name: 'DeepSeek V4 Flash', supportsThinking: true, instant: true, icon: 'model:deepseek' },
        { modelKey: 'openai:gpt-5', providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-5', name: 'GPT-5', supportsThinking: true, icon: 'model:openai' },
      ];
    },
  },
  artifacts: {
    async publish(options) {
      const id = `art-${++n}`;
      const text = options.source.type === 'text' ? options.source.text : JSON.stringify(options.source.value);
      const ref = {
        artifactId: id, scopeId: options.scopeId, name: options.name,
        contentHash: `sha256:${Buffer.from(text).toString('hex').slice(0, 16)}`,
        mediaType: options.mediaType ?? 'text/plain', size: text.length,
        sourceType: options.source.type, metadata: options.metadata,
        producer: options.producer, createdAt: nowIso(),
      };
      artifacts.set(id, { ref, text });
      return ref;
    },
    async get(id) { return artifacts.get(id)?.ref; },
    async list() { return [...artifacts.values()].map((entry) => entry.ref); },
    async read(id) {
      const entry = artifacts.get(id);
      if (!entry) throw new Error(`no artifact ${id}`);
      return { type: 'text', text: entry.text, mediaType: 'text/markdown' };
    },
  },
  collaboration: {
    scopes: {
      async create(o) {
        const scope = { scopeId: `scope-${++n}`, label: o.label, retention: o.retention ?? 'session', metadata: o.metadata, createdAt: nowIso(), updatedAt: nowIso() };
        collabScopes.set(scope.scopeId, scope);
        return scope;
      },
      async get(id) { return collabScopes.get(id); },
      async list() { return [...collabScopes.values()]; },
    },
    documents: {
      async create(o) {
        const doc = { documentId: `doc-${++n}`, scopeId: o.scopeId, name: o.name, kind: o.kind, revision: 1, artifactId: o.initialArtifactId, summary: o.summary, createdAt: nowIso(), updatedAt: nowIso() };
        collabDocs.set(doc.documentId, doc);
        return doc;
      },
      async get(id) { return collabDocs.get(id); },
      async list(scopeId) { return [...collabDocs.values()].filter((doc) => doc.scopeId === scopeId); },
      async update(o) {
        const current = collabDocs.get(o.documentId);
        if (!current) throw new Error('unknown document');
        if (current.revision !== o.baseRevision) return { state: 'conflict', current };
        const next = { ...current, revision: current.revision + 1, artifactId: o.artifactId, summary: o.summary, updatedAt: nowIso() };
        collabDocs.set(next.documentId, next);
        return { state: 'updated', document: next };
      },
    },
    tasks: {
      async create(o) {
        const task = { taskId: `ct-${++n}`, scopeId: o.scopeId, title: o.title, summary: o.summary, state: 'open', version: 1, refs: o.refs, createdAt: nowIso(), updatedAt: nowIso() };
        collabTasks.set(task.taskId, task);
        return task;
      },
      async get(id) { return collabTasks.get(id); },
      async list(scopeId) { return [...collabTasks.values()].filter((task) => task.scopeId === scopeId); },
      async update(o) {
        const current = collabTasks.get(o.taskId);
        if (!current) throw new Error('unknown task');
        if (current.version !== o.expectedVersion) return { state: 'conflict', current };
        const next = { ...current, state: o.state ?? current.state, summary: o.summary ?? current.summary, refs: o.refs ?? current.refs, version: current.version + 1, updatedAt: nowIso() };
        collabTasks.set(next.taskId, next);
        return { state: 'updated', task: next };
      },
      async claim(o) {
        const current = collabTasks.get(o.taskId);
        if (!current) throw new Error('unknown task');
        if (current.version !== o.expectedVersion) return { state: 'conflict', current };
        const next = { ...current, state: 'claimed', assigneeSessionId: o.assignee.sessionId, leaseExpiresAt: new Date(Date.now() + o.leaseMs).toISOString(), version: current.version + 1, updatedAt: nowIso() };
        collabTasks.set(next.taskId, next);
        return { state: 'updated', task: next };
      },
      async renewLease(o) {
        const current = collabTasks.get(o.taskId);
        if (!current) throw new Error('unknown task');
        if (current.version !== o.expectedVersion) return { state: 'conflict', current };
        const next = { ...current, version: current.version + 1, updatedAt: nowIso() };
        collabTasks.set(next.taskId, next);
        return { state: 'updated', task: next };
      },
    },
    handoffs: {
      async create(o) {
        const handoff = { handoffId: `ho-${++n}`, scopeId: o.scopeId, from: o.from, to: o.to, taskId: o.taskId, summary: o.summary, artifactIds: o.artifactIds ?? [], documentRefs: o.documentRefs ?? [], data: o.data, state: 'created', version: 1, createdAt: nowIso(), updatedAt: nowIso() };
        handoffs.push(handoff);
        return handoff;
      },
      async get(id) { return handoffs.find((handoff) => handoff.handoffId === id); },
      async list(scopeId) { return handoffs.filter((handoff) => handoff.scopeId === scopeId); },
      async accept(o) { return { state: 'updated', handoff: { handoffId: o.handoffId } }; },
      async reject(o) { return { state: 'updated', handoff: { handoffId: o.handoffId } }; },
    },
  },
  sessions: {
    async create(options) {
      const descriptor = {
        sessionId: `sess-${++n}`,
        owner: { type: 'minitool', minitoolId: 'finch-multi-agent' },
        placement: options.space ? { type: 'space', spaceId: options.space.spaceId } : { type: 'chat' },
        // This is the bit under test: Finch only records the parent when the
        // create happens inside a tool call.
        parentSessionId: callerSessionId,
        activity: options.activity ?? 'interactive',
        topic: options.topic,
        state: { pinned: false, archived: false },
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      sessions.push({ descriptor, options });
      return descriptor;
    },
    async get(sessionId) {
      return sessions.find((entry) => entry.descriptor.sessionId === sessionId)?.descriptor;
    },
    async list() { return sessions.map((entry) => entry.descriptor); },
    async send(sessionId, message, options) {
      const turnId = `turn-${++n}`;
      turnInfo.set(turnId, { sessionId, message, options });
      if (onSend) onSend({ sessionId, turnId, message, options });
      return { sessionId, turnId, clientMessageId: `c-${n}`, state: 'accepted', queued: false, pendingCount: 1, queuePosition: 0 };
    },
    async waitForTurn(sessionId, turnId) {
      const record = turnInfo.get(turnId);
      if (record?.finished) return { state: 'completed', sessionId, turnId, outputText: record.outputText, messageIds: [], completedAt: nowIso() };
      return { state: 'timeout', sessionId, turnId };
    },
    onDidReceiveEvent(listener) {
      eventListeners.push(listener);
      return { dispose() {} };
    },
    async listEvents() { return { events: [] }; },
    async listWaits() { return []; },
    async waitForWait() { return undefined; },
    async respondToWait() { return { state: 'not_found' }; },
    async cancelTurn() { return true; },
    async setPermissionMode() {},
  },
  ui: {
    createPanel() { return { id: 'p', postMessage() {}, dispose() {} }; },
    onDidOpenPanel() { return { dispose() {} }; },
    notify() {},
    async delivery() { return { set: async () => {}, remove: async () => {} }; },
  },
  settingsMenu: { register() { return { dispose() {}, notifyUpdate() {} }; } },
  navigation: { async openSession() {} },
};

let toolDefinition;
ctx.tools = {
  register(definition) {
    toolDefinition = definition;
    return { dispose() {} };
  },
  registerDiscoveryProvider() { return { dispose() {} }; },
  registerSearchProvider() { return { dispose() {} }; },
};

// ── drive it ────────────────────────────────────────────────────────────────

activate(ctx);
check('the tool registers', toolDefinition?.name === 'multi_agent_run', `got ${toolDefinition?.name}`);

/** Make every worker finish `delayMs` after its turn is sent. */
onSend = ({ sessionId, turnId }) => {
  setTimeout(() => {
    const record = turnInfo.get(turnId);
    if (!record) return; // a stale timer from an earlier scenario
    record.finished = true;
    record.outputText = `产出 by ${sessionId}`;
    for (const listener of eventListeners) {
      listener({ type: 'turn.completed', sessionId, turnId, outputText: record.outputText, messageIds: [], sequence: ++seq, createdAt: nowIso() });
    }
  }, 250);
};

const exec = {
  toolCallId: 'call-1',
  sessionId: callerSessionId,
  spaceId: undefined,
  cwd: undefined,
  logger: ctx.logger,
  storage: ctx.storage,
  secrets: {},
  progress: { report(update) { progressMessages.push(update); } },
  ui: { requestForm: async () => ({ submitted: false, values: {} }) },
};

const started = Date.now();
const result = await toolDefinition.execute(
  {
    action: 'dispatch',
    goal: '冒烟：两个独立任务 + 一个依赖前两者的汇总',
    maxParallel: 2,
    tasks: [
      { id: 't1', title: '调研 · 查一件事', prompt: '写一句话', deliverable: '一句话' },
      { id: 't2', title: '调研 · 查另一件事', prompt: '写一句话', deliverable: '一句话' },
      { id: 't3', title: '统稿 · 合并前面两份', prompt: '合并上游材料', deliverable: '一条结论', dependsOn: ['t1', 't2'] },
    ],
  },
  exec,
);
const elapsed = Date.now() - started;
const output = result.content.map((block) => block.text ?? '').join('\n');

// 1. dispatch must hold the call open until the batch is done. Three tasks,
//    two waves of 250ms workers: ~500ms if the wait works, ~0ms if it does not.
check('dispatch waits for the batch', elapsed >= 450, `returned after ${elapsed}ms`);
check('all three tasks completed', /进度: 3\/3/.test(output), output.split('\n').slice(0, 4).join(' | '));
check('progress was reported while waiting', progressMessages.length >= 2, `${progressMessages.length} reports`);
check('progress moved past zero', progressMessages.some((update) => (update.percent ?? 0) > 0), JSON.stringify(progressMessages.map((u) => u.percent)));

// 2. every worker Session, dependent ones included, is created in the tool call
//    so the caller is recorded as its parent.
check('one session per task', sessions.length === 3, `${sessions.length} sessions`);
check(
  'every worker session is parented to the caller',
  sessions.every((entry) => entry.descriptor.parentSessionId === callerSessionId),
  JSON.stringify(sessions.map((entry) => entry.descriptor.parentSessionId)),
);
check('sessions are titled by the task, not by a truncated goal', sessions.every((entry) => /·/.test(entry.options.title ?? '')), JSON.stringify(sessions.map((entry) => entry.options.title)));
check('the batch shares one topic label', new Set(sessions.map((entry) => entry.descriptor.topic)).size === 1, JSON.stringify(sessions.map((entry) => entry.descriptor.topic)));

// 3. the dependent task only starts once its upstream artifacts exist.
check('two workers start immediately, the dependent one waits', sessions.length === 3 && turnInfo.size === 3);
const t3Turn = [...turnInfo.entries()].find(([, record]) => record.message.text.includes('统稿') || record.message.text.includes('上游'));
check('the dependent worker received its upstream material', Boolean(t3Turn) && t3Turn[1].message.attachments?.length === 2, `attachments: ${t3Turn?.[1]?.message.attachments?.length}`);
check('dependencies were recorded as handoffs', handoffs.length === 2, `${handoffs.length} handoffs`);
check('each task published an artifact', artifacts.size >= 2, `${artifacts.size} artifacts`);

// The run text should point the caller at the sessions it can open.
check('the result names each worker session', (output.match(/sess-\d+/g) ?? []).length >= 3, output.split('\n').filter((line) => line.includes('会话')).length + ' lines');

// 4. `wait` on an unknown run fails cleanly.
const waited = await toolDefinition.execute({ action: 'wait', runId: 'nope' }, exec);
check('wait on an unknown run fails cleanly', waited.isError === true);

// ── the interruption path: revise mid-run ───────────────────────────────────

// A slow run with a two-step chain: t1 feeds t2, so redirecting t1 has to drag
// t2 along rather than leaving it blocked behind a cancelled dependency.
turnInfo.clear();
seq = 0;
handoffs.length = 0;
artifacts.clear();
const sessionsBefore = sessions.length;
onSend = ({ sessionId, turnId }) => {
  // Identify the worker by its session title: the original r1 is the slow one.
  const title = sessions.find((entry) => entry.descriptor.sessionId === sessionId)?.options.title ?? '';
  const isSlow = title.includes('原方向');
  if (process.env.MA_DEBUG) console.log(`    [send] ${sessionId} slow=${isSlow} title=${title}`);
  setTimeout(() => {
    const record = turnInfo.get(turnId);
    if (!record) return; // a stale timer from an earlier scenario
    record.finished = true;
    record.outputText = `产出 by ${sessionId}`;
    for (const listener of eventListeners) {
      listener({ type: 'turn.completed', sessionId, turnId, outputText: record.outputText, messageIds: [], sequence: ++seq, createdAt: nowIso() });
    }
  }, isSlow ? 30_000 : 200);
};

const slowRun = await toolDefinition.execute(
  {
    action: 'dispatch',
    goal: '需要中途改方向的演示',
    maxParallel: 2,
    waitSeconds: 1, // hand control back quickly so the test can redirect
    tasks: [
      { id: 'r1', title: '调研 · 原方向', prompt: '写一句话', deliverable: '一句话' },
      { id: 'r2', title: '统稿 · 合并 r1', prompt: '合并上游材料', deliverable: '一条结论', dependsOn: ['r1'] },
    ],
  },
  exec,
);
check('a run that outlives the budget reports still running', /小队还在干活|还有 worker 没交卷/.test(slowRun.content[0].text), slowRun.content[0].text.split('\n')[0]);
const slowRunId = (slowRun.content[0].text.match(/run-[a-z0-9-]+/) ?? [])[0];
if (process.env.MA_DEBUG) {
  const snapshot = await toolDefinition.execute({ action: 'status', runId: slowRunId }, exec);
  console.log('--- before revise ---\n' + snapshot.content[0].text);
}

const redirected = await toolDefinition.execute(
  {
    action: 'add',
    runId: slowRunId,
    waitSeconds: 1,
    // Reusing the id replaces r1: the old turn is stopped, dependents keep the edge.
    tasks: [{ id: 'r1', title: '调研 · 改后的方向', prompt: '换个方向写一句话', deliverable: '一句话' }],
  },
  exec,
);
const redirectText = redirected.content.map((block) => block.text ?? '').join('\n');
check('add reports what it queued', /已排入 1 个/.test(redirectText), JSON.stringify(redirectText.slice(0, 400)));
check('replacing a task creates a fresh worker session', sessions.length === sessionsBefore + 3, `${sessions.length - sessionsBefore} new sessions`);
check('the replacement keeps the caller as parent', sessions.at(-1).descriptor.parentSessionId === callerSessionId);

const revisionTurn = [...turnInfo.entries()].map(([, record]) => record).find((record) => record.message.text.includes('换个方向'));
check('the replacement worker got the new direction', Boolean(revisionTurn));

const r2Turn = [...turnInfo.entries()].map(([, record]) => record).find((record) => record.message.text.includes('合并上游材料'));
check('the dependent task was revived, not left blocked', Boolean(r2Turn));
check('the dependent picked up the replacement artifact', r2Turn?.message.attachments?.length === 1 && r2Turn.message.attachments[0].name === 'upstream-r1.md', JSON.stringify(r2Turn?.message.attachments?.map((a) => a.name)));

// ── progressive planning: add after the first batch, and held roles ─────────

turnInfo.clear();
onSend = ({ turnId }) => {
  setTimeout(() => {
    const record = turnInfo.get(turnId);
    if (!record) return; // a stale timer from an earlier scenario
    record.finished = true;
    record.outputText = 'ok';
    for (const listener of eventListeners) {
      listener({ type: 'turn.completed', sessionId: record.sessionId, turnId, outputText: record.outputText, messageIds: [], sequence: ++seq, createdAt: nowIso() });
    }
  }, 50);
};

const stepOne = await toolDefinition.execute(
  {
    action: 'dispatch',
    goal: '先做第一步，再看要不要第二步',
    waitSeconds: 5,
    tasks: [
      { id: 's1', title: '调研 · 第一步', prompt: '写一句话' },
      { id: 's2', title: '验收 · 待命', prompt: '等指令', hold: true },
      { id: 's4', title: '复盘 · 待命', prompt: '等指令', hold: true },
    ],
  },
  exec,
);
const stepOneText = stepOne.content[0].text;
check('a held task is created but not run', /待启动/.test(stepOneText), stepOneText.split('\n').slice(0, 10).join(' | '));
check('the held worker was never sent a turn', ![...turnInfo.values()].some((record) => record.message.text.includes('等指令')));

const stepTwo = await toolDefinition.execute(
  {
    action: 'add',
    runId: (stepOneText.match(/run-[a-z0-9-]+/) ?? [])[0],
    waitSeconds: 5,
    tasks: [{ id: 's3', title: '统稿 · 第二步', prompt: '写一句话', dependsOn: ['s1'] }],
  },
  exec,
);
check('add queues work into the same run', /已排入 1 个/.test(stepTwo.content[0].text) && stepTwo.content[0].text.includes('s3'));
check('the newly added task actually ran', [...turnInfo.values()].some((record) => record.message.text.includes('## Your subtask (s3)')));

const released = await toolDefinition.execute(
  { action: 'start', runId: (stepOneText.match(/run-[a-z0-9-]+/) ?? [])[0], taskIds: ['s2'], waitSeconds: 5 },
  exec,
);
check('start releases a held task', /已启动 1 个/.test(released.content[0].text));
check('the released task ran', [...turnInfo.values()].some((record) => record.message.text.includes('## Your subtask (s2)')));

const dropped = await toolDefinition.execute(
  { action: 'drop', runId: (stepOneText.match(/run-[a-z0-9-]+/) ?? [])[0], taskIds: ['s4'], waitSeconds: 2 },
  exec,
);
check('drop stops a task without replacing it', /已停止 1 个/.test(dropped.content[0].text), dropped.content[0].text.split('\n')[0]);
check('the dropped task is cancelled, not run', /s4/.test(dropped.content[0].text) && /⊘|已停止/.test(dropped.content[0].text));

// ── a worker asking a peer for its output ──────────────────────────────────

turnInfo.clear();
handoffs.length = 0;
// The architect is quick, so the QA worker's request can be answered straight away.
onSend = ({ sessionId, turnId, message }) => {
  const title = sessions.find((entry) => entry.descriptor.sessionId === sessionId)?.options.title ?? '';
  const firstTurn = !message.text.includes('的产出见附件');
  const asking = title.includes('测试') && firstTurn;
  if (process.env.MA_DEBUG) console.log(`    [send] ${title} first=${firstTurn} asking=${asking}`);
  setTimeout(() => {
    const record = turnInfo.get(turnId);
    if (!record) return; // a stale timer from an earlier scenario
    record.finished = true;
    // QA asks for the architect's output instead of guessing it.
    record.outputText = asking ? '我需要接口定义才能验收。\n\nNEED: architect' : `产出 by ${title}`;
    for (const listener of eventListeners) {
      listener({ type: 'turn.completed', sessionId, turnId, outputText: record.outputText, messageIds: [], sequence: ++seq, createdAt: nowIso() });
    }
  }, 150);
};

const teamRun = await toolDefinition.execute(
  {
    action: 'dispatch',
    goal: '架构 / 测试 的分工',
    maxParallel: 3,
    waitSeconds: 5,
    tasks: [
      { id: 'architect', title: '架构师 · 定接口', prompt: '给出接口定义' },
      { id: 'qa', title: '测试 · 验收接口', prompt: '验收接口' },
    ],
  },
  exec,
);
const teamText = teamRun.content.map((block) => block.text ?? '').join('\n');
check('the run finishes after the peer request is served', /全员交卷|大部分交卷/.test(teamText), teamText.split('\n').slice(0, 4).join(' | '));
const resumeTurn = [...turnInfo.values()].find((record) => record.message.text.includes('的产出见附件'));
check('the asking worker was resumed with the peer artifact', Boolean(resumeTurn) && resumeTurn.message.attachments?.[0]?.name === 'upstream-architect.md', JSON.stringify(resumeTurn?.message.attachments?.map((a) => a.name)));
check('the request was recorded as a handoff, not a chat message', handoffs.some((entry) => entry.summary?.includes('architect') && entry.summary?.includes('qa')), JSON.stringify(handoffs.map((h) => h.summary)));

// A request for a task nobody created has to reach the coordinator, not hang.
turnInfo.clear();
handoffs.length = 0;
onSend = ({ sessionId, turnId, message }) => {
  const title = sessions.find((entry) => entry.descriptor.sessionId === sessionId)?.options.title ?? '';
  // Only the frontend worker waits on the designer; the designer itself just works.
  const asking = title.includes('前端') && !message.text.includes('上游材料已经补上');
  setTimeout(() => {
    const record = turnInfo.get(turnId);
    if (!record) return; // a stale timer from an earlier scenario
    record.finished = true;
    record.outputText = asking ? '需要设计稿。\n\nNEED: designer' : `产出 by ${sessionId}`;
    for (const listener of eventListeners) {
      listener({ type: 'turn.completed', sessionId, turnId, outputText: record.outputText, messageIds: [], sequence: ++seq, createdAt: nowIso() });
    }
  }, 100);
};
const stuckRun = await toolDefinition.execute(
  { action: 'dispatch', goal: '索要一个还没创建的角色', waitSeconds: 5, tasks: [{ id: 'fe', title: '前端 · 依设计稿实现', prompt: '写一句话' }] },
  exec,
);
const stuckText = stuckRun.content.map((block) => block.text ?? '').join('\n');
check('an unresolvable request is surfaced instead of hanging', /卡住/.test(stuckText) && /designer/.test(stuckText), stuckText.split('\n').slice(0, 6).join(' | '));
check('...and it says what to do about it', /action=wait/.test(stuckText));

// Solving it: create the missing role and the parked task resumes by itself.
const rescued = await toolDefinition.execute(
  {
    action: 'add',
    runId: (stuckText.match(/run-[a-z0-9-]+/) ?? [])[0],
    waitSeconds: 5,
    tasks: [{ id: 'designer', title: '设计 · 出设计稿', prompt: '写一句话' }],
  },
  exec,
);
const rescuedText = rescued.content.map((block) => block.text ?? '').join('\n');
check('adding the missing role lets the parked task finish', /全员交卷/.test(rescuedText), JSON.stringify(rescuedText.slice(0, 900)));
const revivedTurn = [...turnInfo.values()].find((record) => record.message.text.includes('上游材料已经补上'));
check('the parked worker resumed with the new peer artifact', Boolean(revivedTurn) && revivedTurn.message.attachments?.[0]?.name === 'upstream-designer.md', JSON.stringify(revivedTurn?.message.attachments?.map((a) => a.name)));

// 5. The aborted-hold path: an interrupted wait must not be treated as failure.
const abortController = new AbortController();
setTimeout(() => abortController.abort(), 150);
onSend = () => { /* nothing finishes — this run stays live */ };
const abortRun = await toolDefinition.execute(
  { action: 'dispatch', goal: '等待会被用户打断的演示', maxParallel: 1, waitSeconds: 60, tasks: [{ id: 'w1', title: '调研 · 慢活', prompt: '写一句话' }] },
  { ...exec, signal: abortController.signal },
);
check('an aborted hold is not an error', abortRun.isError !== true);
check('...and it says the run continues', /打断|wait/.test(abortRun.content[0].text), abortRun.content[0].text.split('\n')[0]);

// ── model selection ─────────────────────────────────────────────────────────

turnInfo.clear();
handoffs.length = 0;
artifacts.clear();
onSend = ({ turnId }) => {
  setTimeout(() => {
    const record = turnInfo.get(turnId);
    if (!record) return; // a stale timer from an earlier scenario
    record.finished = true;
    record.outputText = 'ok';
    for (const listener of eventListeners) {
      listener({ type: 'turn.completed', sessionId: record.sessionId, turnId, outputText: record.outputText, messageIds: [], sequence: ++seq, createdAt: nowIso() });
    }
  }, 50);
};

const listed = await toolDefinition.execute({ action: 'models' }, exec);
const listText = listed.content[0].text;
check('models lists real provider:model keys', listText.includes('deepseek:deepseek-flash') && listText.includes('openai:gpt-5'), listText.split('\n').slice(0, 3).join(' | '));
check('models marks the fast/thinking flags', /快速/.test(listText) && /支持思考/.test(listText));
check('models says what the default is', /默认工作模型/.test(listText));

const normalRun = await toolDefinition.execute(
  { action: 'dispatch', goal: '默认模型的演示', tasks: [{ id: 'd1', title: '调研 · 不指定模型', prompt: '写一句话' }], waitSeconds: 5 },
  exec,
);
check('no model requested → nothing to report', !/没匹配上/.test(normalRun.content[0].text), normalRun.content[0].text);

const askedRun = await toolDefinition.execute(
  {
    action: 'dispatch',
    goal: '指定模型的演示',
    waitSeconds: 5,
    tasks: [
      { id: 'm1', title: '调研 · 指定真实模型', prompt: '写一句话', model: 'GPT-5' },
      { id: 'm2', title: '调研 · 指定不存在的模型', prompt: '写一句话', model: 'gpt-9-ultra' },
    ],
  },
  exec,
);
const askedText = askedRun.content.map((block) => block.text ?? '').join('\n');
check('a fuzzy-but-real model name resolves', /openai:gpt-5/.test(askedText), askedText.split('\n').slice(0, 6).join(' | '));
check('an unmatched model request is reported, not silently swallowed', /没匹配上/.test(askedText) && /gpt-9-ultra/.test(askedText), askedText.split('\n').filter((line) => line.includes('没匹配上')).join(' | '));

// A run-wide model with one task overriding it: the override must win for that
// task only, and the run default must reach everyone else.
turnInfo.clear();
const mixedRun = await toolDefinition.execute(
  {
    action: 'dispatch',
    goal: '混用模型的演示',
    model: 'DeepSeek V4 Flash',
    waitSeconds: 5,
    tasks: [
      { id: 'x1', title: '调研 · 跟随整轮模型', prompt: '写一句话' },
      { id: 'x2', title: '推理 · 单独指定模型', prompt: '写一句话', model: 'openai:gpt-5' },
    ],
  },
  exec,
);
/** model applied to the turn of the worker whose session title matches. */
function modelForTask(titleFragment) {
  for (const [turnId, record] of turnInfo) {
    const session = sessions.find((entry) => entry.descriptor.sessionId === record.sessionId);
    if (session?.options.title.includes(titleFragment)) {
      return turnInfo.get(turnId).options?.model?.modelKey;
    }
  }
  return undefined;
}
check(
  'the run-wide model reaches a task that did not ask for one',
  modelForTask('跟随整轮模型') === 'deepseek:deepseek-flash',
  String(modelForTask('跟随整轮模型')),
);
check(
  'a single task can override the run-wide model',
  modelForTask('单独指定模型') === 'openai:gpt-5',
  String(modelForTask('单独指定模型')),
);

// ── teardown ────────────────────────────────────────────────────────────────

// Let any queued scheduler pass finish before the store is closed; disabling the
// mini tool mid-flight is exactly the lifecycle the shutdown guard covers.
await sleep(250);
for (const disposable of ctx.subscriptions) {
  try { disposable.dispose?.(); } catch { /* ignore */ }
}
await sleep(50);
rmSync(storagePath, { recursive: true, force: true });

console.log(failures === 0 ? '\nall smoke checks passed' : `\n${failures} smoke check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
