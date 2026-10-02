/**
 * Which documents belong in the list the user is actually looking at.
 *
 * When a change concerns a single row — re-filing a document, say — the list patches that row in
 * place rather than reloading, so the scroll position survives and nothing flashes. The question
 * "does this row still belong here?" is what decides whether the patched row stays, moves or
 * leaves, and it is worth stating once, away from the DOM, so it can be tested on its own.
 */

/** Unclassified is not a tag a document carries; it is the absence of every tag. */
export const UNCLASSIFIED = 'default';

/** The tag the list is scoped to: a tag id, {@link UNCLASSIFIED}, or `null` for every document. */
export type Scope = string | null;

/** Whether a document carrying `documentTags` belongs in a list scoped to `scope`. */
export function inScope(documentTags: readonly string[], scope: Scope): boolean {
  if (scope === null) return true;
  if (scope === UNCLASSIFIED) return documentTags.length === 0;
  return documentTags.includes(scope);
}
