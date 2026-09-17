export const PROTOCOL_VERSION = 1;
export const PET_STATES = ['idle', 'thinking', 'working', 'waiting', 'happy', 'error'] as const;
export type PetState = (typeof PET_STATES)[number];

/**
 * 收音灵敏度：0=低、1=中、2=高（固件里对应麦克风增益 1.8 / 2.4 / 3.0）。
 */
export const GAIN_LEVELS = [0, 1, 2] as const;
export type GainLevel = (typeof GAIN_LEVELS)[number];

export function isGainLevel(value: unknown): value is GainLevel {
  return typeof value === 'number' && (GAIN_LEVELS as readonly number[]).includes(value);
}

/** 等待卡片的种类，与 Finch 的 SessionWaitKind 对应。 */
export type PromptKind = 'permission' | 'question' | 'form';

/** 下发到设备的一个选项（只含可展示文本，不含任何工具参数）。 */
export interface PromptOption {
  id: string;
  label: string;
  destructive?: boolean;
}

export interface DeviceRecord {
  deviceId: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string;
  firmware?: string;
  state?: PetState;
  /** 芯片 MAC 低 16 位（设备自报）：用来识别“同一台硬件换了 id”。 */
  chip?: string;
  /** 设备每 15 秒上报一次的健康状态（RSSI dBm / 剩余堆 / 运行时长）。 */
  rssi?: number;
  freeHeap?: number;
  uptimeMs?: number;
}

export interface PairedToken extends DeviceRecord { tokenHash: string }
export interface PendingPair { deviceId: string; code: string; expiresAt: number }

export type ClientMessage =
  | { type: 'hello'; protocol: number; deviceId: string; name?: string; firmware?: string; chip?: string }
  /** 配对：code 可选。设备屏幕上按「确认」时不带码（靠 Finch 侧已开的配对窗口授权）。 */
  | { type: 'pair'; deviceId: string; code?: string }
  | { type: 'auth'; deviceId: string; token: string }
  | { type: 'ack'; id?: string; state?: PetState }
  | { type: 'tap'; action: 'open_conversation'; id?: string }
  /** 用户在设备屏幕上选了某个选项。 */
  | { type: 'answer'; id: string; optionId: string }
  /** 设备遥测（也当保活）；缺字段表示设备没上报。 */
  | { type: 'status'; deviceId: string; wifi?: number; uptimeMs?: number; freeHeap?: number }
  /** 设备当前的功能设置（连接建立时 + 每次变化都上报，包括按硬件 PWR 键切的律动模式）。 */
  | { type: 'settings'; deviceId: string; music: boolean; gain: GainLevel; beat: boolean }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'hello'; protocol: number; paired: boolean; /** 是否有未过期的配对窗口（决定设备要不要弹确认卡片）。 */ pairing?: boolean }
  /** 用户在 Finch 侧刚开了配对窗口：设备可以弹确认卡片了。 */
  | { type: 'pair_offer' }
  | { type: 'paired'; token: string }
  | { type: 'auth'; ok: true }
  | { type: 'error'; code: string }
  | { type: 'pong' }
  | { type: 'command'; id: string; action: 'state'; state: PetState; bubble?: string }
  | { type: 'command'; id: string; action: 'say'; text: string }
  /** 等待卡片：标题与选项都是可直接上屏的文本。expiresAt 供固件做倒计时（当前版本忽略）。 */
  | { type: 'command'; id: string; action: 'prompt'; kind: PromptKind; title: string; options: PromptOption[]; expiresAt?: string }
  | { type: 'command'; id?: string; action: 'prompt_clear' }
  /** 让设备清掉 WiFi 凭证、重启进配网模式。 */
  | { type: 'command'; id: string; action: 'wifi-reset' }
  /** 下发功能设置；三个字段都可选，只改传了的那些。 */
  | { type: 'command'; id: string; action: 'settings'; music?: boolean; gain?: GainLevel; beat?: boolean };

export function isPetState(value: unknown): value is PetState {
  return typeof value === 'string' && (PET_STATES as readonly string[]).includes(value);
}

/**
 * 设备侧（固件内部）的状态名 → 协议状态名。
 *
 * 固件里 `petStateName()` 用的是设备自己的词汇：Success（有未读/完成）、Sleeping、Speaking。
 * 存量固件（≤0.3.3）在 ack 里报的就是这几个名字，而它们不在 `PET_STATES` 里 ——
 * 直接校验会整条判成 bad_message（串口里刷 `[relay] server error: bad_message`）。
 * 这里做一次归一化：能对上就翻译，完全不认识的才丢弃。
 */
const DEVICE_STATE_ALIASES: Record<string, PetState> = {
  success: 'happy',     // 固件的 Success = 协议的 happy
  sleeping: 'idle',     // 睡着了：对桌面端来说就是闲下来了
  speaking: 'working',  // 在播报/说话：算在忙
};

/** 把设备可能发来的状态名归一化成协议状态；认不出来返回 undefined。 */
export function normalizeDeviceState(value: unknown): PetState | undefined {
  if (isPetState(value)) return value;
  if (typeof value === 'string' && value in DEVICE_STATE_ALIASES) return DEVICE_STATE_ALIASES[value];
  return undefined;
}

export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.type === 'hello' && typeof value.protocol === 'number' && typeof value.deviceId === 'string') return value as ClientMessage;
  if (value.type === 'pair' && typeof value.deviceId === 'string' && (value.code === undefined || typeof value.code === 'string')) {
    return { type: 'pair', deviceId: value.deviceId, ...(typeof value.code === 'string' ? { code: value.code } : {}) };
  }
  if (value.type === 'auth' && typeof value.deviceId === 'string' && typeof value.token === 'string') return value as ClientMessage;
  if (value.type === 'ack') {
    // state 可选；带了就归一化（兼容设备内部词汇），完全不认识才丢整条。
    if (value.state === undefined) return { type: 'ack', ...(typeof value.id === 'string' ? { id: value.id } : {}) };
    const state = normalizeDeviceState(value.state);
    if (!state) return undefined;
    return { type: 'ack', state, ...(typeof value.id === 'string' ? { id: value.id } : {}) };
  }
  if (value.type === 'tap' && value.action === 'open_conversation') {
    return { type: 'tap', action: 'open_conversation', ...(typeof value.id === 'string' ? { id: value.id } : {}) };
  }
  if (value.type === 'answer' && typeof value.id === 'string' && typeof value.optionId === 'string') return value as ClientMessage;
  if (value.type === 'status' && typeof value.deviceId === 'string') {
    // 设备的健康上报：字段都当作可选，缺了也不影响解析。
    return {
      type: 'status',
      deviceId: value.deviceId,
      ...(typeof value.wifi === 'number' ? { wifi: value.wifi } : {}),
      ...(typeof value.uptimeMs === 'number' ? { uptimeMs: value.uptimeMs } : {}),
      ...(typeof value.freeHeap === 'number' ? { freeHeap: value.freeHeap } : {}),
    };
  }
  if (value.type === 'settings' && typeof value.deviceId === 'string' && typeof value.music === 'boolean' && typeof value.beat === 'boolean' && isGainLevel(value.gain)) {
    return { type: 'settings', deviceId: value.deviceId, music: value.music, gain: value.gain, beat: value.beat };
  }
  if (value.type === 'ping') return { type: 'ping' };
  return undefined;
}

/** Bubble copy is user-visible on a small screen: one short line, no control characters. */
export function sanitizeBubble(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);
}

export function sanitizeText(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
}
