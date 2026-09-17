import * as crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type * as finch from 'finch';
import { DISCOVERY_PORT, startDiscovery, type DiscoveryHandle } from './discovery.js';
import { soundFrames } from './audio.js';
import { PROTOCOL_VERSION, type ClientMessage, type DeviceRecord, type GainLevel, type PairedToken, type PendingPair, type PetState, type PromptKind, type PromptOption, type ServerMessage, isPetState, parseClientMessage, sanitizeBubble, sanitizeText } from './protocol.js';

const TOKEN_KEY = 'finchchan.tokens';
const DEVICES_KEY = 'finchchan.devices';
const PORT = 8267;
const PAIR_TTL_MS = 10 * 60_000;
/** “在忙”的活动窗口：多久没新事件就不再算在忙（避免卡在 working）。 */
const BUSY_WINDOW_MS = 5000;
/** 出错是短暂提示，过了就回到常规状态。 */
const ERROR_WINDOW_MS = 6000;
/**
 * thinking / working 各有几句气泡文案（i18n 里的 `bubble.thinking1..N`）。
 * 停在同一个状态超过 BUBBLE_ROTATE_MS 就重发一次状态，只换文案
 * （设备端 setState 即使状态没变也会更新气泡，且不会重复响提示音）。
 */
const BUBBLE_TEXTS = 5;
const BUBBLE_ROTATE_MS = 5_000;
/**
 * 乐观未读的有效期。
 * background-done 先把它置上（任务一完成就立刻变笑脸），但这时 Finch 的 status
 * 可能还没翻到 unread，导致用户读完时“没有状态变化事件”可发。
 * 所以乐观值有上限，且一旦 status 说“没有未读”就立即作废。
 */
const UNREAD_OPTIMISTIC_MS = 10_000;
/** 兜底对账间隔：订阅正常时用不到，只用来兜住漏事件。 */
export const SYNC_INTERVAL_MS = 2000;

interface Connection { socket: WebSocket; deviceId?: string; authenticated: boolean; chip?: string }
interface BridgeSnapshot { port: number; discoveryPort: number; state: PetState; devices: DeviceRecord[]; started: boolean }

/** 设备端的功能设置（旋律模式 / 收音灵敏度 / 随节奏舞动）。 */
interface DeviceSettings { music: boolean; gain: GainLevel; beat: boolean }

/**
 * 设置菜单要显示的状态。多台设备时取第一台在线设备的值，
 * `mixed=true` 表示它们当前不一致（菜单里会提示）。
 */
export interface SettingsSnapshot { connected: number; mixed: boolean; music?: boolean; gain?: GainLevel; beat?: boolean }

/** 设备端正在显示的一张卡片，记录作答时需要的映射关系。 */
interface PendingPrompt {
  sessionId: string;
  kind: PromptKind;
  requestId: string;
  questionHeader?: string;
  optionIds: string[];
  optionValues: string[];
  optionActions: ('allow' | 'deny' | 'choice' | 'open')[];
}

function hash(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }
function send(socket: WebSocket, payload: ServerMessage): void { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)); }

/** LAN WebSocket bridge. It deliberately sends finite state and bounded display text only. */
export class FinchChanBridge {
  private server?: WebSocketServer;
  private discovery?: DiscoveryHandle;
  private readonly connections = new Map<WebSocket, Connection>();
  /** 每台设备最近一次上报的功能设置（设备是唯一真源，PWR 键也能改）。 */
  private readonly settings = new Map<string, DeviceSettings>();
  private readonly pending = new Map<string, PendingPair>();
  private readonly pendingPrompts = new Map<string, PendingPrompt>();
  /** 最近有活动的会话，用作点按的回退目标。 */
  private lastSessionId?: string;
  /** 用户自定义的助手名（如“帕亚”），用于自然语言的权限文案。 */
  private assistantName = 'Finch';
  private state: PetState = 'idle';
  private lastSentAt = 0;
  /** 每组气泡文案上一次用的索引（避免连着重复）＋ 上次换文案的时间。 */
  private readonly bubbleCursor = new Map<string, number>();
  private bubbleRotatedAt = 0;
  /** 状态仲裁用的事实：在忙 / 未读 / 有等待 / 出错（短暂）。 */
  private busyState?: PetState;
  private busyUntil = 0;
  private unreadActive = false;
  private unreadOptimisticUntil = 0;
  private waitActive = false;
  private errorUntil = 0;

  constructor(private readonly ctx: finch.MiniToolContext, private readonly onChange: () => void) {}

  async start(): Promise<void> {
    if (this.server) return;
    // 取用户自定义的助手名（如“帕亚”），设备上的权限卡用它拼自然语言。
    try {
      const info = await this.ctx.app.getInfo();
      if (info.assistantName) this.assistantName = info.assistantName;
    } catch {
      this.ctx.logger.info('[finch-chan] assistant name unavailable, falling back to "Finch"');
    }
    const server = new WebSocketServer({ host: '0.0.0.0', port: PORT });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    this.server = server;
    server.on('connection', (socket) => this.onConnection(socket));
    server.on('error', (error) => this.ctx.logger.error('[finch-chan] websocket server error', error));
    this.ctx.logger.info(`[finch-chan] listening on ws://0.0.0.0:${PORT}`);
    // 设备靠这个 UDP 广播自己找到本机 IP，用户不用知道地址。
    this.discovery = startDiscovery({ wsPort: PORT, log: (message) => this.ctx.logger.info(message) });
  }

  async stop(): Promise<void> {
    this.discovery?.close();
    this.discovery = undefined;
    const server = this.server;
    this.server = undefined;
    for (const connection of this.connections.values()) connection.socket.close(1001, 'bridge stopped');
    this.connections.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async snapshot(): Promise<BridgeSnapshot> {
    return { port: PORT, discoveryPort: this.discovery ? DISCOVERY_PORT : 0, state: this.state, devices: await this.devices(), started: !!this.server };
  }

  createPairing(deviceId: string): PendingPair {
    const normalized = deviceId.trim().slice(0, 96);
    if (!normalized) throw new Error('device_id is required');
    const pending = { deviceId: normalized, code: crypto.randomBytes(3).toString('hex').toUpperCase(), expiresAt: Date.now() + PAIR_TTL_MS };
    this.pending.set(normalized, pending);
    // 设备可能已经在连着（只是未认证）：主动告诉它可以弹确认卡片了，
    // 否则用户点了配对还得等设备重连才知道。已认证的设备收到也无害。
    for (const connection of this.connections.values()) {
      if (connection.deviceId === normalized) send(connection.socket, { type: 'pair_offer' });
    }
    return pending;
  }

  /** 这台设备是否有一个还没过期的配对窗口（设备据此决定要不要弹确认卡片）。 */
  private hasPendingPairing(deviceId: string): boolean {
    const pending = this.pending.get(deviceId);
    return !!pending && pending.expiresAt > Date.now();
  }

  /** 某台设备是否已经配过对（设置菜单据此决定显示「配对」还是「取消配对」）。 */
  async isPaired(deviceId: string): Promise<boolean> {
    return !!(await this.tokens()).find((token) => token.deviceId === deviceId);
  }

  async unpair(deviceId: string): Promise<boolean> {
    const tokens = await this.tokens();
    const next = tokens.filter((token) => token.deviceId !== deviceId);
    if (next.length === tokens.length) return false;
    await this.ctx.secrets.set(TOKEN_KEY, JSON.stringify(next));
    // 在线的连接也得告知一声，否则设备会拿着旧 token 一直重连（协议里用 unauthorized 表示）。
    for (const connection of this.connections.values()) {
      if (connection.deviceId === deviceId) send(connection.socket, { type: 'error', code: 'unauthorized' });
    }
    const devices = (await this.devices()).filter((device) => device.deviceId !== deviceId);
    await this.ctx.storage.set(DEVICES_KEY, devices);
    for (const connection of this.connections.values()) if (connection.deviceId === deviceId) connection.socket.close(4003, 'unpaired');
    this.onChange();
    return true;
  }

  async command(action: 'state' | 'say', value: PetState | string, bubble?: string): Promise<number> {
    const message: ServerMessage = action === 'state'
      ? { type: 'command', id: crypto.randomUUID(), action: 'state', state: value as PetState, ...(bubble ? { bubble: sanitizeBubble(bubble) } : {}) }
      : { type: 'command', id: crypto.randomUUID(), action: 'say', text: sanitizeText(String(value)) };
    return this.broadcast(message);
  }

  /** 让设备清掉 WiFi 凭证并重启进配网模式（设置菜单里的「重新配网」）。 */
  async requestWifiReset(): Promise<number> {
    return this.broadcast({ type: 'command', id: crypto.randomUUID(), action: 'wifi-reset' });
  }

  /**
   * 长时间停在 thinking / working（agent 干活时没有新事件）就换一句气泡文案：
   * 用 force 重发一次同状态，绕过去重，只换文本，不重复响提示音、不闪表情。
   * 由 index.ts 的定时器每秒调一次，所以实际间隔就是 BUBBLE_ROTATE_MS。
   * （挂在那条 2 秒的状态对账上的话，实际会变成 ~6 秒一次。）
   */
  async rotateBubble(): Promise<void> {
    if (this.state !== 'thinking' && this.state !== 'working') return;
    if (Date.now() - this.bubbleRotatedAt < BUBBLE_ROTATE_MS) return;
    await this.publishState(this.state, true);
  }

  /**
   * 设置菜单要显示的功能设置状态。
   * 以**在线且已认证**的设备为准；多台取第一台，`mixed` 标出它们不一致。
   */
  settingsSnapshot(): SettingsSnapshot {
    const online = [...this.connections.values()].filter((connection) => connection.authenticated && connection.deviceId);
    if (!online.length) return { connected: 0, mixed: false };
    const values = online
      .map((connection) => this.settings.get(connection.deviceId!))
      .filter((value): value is DeviceSettings => !!value);
    if (!values.length) return { connected: online.length, mixed: false };   // 设备还没上报过
    const first = values[0];
    const mixed = values.some((value) => value.music !== first.music || value.gain !== first.gain || value.beat !== first.beat);
    return { connected: online.length, mixed, ...first };
  }

  /**
   * 下发功能设置，只改传了的字段。设备应用后会回报一份完整设置（并刷新这里缓存），
   * 这里也先本地乐观更新一次，避免菜单立刻重开时还是旧值。
   */
  sendSettings(patch: { music?: boolean; gain?: GainLevel; beat?: boolean }): number {
    if (patch.music === undefined && patch.gain === undefined && patch.beat === undefined) return 0;
    const message: ServerMessage = { type: 'command', id: crypto.randomUUID(), action: 'settings', ...patch };
    const sent = this.broadcast(message);
    if (sent) {
      for (const connection of this.connections.values()) {
        if (!connection.authenticated || !connection.deviceId) continue;
        const current = this.settings.get(connection.deviceId);
        if (!current) continue;
        this.settings.set(connection.deviceId, { ...current, ...patch });
      }
      this.onChange();
    }
    return sent;
  }

  private broadcast(message: ServerMessage): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (!connection.authenticated) continue;
      send(connection.socket, message); count += 1;
    }
    return count;
  }

  async publishState(next: PetState, force = false): Promise<void> {
  const now = Date.now();
    if (!force && next === this.state) return;
    if (!force && next === 'idle' && now - this.lastSentAt < 2_000) return;
    this.state = next; this.lastSentAt = now;
    this.bubbleRotatedAt = now;
    await this.command('state', next, this.bubbleFor(next));
    this.onChange();
  }

  /**
   * 状态仲裁。
   *
   * 多个来源（agent 事件 / Finch status / 通知 / 等待）各自只知道一部分事实，
   * 以前它们直接 publishState，会互相覆盖：working 盖掉 waiting，
   * 下一轮 status 又翻回来，设备就在两者之间来回跳、每跳一次响一声。
   * 现在各来源只登记事实，由这里按优先级算出该显示什么：
   *
   *   waiting > error（短暂） > working/thinking > unread > idle
   */
  async noteEvent(state: PetState): Promise<void> {
    const now = Date.now();
    switch (state) {
      case 'thinking':
      case 'working':
        this.busyState = state;
        this.busyUntil = now + BUSY_WINDOW_MS;
        break;
      case 'waiting':
        this.waitActive = true;
        break;
      case 'happy':
        // 任务刚完成：先乐观地立刻显示“有未读”（带有效期），并结束“在忙”。
        this.unreadOptimisticUntil = now + UNREAD_OPTIMISTIC_MS;
        this.busyState = undefined;
        break;
      case 'error':
        this.errorUntil = now + ERROR_WINDOW_MS;
        break;
      case 'idle':
        this.busyState = undefined;
        break;
    }
    await this.recompute();
  }

  /** 来自 Finch status 的权威事实（未读 / 运行中）。 */
  async noteStatus(status: finch.FinchStatusSnapshot): Promise<void> {
    this.applyStatus(status, Date.now());
    await this.recompute();
  }

  /**
   * 把一份 Finch status 落到仲裁用的那几个事实上。
   *
   * 注意「在忙」的两个字段要一起处理：`status.onDidChange` 只在状态**变化**时触发，
   * 而 agent 干活时 status 会一直停在 running 不变；如果只在那里续期，
   * 每 2 秒跑一次的 syncState 又只负责"不在 running 就清掉"，
   * 那么 busyUntil 5 秒后就过期，画面会被打回 idle —— 而它其实还在 running。
   * 所以两个入口共用这一份逻辑，running 每次都要把窗口往后推。
   */
  private applyStatus(status: finch.FinchStatusSnapshot, now: number): void {
    this.unreadActive = status.status === 'unread';
    // status 是权威的：它说没未读就立刻作废乐观值（否则读完要等乐观窗口过期）。
    if (!this.unreadActive) this.unreadOptimisticUntil = 0;
    // 等待只置位、不在这里清零：清零交给 listWaits() 与 wait resolved。
    if (status.status === 'waiting') this.waitActive = true;
    if (status.status === 'running') {
      this.busyState = this.busyState ?? 'thinking';
      this.busyUntil = now + BUSY_WINDOW_MS;   // 只要还在跑就一直续期
    } else {
      this.busyState = undefined;
    }
  }

  private async recompute(force = false): Promise<void> {
    const now = Date.now();
    let next: PetState = 'idle';
    if (this.waitActive || this.pendingPrompts.size > 0) next = 'waiting';
    else if (now < this.errorUntil) next = 'error';
    else if (this.busyState && now < this.busyUntil) next = this.busyState;
    else if (this.unreadActive || now < this.unreadOptimisticUntil) next = 'happy';
    await this.publishState(next, force);
  }
  /**
 * Short, localised line shown in the pet's speech bubble. Copy style follows
 * finch-pet's runtime phrases; only states worth narrating get one.
 */
private bubbleFor(state: PetState): string | undefined {
    const pick = (group: string, count: number): string | undefined => {
      const key = `bubble.${group}${1 + this.nextBubbleIndex(group, count)}`;
      const text = this.ctx.i18n.t(key);
      return text && text !== key ? text : undefined;
    };
    switch (state) {
      case 'thinking': return pick('thinking', BUBBLE_TEXTS);
      case 'working': return pick('working', BUBBLE_TEXTS);
      case 'waiting': return pick('waiting', 1);
      case 'happy': return pick('unread', 1);
      default: return undefined;
    }
  }

  /**
   * 挑一句气泡文案：随机，但**不和上一句重复**。
   * thinking/working 会定期重发同一状态来换文案（见 syncState），连着两句一样会很假。
   */
  private nextBubbleIndex(group: string, count: number): number {
    const last = this.bubbleCursor.get(group);
    let index = Math.floor(Math.random() * count);
    if (count > 1 && index === last) index = (index + 1) % count;
    this.bubbleCursor.set(group, index);
    return index;
  }

  /**
   * 点按的回退目标：优先 Finch 报告的未读会话，其次最近有活动的会话。
   * 气泡里的"有好消息"来自运行完成事件，而 Finch 的未读计数可能还没更新，
   * 所以必须有第二个来源，否则点了看起来就是"没反应"。
   */
  private async openUnreadConversation(): Promise<void> {
    const status = await this.ctx.status.get();
    const sessionId = status.latestUnreadSessionId ?? this.lastSessionId;
    if (!sessionId) {
      this.ctx.logger.info('[finch-chan] tap ignored: no unread and no recent session');
      return;
    }
    this.ctx.logger.info(`[finch-chan] tap -> open session ${sessionId}`);
    await this.ctx.navigation.openSession(sessionId);
  }

  /** 记录最近有活动的会话（来自 agent 事件），作为点按回退目标。 */
  noteSession(sessionId?: string): void {
    if (sessionId) this.lastSessionId = sessionId;
  }

  /**
   * 设备上的点按：带着卡片 id 时打开那张卡所属的会话，
   * 否则退回「打开最近未读的会话」。
   */
  private async openConversation(requestId?: string): Promise<void> {
    const prompt = requestId ? this.pendingPrompts.get(requestId) : undefined;
    if (prompt) {
      this.ctx.logger.info(`[finch-chan] tap -> open prompt session ${prompt.sessionId}`);
      await this.ctx.navigation.openSession(prompt.sessionId);
      // 注意：卡片**先留着**。用户可能只是去桌面端看一眼、并不作答；
      // 只有真的结算了才收卡片：设备上作答 → answerPrompt；
      // 在 Finch 里作答/取消 → onInteractionWait 与 syncState 的对账。
      await this.syncState(true);
      return;
    }
    await this.openUnreadConversation();
    // 设备点「查看」/ 点屏幕 = 用户正在去看这条未读。
    // 平台聚合状态要等一拍才会变成“已读”，立刻 status.get() 拿到的还是旧的，
    // 所以先乐观清掉（否则要等下一次兜底对账才回 idle）。
    this.unreadActive = false;
    this.unreadOptimisticUntil = 0;
    await this.recompute();
    // 万一平台仍认为有别的未读（或这条没被标记已读），稍后再核一次。
    setTimeout(() => void this.syncState(true), 500);
  }

  // ── 等待卡片：把 Finch 的等待投影成设备能显示、能选择的一小块内容 ──────────────

  /**
   * 全局等待订阅。载荷里默认只保留标题与选项文本：
   * toolInput / toolResult / 对话正文 / 本地路径一律不上设备，也不落盘。
   *
   * 唯一例外是不可逆（destructive）权限卡：它的命令原文会裁剪到 60 字符后作为
   * 标题推给设备——否则用户是在看不见要执行什么的情况下点「允许」。
   */
  attachWaitListener(): finch.Disposable {
    return this.ctx.events.onInteractionWait((event) => void this.onWaitEvent(event));
  }

  private async onWaitEvent(event: finch.InteractionWaitEvent): Promise<void> {
    this.noteSession(event.sessionId);
    if (event.phase === 'resolved') {
      this.ctx.logger.info(`[finch-chan] wait resolved ${event.requestId}`);
      if (this.pendingPrompts.delete(event.requestId)) {
        this.broadcast({ type: 'command', id: event.requestId, action: 'prompt_clear' });
      }
      await this.syncState(true);
      return;
    }
    const prompt = this.buildPrompt(event.wait, event.sessionId, event.sessionTitle);
    if (!prompt) return;
    this.pendingPrompts.set(prompt.record.requestId, prompt.record);
    const delivered = this.broadcast({ type: 'command', id: prompt.record.requestId, action: 'prompt', kind: prompt.record.kind, title: prompt.title, options: prompt.options, expiresAt: event.wait.expiresAt });
    this.ctx.logger.info(`[finch-chan] wait ${event.wait.kind} pushed to ${delivered} device(s): ${prompt.title}`);
    await this.noteEvent('waiting');
  }

  /** 设备刚上线时对账一次，找回断线期间错过的卡片。 */
  async reconcileWaits(): Promise<void> {
    const waits = await this.ctx.sessions.listWaits();
    if (!waits.length) return;
    const prompt = this.buildPrompt(waits[0], waits[0].sessionId);
    if (!prompt) return;
    this.pendingPrompts.set(prompt.record.requestId, prompt.record);
    this.broadcast({ type: 'command', id: prompt.record.requestId, action: 'prompt', kind: prompt.record.kind, title: prompt.title, options: prompt.options, expiresAt: waits[0].expiresAt });
  }

  /** 把工具名翻成一句自然语言动作，例如 WebSearch → “搜索网络”。 */
  private permissionAction(toolName: string): string {
    const name = (toolName || '').toLowerCase();
    const has = (...needles: string[]) => needles.some((needle) => name.includes(needle));
    if (has('websearch', 'search_web', 'tavily', 'serper', 'fetch')) return this.ctx.i18n.t('perm.search');
    if (has('bash', 'shell', 'terminal', 'exec', 'command')) return this.ctx.i18n.t('perm.command');
    if (has('write', 'edit', 'patch', 'apply')) return this.ctx.i18n.t('perm.writeFile');
    if (has('read')) return this.ctx.i18n.t('perm.readFile');
    if (has('git')) return this.ctx.i18n.t('perm.git');
    if (has('browser', 'playwright', 'puppeteer', 'chrome')) return this.ctx.i18n.t('perm.browser');
    if (has('grep', 'glob', 'find', 'search')) return this.ctx.i18n.t('perm.searchCode');
    if (has('task', 'todo')) return this.ctx.i18n.t('perm.tasks');
    return this.ctx.i18n.t('perm.use', { tool: toolName });
  }

  /**
   * 只给不可逆卡片用：取这次调用真正要执行的内容。
   * Bash 取 command，其他工具退化为裁剪后的参数 JSON；命令可能很长，
   * 上设备前先压成单行并截断（标题最终还会再裁一次）。
   */
  private describePermissionInput(wait: Extract<finch.SessionWait, { kind: 'permission' }>): string | undefined {
    const input = wait.toolInput;
    if (!input || typeof input !== 'object') return undefined;
    const command = (input as Record<string, unknown>).command;
    let source: string | undefined;
    if (typeof command === 'string' && command.trim()) {
      source = command;
    } else {
      try { source = JSON.stringify(input); } catch { source = undefined; }
    }
    if (!source || source === '{}') return undefined;
    const flat = sanitizeBubble(source).replace(/\s+/g, ' ').trim();
    return flat.length > 52 ? `${flat.slice(0, 52)}…` : flat;
  }

  /**
   * 固件用 strlcpy 按字节截断（title 缓冲 161 字节），而 JS 的 length/slice 数的是
   * 字符：全中文的命令可能到 150+ 字节，刚好卡在边界上、末字会被切坏。
   * 所以上设备前再按 UTF-8 字节收紧一次（按码点切，不会切碎代理对）。
   */
  private clampBytes(value: string, maxBytes = 140): string {
    const encoder = new TextEncoder();
    if (encoder.encode(value).length <= maxBytes) return value;
    let kept = '';
    for (const char of value) {
      if (encoder.encode(kept + char).length > maxBytes) break;
      kept += char;
    }
    return `${kept}…`;
  }

  /**
   * 把一张等待卡片折成设备端能显示的内容。
   * 设备最多显示 3 个选项，超出时统一退化为「在 Finch 处理」。
   */
  private buildPrompt(wait: finch.SessionWait, sessionId: string, sessionTitle?: string):
    { record: PendingPrompt; title: string; options: PromptOption[] } | undefined {
    const base = { sessionId, requestId: wait.requestId, optionIds: [] as string[], optionValues: [] as string[], optionActions: [] as PendingPrompt['optionActions'] };

    if (wait.kind === 'permission') {
      // 不可逆操作必须让人看见要执行什么，所以用命令原文（裁剪）当标题；
      // 普通权限卡仍只显示工具名。
      const detail = wait.destructive ? this.describePermissionInput(wait) : undefined;
      // 普通权限卡用自然语言（“帕亚想搜索网络”）；不可逆操作仍然亮出命令原文。
      // 注意：不要用 ⚠ 之类的符号——中文字体里没有这个字形，设备上会显示成豆腐块。
      const natural = this.ctx.i18n.t('perm.title', {
        name: this.assistantName,
        action: this.permissionAction(wait.toolName),
      });
      const title = this.clampBytes((detail ? this.ctx.i18n.t('perm.dangerTitle', { detail }) : sanitizeBubble(natural)).slice(0, 60));
      const options: PromptOption[] = [];
      // 本小程序声明并持有 permissions.destructiveInteractions，所以不可逆操作也
      // 可以在设备上批准；红色标记给「允许」——那才是不可逆的那一步。
      options.push({
        id: 'allow',
        label: this.ctx.i18n.t(wait.destructive ? 'prompt.allowIrreversible' : 'prompt.allow'),
        destructive: wait.destructive === true,
      });
      base.optionValues.push('allow');
      base.optionActions.push('allow');
      options.push({ id: 'deny', label: this.ctx.i18n.t('prompt.deny') });
      base.optionValues.push('deny');
      base.optionActions.push('deny');
      base.optionIds = options.map((option) => option.id);
      return { record: { ...base, kind: 'permission' }, title, options };
    }

    if (wait.kind === 'question') {
      // 答题要在桌面端完成（多选/选项与 header 的映射更可靠），
      // 设备上只显示一个按钮，点了就跳到对应会话。
      const question = wait.questions[0];
      const head = question ? `${question.header}：${question.question}`.replace(/[\r\n]+/g, ' ') : sessionTitle ?? '';
      base.optionIds = ['open'];
      base.optionValues.push('');
      base.optionActions.push('open');
      return {
        record: { ...base, kind: 'question', questionHeader: question?.header },
        title: sanitizeBubble(head).slice(0, 60),
        options: [{ id: 'open', label: this.ctx.i18n.t('prompt.answer') }],
      };
    }

    // 表单需要输入文本，设备上只能提示去哪里处理。
    const title = [sessionTitle, wait.form.title].filter(Boolean).join(' · ').slice(0, 60);
    base.optionIds = ['open'];
    base.optionValues.push('');
    base.optionActions.push('open');
    return { record: { ...base, kind: 'form' }, title, options: [{ id: 'open', label: this.ctx.i18n.t('prompt.openInFinch') }] };
  }

  /** 设备上的选择：允许/拒绝、挑一个选项、或转去桌面端。 */
  async answerPrompt(requestId: string, optionId: string): Promise<void> {
    const record = this.pendingPrompts.get(requestId);
    if (!record) {
      // 设备可能还在显示重载前 / 已过期的卡片——这种点击不能静默吞掉，
      // 否则看起来就像「点了没反应」，无人能诊断。
      this.ctx.logger.warn(`[finch-chan] answer ignored, unknown card: ${requestId}`);
      this.broadcast({ type: 'command', id: requestId, action: 'say', text: this.ctx.i18n.t('prompt.notFound') });
      return;
    }
    const index = record.optionIds.indexOf(optionId);
    if (index < 0) {
      // 设备上报的 optionId 与下发的选项对不上：同样要说出来。
      this.ctx.logger.warn(`[finch-chan] answer ignored, unknown option "${optionId}" for ${requestId}`);
      this.broadcast({ type: 'command', id: requestId, action: 'say', text: this.ctx.i18n.t('prompt.notFound') });
      return;
    }
    const action = record.optionActions[index];

    if (action === 'open') {
      await this.ctx.navigation.openSession(record.sessionId);
    } else {
      const response: finch.SessionWaitResponse = record.kind === 'permission'
        ? { kind: 'permission', allow: action === 'allow' }
        : { kind: 'question', answers: { [record.questionHeader ?? '']: record.optionValues[index] } };
      const result = await this.ctx.sessions.respondToWait(record.sessionId, requestId, response);
      this.ctx.logger.info(`[finch-chan] prompt ${requestId} answered as ${action}: ${result.state}`);
      // 没落地时不能静默清屏（缺 destructiveInteractions 授权、卡片已过期等），
      // 否则设备用户会以为批准成功了。卡片留在屏幕上并说明原因。
      if (result.state === 'forbidden' || result.state === 'not_found') {
        this.broadcast({
          type: 'command',
          id: requestId,
          action: 'say',
          text: this.ctx.i18n.t(result.state === 'forbidden' ? 'prompt.forbidden' : 'prompt.notFound'),
        });
        await this.syncState(true);
        return;
      }
    }

    this.pendingPrompts.delete(requestId);
    this.broadcast({ type: 'command', id: requestId, action: 'prompt_clear' });
    await this.syncState(true);
  }

  /**
   * 以 Finch 的真实状态为准对账：等待卡片 > 未读 > 其它。
   * 设备可能因错过事件而停在旧表情（比如读完消息后还显示“有好消息”），
   * 所以既在用户操作后强制刷新，也由定时器周期性无强制对账。
   */
  async syncState(force = false): Promise<void> {
    const waits = await this.ctx.sessions.listWaits();
    // 对账设备上的卡片：只有已经结算的才收走。
    // 设备端现在会在用户“只去回复、还没回答”时保留卡片，所以这里必须能兜住漏事件的情况。
    const live = new Set(waits.map((wait) => wait.requestId));
    for (const requestId of [...this.pendingPrompts.keys()]) {
      if (live.has(requestId)) continue;
      this.pendingPrompts.delete(requestId);
      this.broadcast({ type: 'command', id: requestId, action: 'prompt_clear' });
    }
    // listWaits() 是“还有没有等待”的权威来源：这里才允许把它清零。
    this.waitActive = waits.length > 0;
    // 和 noteStatus 用同一份逻辑：running 时把「在忙」窗口续期（否则 5 秒后掉回 idle）。
    this.applyStatus(await this.ctx.status.get(), Date.now());
    await this.recompute(force);
  }

  private onConnection(socket: WebSocket): void {
    const connection: Connection = { socket, authenticated: false };
    this.connections.set(socket, connection);
    socket.on('message', (raw) => void this.handleMessage(connection, raw.toString()));
    socket.on('close', () => this.connections.delete(socket));
    socket.on('error', () => this.connections.delete(socket));
  }

  private async handleMessage(connection: Connection, raw: string): Promise<void> {
    let message: ClientMessage | undefined;
    try { message = parseClientMessage(JSON.parse(raw)); } catch { /* handled below */ }
    if (!message) { send(connection.socket, { type: 'error', code: 'bad_message' }); return; }
    if (message.type === 'ping') { send(connection.socket, { type: 'pong' }); return; }
    if (message.type === 'hello') {
      if (message.protocol !== PROTOCOL_VERSION) { send(connection.socket, { type: 'error', code: 'unsupported_protocol' }); return; }
      connection.deviceId = message.deviceId.slice(0, 96);
      connection.chip = message.chip?.slice(0, 16);
      const paired = !!(await this.tokens()).find((token) => token.deviceId === connection.deviceId);
      await this.touch({ deviceId: connection.deviceId, name: message.name ?? connection.deviceId, firmware: message.firmware, ...(connection.chip ? { chip: connection.chip } : {}) });
      // 同一台硬件换过 id（改名 / 旧固件的命名规则）：把旧记录连 token 清掉，
      // 否则菜单里会多出一行永远连不上的「取消配对」。
      const pruned = await this.pruneRenamedDevices(connection.deviceId, connection.chip);
      if (pruned) this.ctx.logger.info(`[finch-chan] cleaned ${pruned} stale record(s) for chip ${connection.chip}`);
      send(connection.socket, { type: 'hello', protocol: PROTOCOL_VERSION, paired, pairing: this.hasPendingPairing(connection.deviceId) }); return;
    }
    if (message.type === 'pair') { await this.pair(connection, message); return; }
    if (message.type === 'auth') { await this.authenticate(connection, message); return; }
    if (message.type === 'tap') {
      // 点按只会做两件事：打开卡片所属会话，或打开最近未读会话。
      if (connection.authenticated) await this.openConversation(message.id);
      return;
    }
    if (message.type === 'answer') {
      if (connection.authenticated) await this.answerPrompt(message.id, message.optionId);
      return;
    }
    if (message.type === 'ack' && connection.authenticated && message.state) await this.updateState(connection.deviceId!, message.state);
    if (message.type === 'status' && connection.authenticated) await this.updateTelemetry(connection.deviceId!, message);
    if (message.type === 'settings' && connection.authenticated) {
      // 设备的当前功能设置（连接建立时 + 每次变化，包括在设备上按 PWR 切律动模式）。
      this.settings.set(message.deviceId, { music: message.music, gain: message.gain, beat: message.beat });
      this.onChange();
    }
  }

  private async pair(connection: Connection, message: Extract<ClientMessage, { type: 'pair' }>): Promise<void> {
    const pending = this.pending.get(message.deviceId);
    if (!pending || pending.expiresAt < Date.now()) {
      // 没人在 Finch 侧开配对窗口：设备屏幕上应该提示“先去 Finch 里开始配对”。
      send(connection.socket, { type: 'error', code: 'pairing_not_started' }); return;
    }
    // 两种确认方式：
    //  1) 设备屏幕上按「确认」→ 不带码。人在 Finch 侧开过窗口，又在设备旁边按了按钮；
    //  2) 带配对码 → 必须完全对得上（老流程，也用于没屏幕的设备）。
    if (message.code) {
      const expected = Buffer.from(pending.code);
      const supplied = Buffer.from(message.code);
      if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
        send(connection.socket, { type: 'error', code: 'pairing_denied' }); return;
      }
    } else {
      this.ctx.logger.info(`[finch-chan] ${message.deviceId} confirmed pairing on its screen`);
    }
    this.pending.delete(message.deviceId);
    const token = crypto.randomBytes(32).toString('base64url');
    const tokens = (await this.tokens()).filter((entry) => entry.deviceId !== message.deviceId);
    const now = new Date().toISOString();
    tokens.push({ deviceId: message.deviceId, name: message.deviceId, pairedAt: now, lastSeenAt: now, ...(connection.chip ? { chip: connection.chip } : {}), tokenHash: hash(token) });
    await this.ctx.secrets.set(TOKEN_KEY, JSON.stringify(tokens));
    connection.deviceId = message.deviceId; connection.authenticated = true;
    await this.touch({ deviceId: message.deviceId, name: message.deviceId, ...(connection.chip ? { chip: connection.chip } : {}) });
    send(connection.socket, { type: 'paired', token });
    await this.publishState(this.state, true);
    this.pushSounds(connection);   // 认证后把通知音推给设备（不用内置到固件）
  }

  private async authenticate(connection: Connection, message: Extract<ClientMessage, { type: 'auth' }>): Promise<void> {
    const token = (await this.tokens()).find((entry) => entry.deviceId === message.deviceId);
    if (!token || !crypto.timingSafeEqual(Buffer.from(token.tokenHash), Buffer.from(hash(message.token)))) { send(connection.socket, { type: 'error', code: 'unauthorized' }); return; }
    connection.deviceId = message.deviceId; connection.authenticated = true;
    await this.touch({ deviceId: token.deviceId, name: token.name });
    send(connection.socket, { type: 'auth', ok: true });
    await this.publishState(this.state, true);
    this.pushSounds(connection);   // 认证后把通知音推给设备（不用内置到固件）
    // 设备刚上线：把可能错过的等待卡片补一次。
    await this.reconcileWaits();
  }

  /** 把通知音推给设备（二进制帧，每段 ~16KB，只在认证后推一次）。 */
  private pushSounds(connection: Connection): void {
    if (!connection.authenticated || connection.socket.readyState !== WebSocket.OPEN) return;
    let sent = 0;
    for (const frame of soundFrames()) {
      connection.socket.send(frame);
      sent += 1;
    }
    this.ctx.logger.info(`[finch-chan] pushed ${sent} notification sound(s) to ${connection.deviceId}`);
  }

  private async tokens(): Promise<PairedToken[]> {
    const raw = await this.ctx.secrets.get(TOKEN_KEY);
    try { const parsed = raw ? JSON.parse(raw) : []; return Array.isArray(parsed) ? parsed as PairedToken[] : []; } catch { return []; }
  }
  private async devices(): Promise<DeviceRecord[]> { return (await this.ctx.storage.get<DeviceRecord[]>(DEVICES_KEY)) ?? []; }
  private async touch(input: Pick<DeviceRecord, 'deviceId' | 'name' | 'firmware' | 'chip'>): Promise<void> {
    const devices = await this.devices(); const now = new Date().toISOString();
    const existing = devices.find((device) => device.deviceId === input.deviceId);
    if (existing) { existing.lastSeenAt = now; existing.name = input.name; if (input.firmware) existing.firmware = input.firmware; if (input.chip) existing.chip = input.chip; }
    else devices.push({ ...input, pairedAt: now, lastSeenAt: now });
    await this.ctx.storage.set(DEVICES_KEY, devices); this.onChange();
  }

  /**
   * 同一台硬件换了 id 时（改名字 / 换过固件命名规则），把旧记录连 token 一起清掉，
   * 免得菜单里堆一串再也连不上的「取消配对」行。
   *
   * 判定依据是设备自报的 chip（芯片 MAC 低 16 位），不是可以随便填的 deviceId。
   * 代价：局域网里有人伪造别人的 chip 可以把那条记录踢掉（对方需重新配对），
   * 但拿不到任何权限，所以可以接受。
   */
  private async pruneRenamedDevices(deviceId: string, chip?: string): Promise<number> {
    if (!chip) return 0;
    const devices = await this.devices();
    const staleIds = new Set(devices.filter((device) => device.chip === chip && device.deviceId !== deviceId).map((device) => device.deviceId));
    if (!staleIds.size) return 0;
    await this.ctx.storage.set(DEVICES_KEY, devices.filter((device) => !staleIds.has(device.deviceId)));
    const tokens = (await this.tokens()).filter((token) => !staleIds.has(token.deviceId));
    await this.ctx.secrets.set(TOKEN_KEY, JSON.stringify(tokens));
    this.onChange();
    return staleIds.size;
  }
  private async updateState(deviceId: string, state: PetState): Promise<void> {
    const devices = await this.devices(); const device = devices.find((entry) => entry.deviceId === deviceId);
    if (device) { device.state = state; device.lastSeenAt = new Date().toISOString(); await this.ctx.storage.set(DEVICES_KEY, devices); this.onChange(); }
  }

  /**
   * 设备每 15 秒上报一次健康状态（固件 sendStatus）。
   * 以前协议里没有这个类型，桥接会把它收回成 bad_message 错误——日志里每 15 秒一条。
   */
  private async updateTelemetry(deviceId: string, message: Extract<ClientMessage, { type: 'status' }>): Promise<void> {
    const devices = await this.devices();
    const device = devices.find((entry) => entry.deviceId === deviceId);
    if (!device) return;
    device.lastSeenAt = new Date().toISOString();
    if (message.wifi !== undefined) device.rssi = message.wifi;
    if (message.freeHeap !== undefined) device.freeHeap = message.freeHeap;
    if (message.uptimeMs !== undefined) device.uptimeMs = message.uptimeMs;
    await this.ctx.storage.set(DEVICES_KEY, devices);
  }
}

export function eventToState(event: finch.AgentEvent): PetState | undefined {
  if (event.kind === 'error' || event.kind === 'interrupted') return 'error';
  if (event.kind === 'permission_request' || event.executionPhase === 'waiting_user') return 'waiting';
  if (event.kind === 'tool_use' || event.executionPhase === 'tool_running') return 'working';
  // 注意：这里故意不把"运行完成"当作未读。未读状态只由 Finch 自己的 status 决定，
  // 否则设备会在用户已读之后仍然停在"有好消息"上。
  if (event.kind === 'session_status' && event.runStatus === 'idle') return 'idle';
  if (event.executionPhase === 'starting' || event.executionPhase === 'requesting' || event.executionPhase === 'streaming') return 'thinking';
  return undefined;
}

export function statusToState(status: finch.FinchStatusSnapshot): PetState { return status.status === 'waiting' ? 'waiting' : status.status === 'running' ? 'thinking' : status.status === 'unread' ? 'happy' : 'idle'; }
export { isPetState };
