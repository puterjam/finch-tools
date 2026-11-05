export type CoverageState = 'indexed' | 'partial' | 'missing' | 'unavailable';
export type SourceState = 'same' | 'changed' | 'missing' | 'unavailable';
export type DocumentState = 'processing' | 'ready' | 'outdated' | 'pending' | 'incomplete' | 'failed' | 'source_missing' | 'source_unavailable' | 'unverified';

/** Choose one actionable, user-facing state without confusing old passages with current content. */
export function resolveDocumentStatus(coverage: CoverageState, source: SourceState, attempt?: 'processing' | 'failed'): DocumentState {
  if (attempt === 'processing') return 'processing';
  if (source === 'missing') return 'source_missing';
  if (source === 'unavailable') return 'source_unavailable';
  if (attempt === 'failed') return 'failed';
  if (source === 'changed') return 'outdated';
  if (coverage === 'missing') return 'pending';
  if (coverage === 'partial') return 'incomplete';
  if (coverage === 'unavailable') return 'unverified';
  return 'ready';
}
