import type * as finch from 'finch';

export const QUESTION_KEYS = ['search', 'organize', 'article', 'summarize', 'compare', 'cleanup', 'sync'] as const;
const icons: Record<(typeof QUESTION_KEYS)[number], string> = {
  search: 'filter', organize: 'folder', article: 'globe', summarize: 'file-text',
  compare: 'list', cleanup: 'clipboard-check', sync: 'timer',
};
interface Snapshot { documents: number; lastIndexedAt: number | null }
interface Options {
  snapshot(): Promise<Snapshot | null>;
  locale(): string | undefined | Promise<string | undefined>;
  t(key: string, values?: Record<string, string | number>): string;
  showGuide(): Promise<void>;
}

/** Reads catalogue metadata only. Templates stay in the active Composer, with no navigation or send. */
export function createKnowledgeComposer(options: Options): finch.ComposerActionProvider {
  const { snapshot, t, locale } = options;
  return {
    async getBadge() { return undefined; },
    async getMenu() {
      const data = await snapshot();
      const menu: finch.ComposerActionMenuItem[] = data ? [
        { id: 'library-count', label: t('composer.library'), description: t('composer.documents', { count: data.documents }), iconName: 'book', disabled: true },
        { id: 'library-indexed', label: t('composer.lastIndexed'), description: data.lastIndexedAt === null
          ? t('composer.neverIndexed')
          : new Intl.DateTimeFormat(await locale(), { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(data.lastIndexedAt)),
          iconName: 'timer', disabled: true, hoverText: t('composer.indexedHint') },
      ] : [{ id: 'library-unavailable', label: t('library.unavailable'), iconName: 'folder', disabled: true }];
      menu.push({ id: 'guide-divider', label: '', separator: true },
        { id: 'guide', label: t('composer.guide'), iconName: 'message-circle', hoverText: t('composer.guideText') });
      const keys = data ? QUESTION_KEYS.filter(key => data.documents > 0 || key === 'article') : [];
      if (keys.length) menu.push({ id: 'templates-divider', label: '', separator: true });
      for (const key of keys) menu.push({ id: key, label: t(`composer.${key}.label`),
        description: t(`composer.${key}.hint`), iconName: icons[key], hoverText: t(`ask.${key}`) });
      return menu;
    },
    async execute(_context, itemId, actions) {
      if (itemId === 'guide') { await options.showGuide(); return; }
      if (!QUESTION_KEYS.some(key => key === itemId)) return;
      const data = await snapshot();
      if (!data) throw new Error(t('library.unavailable'));
      if (!data.documents && itemId !== 'article') throw new Error(t('composer.empty'));
      // Append instead of discarding an existing draft. The user edits and sends it themselves.
      await actions.composer.fill(t(`ask.${itemId}`), { mode: 'append' });
    },
  };
}
