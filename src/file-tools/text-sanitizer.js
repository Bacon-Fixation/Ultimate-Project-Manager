"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWriteFile } = require("../filesystem/atomic-file");

const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024;

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "coverage",
  ".nyc_output",
  ".next",
  ".nuxt",
  ".cache",
  "dist",
  "build",
  "vendor",
  ".idea",
  ".vscode",
]);

const DEFAULT_TEXT_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".jsonc",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".pug",
  ".ejs",
  ".md",
  ".mdx",
  ".txt",
  ".csv",
  ".tsv",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".config",
  ".env",
  ".properties",
  ".sql",
  ".graphql",
  ".gql",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".py",
  ".rb",
  ".php",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cs",
  ".go",
  ".rs",
  ".swift",
  ".vue",
  ".svelte",
  ".astro",
  ".dockerfile",
]);

const KNOWN_TEXT_FILENAMES = new Set([
  "dockerfile",
  "makefile",
  "license",
  "readme",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".nvmrc",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
]);

const GROUP_METADATA = {
  punctuation: {
    label: "Quotes, dashes & punctuation",
    option: "replacePunctuation",
    defaultEnabled: true,
    risk: "low",
    description:
      "Smart quotes, typographic dashes, ellipses, slash variants and closely equivalent punctuation.",
  },
  bullets: {
    label: "Bullets & list markers",
    option: "replaceBullets",
    defaultEnabled: true,
    risk: "low",
    description: "Common decorative/list bullets normalized to simple ASCII list markers.",
  },
  spaces: {
    label: "Unicode spaces",
    option: "replaceSpaces",
    defaultEnabled: true,
    risk: "low",
    description: "Visible-width Unicode space characters normalized to ordinary ASCII space.",
  },
  lineBreaks: {
    label: "Unicode/control line breaks",
    option: "replaceLineBreaks",
    defaultEnabled: true,
    risk: "low",
    description: "Unusual line and paragraph separators normalized to LF.",
  },
  compatibility: {
    label: "Fullwidth & compatibility ASCII",
    option: "replaceCompatibility",
    defaultEnabled: false,
    risk: "medium",
    description:
      "Fullwidth ASCII and small-form punctuation normalized to ordinary ASCII equivalents.",
  },
  arrowsMath: {
    label: "Arrows & common math",
    option: "replaceArrowsMath",
    defaultEnabled: true,
    risk: "medium",
    description:
      "Common arrows, comparison signs and visually equivalent math/operator symbols converted to readable ASCII.",
  },
  status: {
    label: "Status & checkbox symbols",
    option: "replaceStatus",
    defaultEnabled: true,
    risk: "low",
    description:
      "Check marks, crosses, ballot boxes, warnings and information symbols converted to text tokens.",
  },
  misc: {
    label: "Miscellaneous symbols",
    option: "replaceMisc",
    defaultEnabled: true,
    risk: "low",
    description:
      "Copyright, trademark, numero and a few common textual symbols converted to ASCII text.",
  },
  ambiguous: {
    label: "Extended / ambiguous substitutions",
    option: "replaceAmbiguous",
    defaultEnabled: false,
    risk: "high",
    description:
      "Optional semantic substitutions such as logical operators, fractions, units and mathematical words. Disabled by default.",
  },
};

function fullwidthAsciiReplacements() {
  const replacements = [];
  for (let cp = 0xff01; cp <= 0xff5e; cp += 1) {
    const from = String.fromCodePoint(cp);
    const to = String.fromCodePoint(cp - 0xfee0);
    replacements.push([from, to, `FULLWIDTH ASCII ${JSON.stringify(to)}`]);
  }
  return replacements;
}

const REPLACEMENT_GROUPS = {
  punctuation: [
    ["\u2018", "'", "LEFT SINGLE QUOTATION MARK"],
    ["\u2019", "'", "RIGHT SINGLE QUOTATION MARK"],
    ["\u201A", "'", "SINGLE LOW-9 QUOTATION MARK"],
    ["\u201B", "'", "SINGLE HIGH-REVERSED-9 QUOTATION MARK"],
    ["\u201C", '"', "LEFT DOUBLE QUOTATION MARK"],
    ["\u201D", '"', "RIGHT DOUBLE QUOTATION MARK"],
    ["\u201E", '"', "DOUBLE LOW-9 QUOTATION MARK"],
    ["\u201F", '"', "DOUBLE HIGH-REVERSED-9 QUOTATION MARK"],
    ["\u00AB", '"', "LEFT-POINTING DOUBLE ANGLE QUOTATION MARK"],
    ["\u00BB", '"', "RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK"],
    ["\u2039", "'", "SINGLE LEFT-POINTING ANGLE QUOTATION MARK"],
    ["\u203A", "'", "SINGLE RIGHT-POINTING ANGLE QUOTATION MARK"],
    ["\u275B", "'", "HEAVY SINGLE TURNED COMMA QUOTATION MARK ORNAMENT"],
    ["\u275C", "'", "HEAVY SINGLE COMMA QUOTATION MARK ORNAMENT"],
    ["\u275D", '"', "HEAVY DOUBLE TURNED COMMA QUOTATION MARK ORNAMENT"],
    ["\u275E", '"', "HEAVY DOUBLE COMMA QUOTATION MARK ORNAMENT"],
    ["\u301D", '"', "REVERSED DOUBLE PRIME QUOTATION MARK"],
    ["\u301E", '"', "DOUBLE PRIME QUOTATION MARK"],
    ["\u301F", '"', "LOW DOUBLE PRIME QUOTATION MARK"],
    ["\u2032", "'", "PRIME"],
    ["\u2033", '"', "DOUBLE PRIME"],
    ["\u2035", "'", "REVERSED PRIME"],
    ["\u2036", '"', "REVERSED DOUBLE PRIME"],
    ["\u2010", "-", "HYPHEN"],
    ["\u2011", "-", "NON-BREAKING HYPHEN"],
    ["\u2012", "-", "FIGURE DASH"],
    ["\u2013", "-", "EN DASH"],
    ["\u2014", "-", "EM DASH"],
    ["\u2015", "-", "HORIZONTAL BAR"],
    ["\u2212", "-", "MINUS SIGN"],
    ["\uFE58", "-", "SMALL EM DASH"],
    ["\uFE63", "-", "SMALL HYPHEN-MINUS"],
    ["\u2026", "...", "HORIZONTAL ELLIPSIS"],
    ["\u2044", "/", "FRACTION SLASH"],
    ["\u2215", "/", "DIVISION SLASH"],
    ["\u29F8", "/", "BIG SOLIDUS"],
    ["\u2016", "||", "DOUBLE VERTICAL LINE"],
  ],
  bullets: [
    ["\u2022", "*", "BULLET"],
    ["\u2023", "*", "TRIANGULAR BULLET"],
    ["\u2027", "*", "HYPHENATION POINT"],
    ["\u2043", "-", "HYPHEN BULLET"],
    ["\u204C", "*", "BLACK LEFTWARDS BULLET"],
    ["\u204D", "*", "BLACK RIGHTWARDS BULLET"],
    ["\u204E", "*", "LOW ASTERISK"],
    ["\u2217", "*", "ASTERISK OPERATOR"],
    ["\u2219", "*", "BULLET OPERATOR"],
    ["\u25CF", "*", "BLACK CIRCLE"],
    ["\u25CB", "*", "WHITE CIRCLE"],
    ["\u25AA", "*", "BLACK SMALL SQUARE"],
    ["\u25AB", "*", "WHITE SMALL SQUARE"],
    ["\u25A0", "*", "BLACK SQUARE"],
    ["\u25A1", "*", "WHITE SQUARE"],
    ["\u25C6", "*", "BLACK DIAMOND"],
    ["\u25C7", "*", "WHITE DIAMOND"],
    ["\u25E6", "*", "WHITE BULLET"],
    ["\u2726", "*", "BLACK FOUR POINTED STAR"],
    ["\u2727", "*", "WHITE FOUR POINTED STAR"],
    ["\u00B7", "*", "MIDDLE DOT"],
  ],
  spaces: [
    ["\u00A0", " ", "NO-BREAK SPACE"],
    ["\u1680", " ", "OGHAM SPACE MARK"],
    ["\u2000", " ", "EN QUAD"],
    ["\u2001", " ", "EM QUAD"],
    ["\u2002", " ", "EN SPACE"],
    ["\u2003", " ", "EM SPACE"],
    ["\u2004", " ", "THREE-PER-EM SPACE"],
    ["\u2005", " ", "FOUR-PER-EM SPACE"],
    ["\u2006", " ", "SIX-PER-EM SPACE"],
    ["\u2007", " ", "FIGURE SPACE"],
    ["\u2008", " ", "PUNCTUATION SPACE"],
    ["\u2009", " ", "THIN SPACE"],
    ["\u200A", " ", "HAIR SPACE"],
    ["\u202F", " ", "NARROW NO-BREAK SPACE"],
    ["\u205F", " ", "MEDIUM MATHEMATICAL SPACE"],
    ["\u3000", " ", "IDEOGRAPHIC SPACE"],
  ],
  lineBreaks: [
    ["\u000B", "\n", "LINE TABULATION / VERTICAL TAB"],
    ["\u000C", "\n", "FORM FEED"],
    ["\u0085", "\n", "NEXT LINE"],
    ["\u2028", "\n", "LINE SEPARATOR"],
    ["\u2029", "\n", "PARAGRAPH SEPARATOR"],
  ],
  compatibility: [
    ...fullwidthAsciiReplacements(),
    ["\uFE50", ",", "SMALL COMMA"],
    ["\uFE51", ",", "SMALL IDEOGRAPHIC COMMA"],
    ["\uFE52", ".", "SMALL FULL STOP"],
    ["\uFE54", ";", "SMALL SEMICOLON"],
    ["\uFE55", ":", "SMALL COLON"],
    ["\uFE56", "?", "SMALL QUESTION MARK"],
    ["\uFE57", "!", "SMALL EXCLAMATION MARK"],
    ["\uFE59", "(", "SMALL LEFT PARENTHESIS"],
    ["\uFE5A", ")", "SMALL RIGHT PARENTHESIS"],
    ["\uFE5B", "{", "SMALL LEFT CURLY BRACKET"],
    ["\uFE5C", "}", "SMALL RIGHT CURLY BRACKET"],
    ["\uFE5F", "#", "SMALL NUMBER SIGN"],
    ["\uFE60", "&", "SMALL AMPERSAND"],
    ["\uFE61", "*", "SMALL ASTERISK"],
    ["\uFE62", "+", "SMALL PLUS SIGN"],
    ["\uFE64", "<", "SMALL LESS-THAN SIGN"],
    ["\uFE65", ">", "SMALL GREATER-THAN SIGN"],
    ["\uFE66", "=", "SMALL EQUALS SIGN"],
    ["\uFE68", "\\", "SMALL REVERSE SOLIDUS"],
    ["\uFE69", "$", "SMALL DOLLAR SIGN"],
    ["\uFE6A", "%", "SMALL PERCENT SIGN"],
    ["\uFE6B", "@", "SMALL COMMERCIAL AT"],
  ],
  arrowsMath: [
    ["\u2190", "<-", "LEFTWARDS ARROW"],
    ["\u2192", "->", "RIGHTWARDS ARROW"],
    ["\u2191", "^", "UPWARDS ARROW"],
    ["\u2193", "v", "DOWNWARDS ARROW"],
    ["\u2194", "<->", "LEFT RIGHT ARROW"],
    ["\u21D0", "<=", "LEFTWARDS DOUBLE ARROW"],
    ["\u21D2", "=>", "RIGHTWARDS DOUBLE ARROW"],
    ["\u21D4", "<=>", "LEFT RIGHT DOUBLE ARROW"],
    ["\u27F5", "<-", "LONG LEFTWARDS ARROW"],
    ["\u27F6", "->", "LONG RIGHTWARDS ARROW"],
    ["\u27F7", "<->", "LONG LEFT RIGHT ARROW"],
    ["\u27F8", "<=", "LONG LEFTWARDS DOUBLE ARROW"],
    ["\u27F9", "=>", "LONG RIGHTWARDS DOUBLE ARROW"],
    ["\u27FA", "<=>", "LONG LEFT RIGHT DOUBLE ARROW"],
    ["\u2794", "->", "HEAVY WIDE-HEADED RIGHTWARDS ARROW"],
    ["\u27A1", "->", "BLACK RIGHTWARDS ARROW"],
    ["\u2B05", "<-", "LEFTWARDS BLACK ARROW"],
    ["\u2B06", "^", "UPWARDS BLACK ARROW"],
    ["\u2B07", "v", "DOWNWARDS BLACK ARROW"],
    ["\u2264", "<=", "LESS-THAN OR EQUAL TO"],
    ["\u2265", ">=", "GREATER-THAN OR EQUAL TO"],
    ["\u2260", "!=", "NOT EQUAL TO"],
    ["\u226A", "<<", "MUCH LESS-THAN"],
    ["\u226B", ">>", "MUCH GREATER-THAN"],
    ["\u2248", "~=", "ALMOST EQUAL TO"],
    ["\u2243", "~=", "ASYMPTOTICALLY EQUAL TO"],
    ["\u223C", "~", "TILDE OPERATOR"],
    ["\u2254", ":=", "COLON EQUALS"],
    ["\u2255", "=:", "EQUALS COLON"],
    ["\u2236", ":", "RATIO"],
    ["\u00D7", "x", "MULTIPLICATION SIGN"],
    ["\u00F7", "/", "DIVISION SIGN"],
    ["\u00B1", "+/-", "PLUS-MINUS SIGN"],
    ["\u2213", "-/+", "MINUS-OR-PLUS SIGN"],
  ],
  status: [
    ["\u2610", "[ ]", "BALLOT BOX"],
    ["\u2611", "[OK]", "BALLOT BOX WITH CHECK"],
    ["\u2612", "[X]", "BALLOT BOX WITH X"],
    ["\u2713", "[OK]", "CHECK MARK"],
    ["\u2714", "[OK]", "HEAVY CHECK MARK"],
    ["\u2705", "[OK]", "WHITE HEAVY CHECK MARK"],
    ["\u2717", "[X]", "BALLOT X"],
    ["\u2718", "[X]", "HEAVY BALLOT X"],
    ["\u274C", "[X]", "CROSS MARK"],
    ["\u274E", "[X]", "NEGATIVE SQUARED CROSS MARK"],
    ["\u26A0", "[!]", "WARNING SIGN"],
    ["\u2139", "[i]", "INFORMATION SOURCE"],
    ["\u26D4", "[BLOCKED]", "NO ENTRY"],
  ],
  misc: [
    ["\u00A9", "(c)", "COPYRIGHT SIGN"],
    ["\u00AE", "(R)", "REGISTERED SIGN"],
    ["\u2122", "(TM)", "TRADE MARK SIGN"],
    ["\u2116", "No.", "NUMERO SIGN"],
    ["\u2105", "c/o", "CARE OF"],
  ],
  ambiguous: [
    ["\u00AC", "!", "NOT SIGN"],
    ["\u2227", "&&", "LOGICAL AND"],
    ["\u2228", "||", "LOGICAL OR"],
    ["\u2261", "===", "IDENTICAL TO"],
    ["\u2262", "!==", "NOT IDENTICAL TO"],
    ["\u2225", "||", "PARALLEL TO"],
    ["\u221E", "infinity", "INFINITY"],
    ["\u221A", "sqrt", "SQUARE ROOT"],
    ["\u2211", "sum", "N-ARY SUMMATION"],
    ["\u220F", "product", "N-ARY PRODUCT"],
    ["\u2208", "in", "ELEMENT OF"],
    ["\u2209", "not-in", "NOT AN ELEMENT OF"],
    ["\u2205", "empty", "EMPTY SET"],
    ["\u00B0", " deg", "DEGREE SIGN"],
    ["\u00B5", "u", "MICRO SIGN"],
    ["\u2126", "ohm", "OHM SIGN"],
    ["\u2030", " per-mille", "PER MILLE SIGN"],
    ["\u00BC", "1/4", "VULGAR FRACTION ONE QUARTER"],
    ["\u00BD", "1/2", "VULGAR FRACTION ONE HALF"],
    ["\u00BE", "3/4", "VULGAR FRACTION THREE QUARTERS"],
    ["\u2150", "1/7", "VULGAR FRACTION ONE SEVENTH"],
    ["\u2151", "1/9", "VULGAR FRACTION ONE NINTH"],
    ["\u2152", "1/10", "VULGAR FRACTION ONE TENTH"],
    ["\u2153", "1/3", "VULGAR FRACTION ONE THIRD"],
    ["\u2154", "2/3", "VULGAR FRACTION TWO THIRDS"],
    ["\u2155", "1/5", "VULGAR FRACTION ONE FIFTH"],
    ["\u2156", "2/5", "VULGAR FRACTION TWO FIFTHS"],
    ["\u2157", "3/5", "VULGAR FRACTION THREE FIFTHS"],
    ["\u2158", "4/5", "VULGAR FRACTION FOUR FIFTHS"],
    ["\u2159", "1/6", "VULGAR FRACTION ONE SIXTH"],
    ["\u215A", "5/6", "VULGAR FRACTION FIVE SIXTHS"],
    ["\u215B", "1/8", "VULGAR FRACTION ONE EIGHTH"],
    ["\u215C", "3/8", "VULGAR FRACTION THREE EIGHTHS"],
    ["\u215D", "5/8", "VULGAR FRACTION FIVE EIGHTHS"],
    ["\u215E", "7/8", "VULGAR FRACTION SEVEN EIGHTHS"],
    ["\u00B2", "^2", "SUPERSCRIPT TWO"],
    ["\u00B3", "^3", "SUPERSCRIPT THREE"],
    ["\u00B9", "^1", "SUPERSCRIPT ONE"],
    ["\u2070", "^0", "SUPERSCRIPT ZERO"],
    ["\u2074", "^4", "SUPERSCRIPT FOUR"],
    ["\u2075", "^5", "SUPERSCRIPT FIVE"],
    ["\u2076", "^6", "SUPERSCRIPT SIX"],
    ["\u2077", "^7", "SUPERSCRIPT SEVEN"],
    ["\u2078", "^8", "SUPERSCRIPT EIGHT"],
    ["\u2079", "^9", "SUPERSCRIPT NINE"],
  ],
};

const INVISIBLE_PATTERNS = [
  {
    regex: /[\u0001-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F]/gu,
    name: "ASCII / C1 CONTROL CHARACTER",
    range: "U+0001-0008, U+000E-001F, U+007F-009F (except U+0085)",
  },
  { regex: /[\u00AD]/gu, name: "SOFT HYPHEN", range: "U+00AD" },
  { regex: /[\u034F]/gu, name: "COMBINING GRAPHEME JOINER", range: "U+034F" },
  { regex: /[\u061C]/gu, name: "ARABIC LETTER MARK", range: "U+061C" },
  {
    regex: /[\u115F\u1160\u17B4\u17B5]/gu,
    name: "INVISIBLE FORMAT CHARACTER",
    range: "U+115F, U+1160, U+17B4-17B5",
  },
  { regex: /[\u180B-\u180F]/gu, name: "MONGOLIAN FORMAT CHARACTER", range: "U+180B-180F" },
  { regex: /[\u200B-\u200F]/gu, name: "ZERO-WIDTH / DIRECTIONAL MARK", range: "U+200B-200F" },
  { regex: /[\u202A-\u202E]/gu, name: "BIDI EMBEDDING / OVERRIDE", range: "U+202A-202E" },
  { regex: /[\u2060-\u206F]/gu, name: "WORD JOINER / BIDI ISOLATE / FORMAT", range: "U+2060-206F" },
  { regex: /[\u3164\uFFA0]/gu, name: "HANGUL FILLER", range: "U+3164, U+FFA0" },
  { regex: /[\uFE00-\uFE0F]/gu, name: "VARIATION SELECTOR", range: "U+FE00-FE0F" },
  { regex: /[\uFEFF]/gu, name: "ZERO WIDTH NO-BREAK SPACE / BOM", range: "U+FEFF" },
  { regex: /[\uFFF9-\uFFFB]/gu, name: "INTERLINEAR ANNOTATION CONTROL", range: "U+FFF9-FFFB" },
  { regex: /[\u{1BCA0}-\u{1BCA3}]/gu, name: "SHORTHAND FORMAT CONTROL", range: "U+1BCA0-1BCA3" },
  {
    regex: /[\u{1D173}-\u{1D17A}]/gu,
    name: "MUSICAL SYMBOL FORMAT CONTROL",
    range: "U+1D173-1D17A",
  },
  { regex: /[\u{E0000}-\u{E007F}]/gu, name: "UNICODE TAG CHARACTER", range: "U+E0000-E007F" },
  {
    regex: /[\u{E0100}-\u{E01EF}]/gu,
    name: "VARIATION SELECTOR SUPPLEMENT",
    range: "U+E0100-E01EF",
  },
];

const ALL_REPLACEMENT_INDEX = new Map();
for (const [group, entries] of Object.entries(REPLACEMENT_GROUPS)) {
  for (const [from, to, name] of entries) {
    if (!ALL_REPLACEMENT_INDEX.has(from)) {
      ALL_REPLACEMENT_INDEX.set(from, { group, to, name });
    }
  }
}

function normalizeSettings(options = {}) {
  return {
    replacePunctuation: options.replacePunctuation !== false,
    replaceBullets: options.replaceBullets !== false,
    replaceSpaces: options.replaceSpaces !== false,
    replaceLineBreaks: options.replaceLineBreaks !== false,
    replaceCompatibility: options.replaceCompatibility === true,
    replaceArrowsMath: options.replaceArrowsMath !== false,
    replaceStatus: options.replaceStatus !== false,
    replaceMisc: options.replaceMisc !== false,
    replaceAmbiguous: options.replaceAmbiguous === true,
    removeInvisible: options.removeInvisible !== false,
    reportNonAscii: options.reportNonAscii !== false,
    useExtensionFilter: options.useExtensionFilter !== false,
    maxFileSize: Number(options.maxFileSize) || DEFAULT_MAX_FILE_SIZE,
    ignoreDirectories: Array.isArray(options.ignoreDirectories) ? options.ignoreDirectories : [],
    extensions: Array.isArray(options.extensions) ? options.extensions : null,
  };
}

function buildReplacements(settings) {
  const map = new Map();
  for (const [group, metadata] of Object.entries(GROUP_METADATA)) {
    if (!settings[metadata.option]) continue;
    for (const [from, to, name] of REPLACEMENT_GROUPS[group]) {
      map.set(from, { to, name, group });
    }
  }
  return map;
}

function codePointLabel(char) {
  const cp = char.codePointAt(0);
  return `U+${cp
    .toString(16)
    .toUpperCase()
    .padStart(cp <= 0xffff ? 4 : 6, "0")}`;
}

function getInvisibleSpec(char, settings) {
  if (!settings.removeInvisible) return null;
  for (const spec of INVISIBLE_PATTERNS) {
    spec.regex.lastIndex = 0;
    const matches = spec.regex.test(char);
    spec.regex.lastIndex = 0;
    if (matches) return spec;
  }
  return null;
}

function getRuleCatalog() {
  const replacements = [];
  for (const [group, entries] of Object.entries(REPLACEMENT_GROUPS)) {
    const metadata = GROUP_METADATA[group];
    for (const [from, to, name] of entries) {
      replacements.push({
        group,
        groupLabel: metadata.label,
        risk: metadata.risk,
        defaultEnabled: metadata.defaultEnabled,
        codePoint: codePointLabel(from),
        from,
        to,
        name,
      });
    }
  }
  return {
    groups: Object.entries(GROUP_METADATA).map(([id, meta]) => ({ id, ...meta })),
    replacements,
    invisible: INVISIBLE_PATTERNS.map((spec) => ({ name: spec.name, range: spec.range })),
    counts: {
      replacementCharacters: replacements.length,
      invisibleClasses: INVISIBLE_PATTERNS.length,
      groups: Object.keys(GROUP_METADATA).length,
    },
  };
}

function buildPreviewSegments(input, options = {}) {
  const settings = normalizeSettings(options);
  const replacements = buildReplacements(settings);
  const segments = [];
  let line = 1;
  let column = 1;
  let changeIndex = 0;

  function pushUnchanged(char) {
    const previous = segments[segments.length - 1];
    if (previous && previous.type === "unchanged") {
      previous.original += char;
      previous.sanitized += char;
      return;
    }
    segments.push({ type: "unchanged", original: char, sanitized: char });
  }

  for (const char of input) {
    const replacement = replacements.get(char);
    if (replacement) {
      segments.push({
        type: "replace",
        group: replacement.group,
        codePoint: codePointLabel(char),
        name: replacement.name,
        original: char,
        sanitized: replacement.to,
        line,
        column,
        changeIndex: changeIndex++,
      });
    } else {
      const invisible = getInvisibleSpec(char, settings);
      if (invisible) {
        segments.push({
          type: "remove",
          group: "invisible",
          codePoint: codePointLabel(char),
          name: invisible.name,
          original: char,
          sanitized: "",
          line,
          column,
          changeIndex: changeIndex++,
        });
      } else {
        pushUnchanged(char);
      }
    }

    if (char === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return segments;
}

function sanitizeText(input, options = {}) {
  const settings = normalizeSettings(options);
  const replacements = buildReplacements(settings);
  let text = input;
  const changes = [];

  for (const [from, spec] of replacements.entries()) {
    const count = text.split(from).length - 1;
    if (!count) continue;
    text = text.split(from).join(spec.to);
    changes.push({
      type: "replace",
      group: spec.group,
      codePoint: codePointLabel(from),
      name: spec.name,
      from,
      to: spec.to,
      count,
    });
  }

  if (settings.removeInvisible) {
    for (const spec of INVISIBLE_PATTERNS) {
      let count = 0;
      spec.regex.lastIndex = 0;
      text = text.replace(spec.regex, () => {
        count += 1;
        return "";
      });
      spec.regex.lastIndex = 0;
      if (count) {
        changes.push({
          type: "remove",
          group: "invisible",
          codePoint: spec.range,
          name: spec.name,
          from: "",
          to: "",
          count,
        });
      }
    }
  }

  const nonAscii = [];
  if (settings.reportNonAscii) {
    const counts = new Map();
    for (const char of text) {
      if (char.codePointAt(0) <= 0x7f) continue;
      counts.set(char, (counts.get(char) || 0) + 1);
    }
    for (const [char, count] of counts) {
      const known = ALL_REPLACEMENT_INDEX.get(char);
      nonAscii.push({
        char,
        codePoint: codePointLabel(char),
        count,
        knownReplacement: known
          ? {
              group: known.group,
              name: known.name,
              to: known.to,
              enabled: Boolean(settings[GROUP_METADATA[known.group].option]),
            }
          : null,
      });
    }
    nonAscii.sort((a, b) => b.count - a.count || a.codePoint.localeCompare(b.codePoint));
  }

  return {
    text,
    changed: text !== input,
    changeCount: changes.reduce((sum, item) => sum + item.count, 0),
    changes,
    nonAscii,
  };
}

function looksBinary(buffer) {
  if (!buffer.length) return false;
  const sampleSize = Math.min(buffer.length, 8192);
  let suspicious = 0;
  for (let i = 0; i < sampleSize; i += 1) {
    const byte = buffer[i];
    if (byte === 0x00) return true;
    if (byte < 0x07 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }
  return suspicious / sampleSize > 0.1;
}

function isLikelyTextFile(filePath, settings) {
  if (!settings.useExtensionFilter) return true;
  const name = path.basename(filePath).toLowerCase();
  const ext = path.extname(name).toLowerCase();
  if (KNOWN_TEXT_FILENAMES.has(name)) return true;
  const allowed = settings.extensions
    ? new Set(
        settings.extensions.map((x) =>
          x.startsWith(".") ? x.toLowerCase() : `.${x.toLowerCase()}`,
        ),
      )
    : DEFAULT_TEXT_EXTENSIONS;
  return allowed.has(ext);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function analyzeFile(filePath, root, options = {}) {
  const settings = normalizeSettings(options);
  if (/\.sanitizer-backup(?:\.\d+)?$/i.test(path.basename(filePath))) {
    return { skipped: true, reason: "sanitizer-backup" };
  }
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return { skipped: true, reason: "not-file" };
  if (stat.size > settings.maxFileSize) return { skipped: true, reason: "too-large" };
  if (!isLikelyTextFile(filePath, settings)) return { skipped: true, reason: "extension-filter" };

  const buffer = await fs.readFile(filePath);
  if (looksBinary(buffer)) return { skipped: true, reason: "binary" };

  const original = buffer.toString("utf8");
  const result = sanitizeText(original, settings);
  return {
    skipped: false,
    filePath,
    relativePath: path.relative(root, filePath),
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    hash: sha256(buffer),
    original,
    sanitized: result.text,
    changed: result.changed,
    changeCount: result.changeCount,
    changes: result.changes,
    nonAscii: result.nonAscii,
  };
}

async function scanProject(rootDirectory, options = {}) {
  const root = path.resolve(rootDirectory);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error("Selected project path is not a directory.");

  const settings = normalizeSettings(options);
  const ignored = new Set([...DEFAULT_IGNORED_DIRECTORIES, ...settings.ignoreDirectories]);
  const excludedPaths = (
    Array.isArray(options.excludeAbsolutePaths) ? options.excludeAbsolutePaths : []
  )
    .map((value) => path.resolve(String(value || "")))
    .filter(Boolean);
  const files = [];
  const skipped = {};
  const errors = [];
  let filesScanned = 0;

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skipped["symbolic-link"] = (skipped["symbolic-link"] || 0) + 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) {
          skipped["ignored-directory"] = (skipped["ignored-directory"] || 0) + 1;
          continue;
        }
        const resolvedDirectory = path.resolve(fullPath);
        const excluded = excludedPaths.some((excludedPath) => {
          const relative = path.relative(excludedPath, resolvedDirectory);
          return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        });
        if (excluded) {
          skipped["output-directory"] = (skipped["output-directory"] || 0) + 1;
          continue;
        }
        try {
          await walk(fullPath);
        } catch (error) {
          errors.push({ file: path.relative(root, fullPath), error: error.message });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      filesScanned += 1;
      try {
        const result = await analyzeFile(fullPath, root, settings);
        if (result.skipped) {
          skipped[result.reason] = (skipped[result.reason] || 0) + 1;
          continue;
        }
        if (result.changed || result.nonAscii.length) {
          files.push({
            relativePath: result.relativePath,
            bytes: result.bytes,
            mtimeMs: result.mtimeMs,
            hash: result.hash,
            changed: result.changed,
            changeCount: result.changeCount,
            changes: result.changes,
            nonAscii: result.nonAscii,
          });
        }
      } catch (error) {
        errors.push({ file: path.relative(root, fullPath), error: error.message });
      }
    }
  }

  await walk(root);
  const changedFiles = files.filter((f) => f.changed);
  const changeGroups = {};
  const topCharacters = new Map();

  for (const file of files) {
    for (const change of file.changes) {
      changeGroups[change.group] = (changeGroups[change.group] || 0) + change.count;
      const key = `${change.codePoint}|${change.name}|${change.from}|${change.to}|${change.type}`;
      const current = topCharacters.get(key) || {
        type: change.type,
        group: change.group,
        codePoint: change.codePoint,
        name: change.name,
        from: change.from,
        to: change.to,
        count: 0,
      };
      current.count += change.count;
      topCharacters.set(key, current);
    }
  }

  const topChanges = [...topCharacters.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 20);

  return {
    id: crypto.randomUUID(),
    root,
    settings,
    summary: {
      filesScanned,
      filesWithFindings: files.length,
      filesChanged: changedFiles.length,
      totalChanges: changedFiles.reduce((sum, f) => sum + f.changeCount, 0),
      remainingNonAscii: files.reduce(
        (sum, f) => sum + f.nonAscii.reduce((s, c) => s + c.count, 0),
        0,
      ),
      skipped,
      errors: errors.length,
      changeGroups,
      topChanges,
    },
    files,
    errors,
    createdAt: new Date().toISOString(),
  };
}

async function previewFile(root, relativePath, options = {}) {
  const fullPath = path.resolve(root, relativePath);
  const expectedPrefix = path.resolve(root) + path.sep;
  if (fullPath !== path.resolve(root) && !fullPath.startsWith(expectedPrefix)) {
    throw new Error("Invalid file path.");
  }
  const result = await analyzeFile(fullPath, path.resolve(root), options);
  if (result.skipped) throw new Error(`File cannot be previewed: ${result.reason}`);
  return result;
}

async function writeSanitizedFiles(root, outputRoot, relativePaths, options = {}) {
  const rootResolved = path.resolve(root);
  const outputResolved = path.resolve(outputRoot);
  const results = [];
  const expectedHashes = options.expectedHashes || {};
  const overwrite = options.overwrite !== false;

  if (rootResolved === outputResolved) {
    throw new Error("Source and output folders must be different.");
  }

  for (const relativePath of relativePaths) {
    const fullPath = path.resolve(rootResolved, relativePath);
    const destinationPath = path.resolve(outputResolved, relativePath);
    const sourceRelative = path.relative(rootResolved, fullPath);
    const destinationRelative = path.relative(outputResolved, destinationPath);
    if (
      !sourceRelative ||
      sourceRelative.startsWith("..") ||
      path.isAbsolute(sourceRelative) ||
      !destinationRelative ||
      destinationRelative.startsWith("..") ||
      path.isAbsolute(destinationRelative)
    ) {
      results.push({
        relativePath,
        sourceRelativePath: relativePath,
        destinationRelativePath: relativePath,
        ok: false,
        status: "error",
        error: "Invalid file path.",
      });
      continue;
    }

    try {
      const analyzed = await analyzeFile(fullPath, rootResolved, options);
      if (analyzed.skipped) throw new Error(analyzed.reason);

      const expectedHash = expectedHashes[relativePath];
      if (expectedHash && analyzed.hash !== expectedHash) {
        results.push({
          relativePath,
          sourceRelativePath: relativePath,
          destinationRelativePath: relativePath,
          ok: false,
          status: "error",
          stale: true,
          error: "File changed after the scan. Re-scan before writing output.",
        });
        continue;
      }

      if (!analyzed.changed) {
        results.push({
          relativePath,
          sourceRelativePath: relativePath,
          destinationRelativePath: relativePath,
          ok: true,
          status: "skipped",
          changed: false,
          reason: "no-longer-needs-sanitizing",
        });
        continue;
      }

      if (!overwrite) {
        try {
          await fs.access(destinationPath);
          results.push({
            relativePath,
            sourceRelativePath: relativePath,
            destinationRelativePath: relativePath,
            ok: true,
            status: "skipped",
            changed: false,
            reason: "destination-exists",
          });
          continue;
        } catch {
          // Destination does not exist; continue with the write.
        }
      }

      const stat = await fs.stat(fullPath);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await atomicWriteFile(destinationPath, analyzed.sanitized, {
        encoding: "utf8",
        mode: stat.mode,
      });

      results.push({
        relativePath,
        sourceRelativePath: relativePath,
        destinationRelativePath: relativePath,
        ok: true,
        status: "written",
        changed: true,
        changeCount: analyzed.changeCount,
        bytes: Buffer.byteLength(analyzed.sanitized, "utf8"),
      });
    } catch (error) {
      results.push({
        relativePath,
        sourceRelativePath: relativePath,
        destinationRelativePath: relativePath,
        ok: false,
        status: "error",
        error: error.message,
      });
    }
  }

  return results;
}

module.exports = {
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_TEXT_EXTENSIONS,
  GROUP_METADATA,
  REPLACEMENT_GROUPS,
  INVISIBLE_PATTERNS,
  normalizeSettings,
  sanitizeText,
  buildPreviewSegments,
  getRuleCatalog,
  scanProject,
  previewFile,
  writeSanitizedFiles,
};
