import type * as finch from 'finch';
import { FinchChanBridge, SYNC_INTERVAL_MS, eventToState, isPetState, statusToState } from './bridge.js';
import type { GainLevel } from './protocol.js';

const TOOL_NAME = 'finchchan_control';

export function activate(ctx: finch.MiniToolContext): void {
  // 图标：Finch 只认内置 Lucide 名或 `ext:<packId>/<iconId>`；
  // 名字对不上时会把字面量当图标渲染出来（曾经把 rotate-ccw 直接写进菜单就看到过）。
  // 所以自己注册一个 SVG 包，菜单用到的图标全部自带，不赌内置名字。
  ctx.subscriptions.push(ctx.icons.register('finchchan', {
    refresh: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>', description: '重新配网' },
    link: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>', description: '配对' },
    unlink: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/></svg>', description: '取消配对' },
  }));

  // 不注册工具栏按钮：日常交互都在设置菜单（连接 / 配对）与工具调用里。
  const bridge = new FinchChanBridge(ctx, () => {});
  void bridge.start().catch((error) => ctx.logger.error('[finch-chan] unable to start LAN server', error));
  ctx.subscriptions.push({ dispose: () => void bridge.stop() });

  // 等待卡片：把 Finch 的权限卡 / 提问卡投到设备屏幕，并把设备上的选择回传。
  ctx.subscriptions.push(bridge.attachWaitListener());

  ctx.subscriptions.push(ctx.events.onAgentEvent((event) => {
    // 记住最近活动的会话，设备点按时用作回退目标。
    bridge.noteSession(event.sessionId);
    const state = eventToState(event);
    if (state) void bridge.noteEvent(state);   // 只登记事实，由桥接按优先级仲裁
  }));
  ctx.subscriptions.push(ctx.status.onDidChange((status) => void bridge.noteStatus(status)));
  // 周期对账：订阅正常时用不到，只用来兜住漏事件（比如用户读完消息时
  // Finch 那边没有状态变化事件可发）。2 秒一次，延迟上限很短，开销可忽略。
  const syncTimer = setInterval(() => void bridge.syncState(), SYNC_INTERVAL_MS);
  ctx.subscriptions.push({ dispose: () => clearInterval(syncTimer) });
  // 气泡文案轮换：单独一条 1 秒的定时器去问桥接"到点了吗"，
  // 这样实际间隔精确等于 BUBBLE_ROTATE_MS（挂在上面那条 2 秒对账上会变成 ~6 秒）。
  const bubbleTimer = setInterval(() => void bridge.rotateBubble(), 1_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(bubbleTimer) });
  ctx.subscriptions.push(ctx.notifications.onDidPost((notification) => {
    // 通知用来把“刚发生的事”立刻反映到设备上：
    //   background-done → 立刻显示“有未读”（不等 status 轮询）
    //   waiting / error  → 直接切成对应状态
    // 真正该显示哪个，由桥接的状态仲裁按 waiting > working > unread > idle 决定，
    // 所以这里也只是登记事实。
    if (notification.kind === 'error') void bridge.noteEvent('error');
    else if (notification.kind === 'waiting') void bridge.noteEvent('waiting');
    else if (notification.kind === 'background-done') void bridge.noteEvent('happy');
  }));

  ctx.subscriptions.push(ctx.tools.register({
    name: TOOL_NAME,
    title: 'FinchChan Control',
    description: `Control a paired FinchChan StackChan pet without exposing conversation content.
action:
  status — report LAN bridge, current state, and paired devices
  pair — create a 10-minute pairing code for device_id
  say — send bounded visible text to paired devices (requires text)
  state — set one finite pet state: idle, thinking, working, waiting, happy, error (requires state)
  unpair — revoke one device token and disconnect it (requires device_id)`,
    inputSchema: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['status', 'pair', 'say', 'state', 'unpair'] },
        device_id: { type: 'string', description: 'StackChan device id, required by pair and unpair.' },
        text: { type: 'string', description: 'Short visible pet message, required by say; capped at 120 characters.' },
        state: { type: 'string', enum: ['idle', 'thinking', 'working', 'waiting', 'happy', 'error'], description: 'Visible pet state, required by state.' },
      }, required: ['action'],
    }, risk: 'medium',
    async execute(input) {
      const value = input as { action: string; device_id?: string; text?: string; state?: unknown };
      try {
        if (value.action === 'status') return textResult(JSON.stringify(await bridge.snapshot(), null, 2));
        if (value.action === 'pair') {
          const pairing = bridge.createPairing(String(value.device_id ?? ''));
          return textResult(`Pairing ready for ${pairing.deviceId}. Tap Confirm on the device screen within 10 minutes.`);
        }
        if (value.action === 'say') {
          if (!value.text?.trim()) return errorResult('text is required for action=say');
          return textResult(`Sent to ${await bridge.command('say', value.text)} connected device(s).`);
        }
        if (value.action === 'state') {
          if (!isPetState(value.state)) return errorResult('state must be idle, thinking, working, waiting, happy, or error');
          await bridge.publishState(value.state, true); return textResult(`Pet state set to ${value.state}.`);
        }
        if (value.action === 'unpair') {
          if (!value.device_id) return errorResult('device_id is required for action=unpair');
          return textResult((await bridge.unpair(value.device_id)) ? 'Device unpaired.' : 'No paired device has that device_id.');
        }
        return errorResult('Unknown action.');
      } catch (error) { return errorResult(error instanceof Error ? error.message : 'FinchChan control failed'); }
    },
  }));

  // 设置菜单：桥接状态 + 功能设置 + 每台设备的配对 / 取消配对。
  ctx.subscriptions.push(ctx.settingsMenu.register({
    async getMenu() {
      const snapshot = await bridge.snapshot();
      const rows: finch.ComposerActionMenuItem[] = [{
        id: 'bridge',
        label: 'FinchChan',
        description: snapshot.started
          ? (snapshot.discoveryPort ? ctx.i18n.t('settings.listeningShort') : ctx.i18n.t('settings.listening'))
          : ctx.i18n.t('settings.stopped'),
        iconName: 'bird',
        disabled: true,
      }];

      // 功能设置：三行各自在右侧显示当前状态（开/关、低/中/高）。
      // 状态来自设备上报（见 bridge.settingsSnapshot），所以按硬件 PWR 键切的律动模式也会同步过来。
      const features = bridge.settingsSnapshot();
      const online = features.connected > 0;
      const featureRow = (id: string, label: string, value: string): finch.ComposerActionMenuItem => ({
        id,
        label,
        description: online ? value : ctx.i18n.t('settings.noOnlineDevice'),
        disabled: !online,
      });
      rows.push({
        id: 'features',
        label: ctx.i18n.t('settings.features'),
        iconName: 'sliders-horizontal',
        hoverText: online && features.mixed ? ctx.i18n.t('settings.mixed') : ctx.i18n.t('settings.featuresHint'),
        children: [
          featureRow('music:toggle', ctx.i18n.t('settings.musicMode'), onOffText(ctx.i18n, features.music)),
          featureRow('gain:cycle', ctx.i18n.t('settings.micGain'), gainText(ctx.i18n, features.gain)),
          featureRow('beat:toggle', ctx.i18n.t('settings.beatDance'), onOffText(ctx.i18n, features.beat)),
        ],
      });

      if (!snapshot.devices.length) {
        rows.push({ id: 'hint', label: ctx.i18n.t('settings.noDevice'), disabled: true });
        return rows;
      }
      let pairedCount = 0;
      for (const device of snapshot.devices) {
        const paired = await bridge.isPaired(device.deviceId);
        if (paired) pairedCount += 1;
        rows.push(paired
          ? { id: `unpair:${device.deviceId}`, label: ctx.i18n.t('settings.unpair'), description: device.deviceId, iconName: 'ext:finchchan/unlink', disabled: false }
          : { id: `pair:${device.deviceId}`, label: ctx.i18n.t('settings.pair'), description: device.deviceId, iconName: 'ext:finchchan/link' });
      }
      if (pairedCount) {
        rows.push({ id: 'wifi-reset', label: ctx.i18n.t('settings.wifiReset'), description: ctx.i18n.t('settings.wifiResetHint'), iconName: 'ext:finchchan/refresh' });
      }
      return rows;
    },
    async execute(_context, itemId) {
      // 功能设置：点一下就在状态间切换（开关 / 低中高），改完设备会回报状态。
      if (itemId === 'music:toggle' || itemId === 'gain:cycle' || itemId === 'beat:toggle') {
        const features = bridge.settingsSnapshot();
        if (!features.connected) { ctx.ui.notify(ctx.i18n.t('settings.noOnlineDevice'), 'warning'); return; }
        let sent = 0;
        let label = '';
        let value = '';
        if (itemId === 'music:toggle') {
          const next = !(features.music ?? false);
          sent = bridge.sendSettings({ music: next });
          label = ctx.i18n.t('settings.musicMode');
          value = onOffText(ctx.i18n, next);
        } else if (itemId === 'gain:cycle') {
          const next = (((features.gain ?? 1) + 1) % 3) as GainLevel;   // 低 → 中 → 高 → 低
          sent = bridge.sendSettings({ gain: next });
          label = ctx.i18n.t('settings.micGain');
          value = gainText(ctx.i18n, next);
        } else {
          const next = !(features.beat ?? true);
          sent = bridge.sendSettings({ beat: next });
          label = ctx.i18n.t('settings.beatDance');
          value = onOffText(ctx.i18n, next);
        }
        ctx.ui.notify(sent ? ctx.i18n.t('settings.featuresSent', { name: label, value })
                           : ctx.i18n.t('settings.featuresFailed'), sent ? 'info' : 'warning');
        return;
      }
      if (itemId.startsWith('unpair:')) {
        const removed = await bridge.unpair(itemId.slice(7));
        ctx.ui.notify(removed ? ctx.i18n.t('settings.unpaired') : ctx.i18n.t('settings.notFound'), removed ? 'info' : 'warning');
        return;
      }
      if (itemId.startsWith('pair:')) {
        const pairing = bridge.createPairing(itemId.slice(5));
        // 配对码直接弹成 toast；但新固件根本不需要你输码：
        // 设备屏幕上会弹「确认 / 取消」，按一下就行。
        ctx.ui.notify(ctx.i18n.t('settings.pairReady', { code: pairing.code }), 'info');
        return;
      }
      if (itemId === 'wifi-reset') {
        const sent = await bridge.requestWifiReset();
        ctx.ui.notify(sent ? ctx.i18n.t('settings.wifiResetSent') : ctx.i18n.t('settings.notFound'), sent ? 'info' : 'warning');
      }
    },
  }));
}

function textResult(text: string): finch.ToolResult { return { content: [{ type: 'text', text }] }; }
function errorResult(text: string): finch.ToolResult { return { content: [{ type: 'text', text }], isError: true }; }

/** 开关状态的中文/英文文案（未知 → “－”）。 */
function onOffText(i18n: finch.MiniToolI18n, value: boolean | undefined): string {
  if (value === undefined) return i18n.t('settings.unknown');
  return i18n.t(value ? 'settings.on' : 'settings.off');
}

/** 收音灵敏度的文案：0=低、1=中、2=高。 */
function gainText(i18n: finch.MiniToolI18n, gain: GainLevel | undefined): string {
  if (gain === undefined) return i18n.t('settings.unknown');
  return i18n.t(gain === 0 ? 'settings.gainLow' : gain === 1 ? 'settings.gainMid' : 'settings.gainHigh');
}

// Exported for the package smoke test and firmware-side protocol validation.
export { PET_STATES, parseClientMessage, sanitizeText } from './protocol.js';
