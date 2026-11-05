export type IndexSkipReason = 'empty_file' | 'no_text' | 'image_no_text';

/** A valid source without searchable content is a skip, not a processing failure. */
export class IndexSkipError extends Error {
  constructor(readonly reason: IndexSkipReason) {
    super({ empty_file: 'The source file is empty.', no_text: 'The source contains no searchable text.', image_no_text: 'No text was recognized in the image.' }[reason]);
    this.name = 'IndexSkipError';
  }
}
