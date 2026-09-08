import { StreamLanguage, type StreamParser } from '@codemirror/language';

// AntV Infographic is a declarative, line-oriented DSL (NOT JSON). Its fence
// body looks like:
//
//   infographic bar            # declare the chart type
//   theme default              # theme preset (value is plain)
//   template mytemplate        # template preset (value is plain)
//   data                       # block header (keyword)
//     title 'A title'          # key + value (value is plain)
//     desc  Show core stats
//     items
//       - label  Brand         # key / value pair
//         value  85
//         time   2021
//   # line comment
//
// Mirrors the VS Code TextMate grammar `infographic.tmLanguage.json`: scope
// `source.infographic`, tokens `keyword.control.*`, `entity.name.type.*`,
// `support.type.property-name.*`, `meta.value.*`, `string.quoted.*`,
// `comment.line.number-sign.*`. Only the *names* (keywords, chart type,
// property names) are highlighted; their values stay at the default text
// colour (that's the "meta.value" part, deliberately left unstyled).
//
// Implemented as a lightweight CodeMirror 5-style StreamLanguage so it adds no
// external dependency and stays inside the package's bundle budget. Token
// names returned from `token()` map onto standard @lezer/highlight tags, so
// the existing One Dark `markdownHighlight` palette colours them automatically.

interface InfographicState {
  // True right after the `infographic` keyword, so the immediately following
  // word is treated as the chart type (entity.name.type / typeName).
  afterDecl: boolean;
  // True right after a property name / keyword, so the rest of the line is
  // read as an unstyled value (meta.value) rather than re-highlighted.
  inValue: boolean;
}

const infographicLanguage: StreamParser<InfographicState> = {
  name: 'infographic',
  startState(): InfographicState {
    return { afterDecl: false, inValue: false };
  },
  copyState(state): InfographicState {
    return { afterDecl: state.afterDecl, inValue: state.inValue };
  },
  token(stream, state) {
    // A new line clears both flags.
    if (stream.sol()) {
      state.afterDecl = false;
      state.inValue = false;
    }

    // Leading indentation is irrelevant to the DSL.
    if (stream.eatSpace()) return null;

    // Line comment: "#" to end of line.
    if (stream.match(/#.*$/)) {
      state.afterDecl = false;
      state.inValue = false;
      return 'comment';
    }

    // Right after a name/keyword — the rest of this line is its value and
    // should stay unstyled (meta.value).
    if (state.inValue) {
      state.inValue = false;
      stream.skipToEnd();
      return null;
    }

    // Quoted strings (double or single), with backslash escapes.
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      const quote = ch;
      state.afterDecl = false;
      stream.next();
      while (!stream.eol()) {
        if (stream.peek() === '\\') {
          stream.next();
          stream.next();
          continue;
        }
        if (stream.peek() === quote) {
          stream.next();
          break;
        }
        stream.next();
      }
      return 'string';
    }

    // Right after `infographic` — the next word is the chart type.
    if (state.afterDecl) {
      state.afterDecl = false;
      if (stream.match(/\S+/)) return 'typeName';
      return null;
    }

    // Declaration keyword: `infographic <type>`.
    if (stream.match(/infographic\b/)) {
      state.afterDecl = true;
      stream.match(/\s+/);
      return 'keyword';
    }

    // theme / template preset: `theme <value>`, `template <value>`. The
    // keyword is highlighted; the value after it is plain.
    if (stream.match(/(theme|template)\b/)) {
      stream.match(/\s+/);
      state.inValue = true;
      return 'keyword';
    }

    // Block headers: a bare `data` / `design` / `theme` / `template` /
    // `infographic` on a row (no value follows).
    if (stream.match(/^(data|design|theme|template|infographic)\s*$/)) {
      return 'keyword';
    }

    // Key/value row: optional leading "-", then a property name. The key may
    // be any run of non-space characters (labels are often CJK), so match a
    // non-space chunk; the dash is consumed but is not part of the name.
    if (stream.match(/-\s*/)) {
      if (stream.match(/[^\s]+/)) {
        stream.match(/\s+/);
        state.inValue = true;
        return 'propertyName';
      }
      return null;
    }
    if (stream.match(/[^\s]+/)) {
      stream.match(/\s+/);
      state.inValue = true;
      return 'propertyName';
    }

    // Anything else: a bare token (number, symbol, etc.).
    if (stream.match(/\S+/)) return null;
    return null;
  },
};

export const infographicLanguageSupport = StreamLanguage.define(infographicLanguage);
