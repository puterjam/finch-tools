import type * as finch from 'finch';
import { TokenStore } from './auth.js';
import { PairingManager } from './pairing.js';
import { BridgeServer } from './server.js';

export function activate(ctx: finch.MiniToolContext): void {
  ctx.icons.register('cli-bridge-icons', {
    unlink: {
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h2a5 5 0 0 1 0 10h-2m-6 0H7A5 5 0 0 1 7 7h2"/></svg>',
    },
  });

  const tokens = new TokenStore(ctx.secrets);

  let menuHandle: (finch.Disposable & { notifyUpdate(): void }) | undefined;
  const pairing = new PairingManager(ctx, tokens, () => menuHandle?.notifyUpdate());

  const server = new BridgeServer(ctx, tokens, pairing);
  server.start().catch((err) => ctx.logger.error('[cli-bridge] failed to start bridge server', err));
  ctx.subscriptions.push({ dispose: () => void server.stop() });

  menuHandle = ctx.settingsMenu.register({
    async getMenu() {
      const clients = await tokens.list();
      if (clients.length === 0) {
        return [
          {
            id: 'empty',
            label: ctx.i18n.t('menu.empty.label'),
            description: ctx.i18n.t('menu.empty.description'),
            disabled: true,
          },
        ];
      }
      const rows: finch.ComposerActionMenuItem[] = [];
      for (const client of clients) {
        rows.push({
          id: `client:${client.tokenId}`,
          label: client.clientName,
          description: ctx.i18n.t('menu.client.description', {
            paired: formatRelative(ctx, client.pairedAt),
            lastUsed: formatRelative(ctx, client.lastUsedAt),
          }),
          disabled: true,
        });
        rows.push({ id: `revoke:${client.tokenId}`, label: ctx.i18n.t('menu.revoke.label'), iconName: 'ext:unlink' });
        rows.push({ id: `sep:${client.tokenId}`, label: '', separator: true });
      }
      rows.pop(); // drop the trailing separator
      return rows;
    },
    async execute(_context: finch.SettingsMenuContext, itemId: string) {
      if (!itemId.startsWith('revoke:')) return;
      const tokenId = itemId.slice('revoke:'.length);
      await tokens.revokeById(tokenId);
    },
  });
  ctx.subscriptions.push(menuHandle);
}

function formatRelative(ctx: finch.MiniToolContext, iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return ctx.i18n.t('time.justNow');
  if (minutes < 60) return ctx.i18n.t('time.minutesAgo', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return ctx.i18n.t('time.hoursAgo', { n: hours });
  const days = Math.round(hours / 24);
  return ctx.i18n.t('time.daysAgo', { n: days });
}
