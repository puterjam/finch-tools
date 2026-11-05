/** Requests which must never cross a library switch, including delayed mutations. */
const scopedActions = new Set([
  'enterLibrary', 'page', 'locate', 'tags', 'tagCreate', 'tagRename', 'tagColor',
  'tagDelete', 'tagToggle', 'tagReorder', 'search', 'reveal', 'sync', 'scanPause', 'libraryReveal',
]);
export function isLibraryScoped(type: string): boolean { return scopedActions.has(type); }
