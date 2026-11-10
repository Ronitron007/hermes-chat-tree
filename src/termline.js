// Encodings for a whole sentence carried by one paragraph-level directive.
// Preferred: a plain sentence `v` plus `t="name=def;;name=def"`, which never
// puts `[`, `]` or `|` in the attribute (the host backslash-escapes those).
// Legacy: "A [[monoid|combines values]] lets you fold a list." inside `v`.
// Plain ESM with no imports so it can be concatenated into plugin.js.

export const MARKER_OPEN = '[[';
export const MARKER_SEP = '|';
export const MARKER_CLOSE = ']]';

const UNSAFE = /[|[\]{}"'\\\r\n]/g;

// Keeps the marker encoding and the surrounding directive attribute body valid.
export function sanitizeTermlinePart(s) {
  return String(s ?? '').replace(UNSAFE, '').trim();
}

const ESCAPED = /\\([\\`*_~[\]<>$&])/g;
const TERM_PAIR_SEP = ';;';

// Undoes the backslash escaping the host applies to inline markdown metachars
// in a directive body (`\[\[` arrives for `[[`).
export function unescapeTermlineValue(s) {
  return typeof s === 'string' ? s.replace(ESCAPED, '$1') : '';
}

export function parseTermline(value) {
  return scanMarkers(unescapeTermlineValue(value));
}

function scanMarkers(input) {
  const pieces = [];
  let text = '';
  const flush = () => {
    if (text !== '') pieces.push({ kind: 'text', text });
    text = '';
  };

  let pos = 0;
  while (pos < input.length) {
    const firstOpen = input.indexOf(MARKER_OPEN, pos);
    const close = firstOpen === -1 ? -1 : input.indexOf(MARKER_CLOSE, firstOpen + MARKER_OPEN.length);
    if (close === -1) break;
    // An earlier unmatched `[[` stays text; the marker is the nearest one before the close.
    const open = input.lastIndexOf(MARKER_OPEN, close - MARKER_OPEN.length);
    const inner = input.slice(open + MARKER_OPEN.length, close);
    const sep = inner.indexOf(MARKER_SEP);
    const name = (sep === -1 ? inner : inner.slice(0, sep)).trim();
    const def = sep === -1 ? '' : inner.slice(sep + MARKER_SEP.length).trim();
    if (name === '') {
      // Nothing to link: keep the characters so the sentence stays readable.
      text += input.slice(pos, open + MARKER_OPEN.length);
      pos = open + MARKER_OPEN.length;
      continue;
    }
    text += input.slice(pos, open);
    flush();
    pieces.push({ kind: 'term', name, def });
    pos = close + MARKER_CLOSE.length;
  }
  text += input.slice(pos);
  flush();

  const sentence = pieces.map((p) => (p.kind === 'term' ? p.name : p.text)).join('');
  return { pieces, sentence };
}

// "monoid=def;;functor=def" -> [{ name, def }]. Splits on the first `=` per pair.
export function parseTermList(t) {
  const out = [];
  for (const pair of unescapeTermlineValue(t).split(TERM_PAIR_SEP)) {
    const eq = pair.indexOf('=');
    const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
    if (name === '') continue;
    out.push({ name, def: eq === -1 ? '' : pair.slice(eq + 1).trim() });
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Builds pieces from `{ v | text, t }`. Legacy `[[name|def]]` markers in the
// sentence win; otherwise each `t` name chips its first whole-word occurrence.
export function materializeTermline(attrs) {
  const pick = (x) => (typeof x === 'string' ? unescapeTermlineValue(x).trim() : '');
  const sentenceText = pick(attrs?.v) || pick(attrs?.text);
  if (sentenceText === '') return { pieces: [], sentence: '' };
  const legacy = scanMarkers(sentenceText);
  if (legacy.pieces.some((p) => p.kind === 'term')) return legacy;

  let pieces = [{ kind: 'text', text: sentenceText }];
  const done = new Set();
  for (const { name, def } of parseTermList(attrs?.t)) {
    const key = name.toLowerCase();
    if (done.has(key)) continue;
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRe(name).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}_])`,
      'iu',
    );
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i].kind !== 'text') continue;
      const m = re.exec(pieces[i].text);
      if (!m) continue;
      const { text } = pieces[i];
      const next = [];
      if (m.index > 0) next.push({ kind: 'text', text: text.slice(0, m.index) });
      next.push({ kind: 'term', name: m[0], def });
      if (m.index + m[0].length < text.length) next.push({ kind: 'text', text: text.slice(m.index + m[0].length) });
      pieces = [...pieces.slice(0, i), ...next, ...pieces.slice(i + 1)];
      done.add(key);
      break;
    }
  }
  return { pieces, sentence: sentenceText };
}

export function formatTermline(pieces) {
  return (Array.isArray(pieces) ? pieces : [])
    .map((p) =>
      p?.kind === 'term'
        ? MARKER_OPEN + sanitizeTermlinePart(p.name) + MARKER_SEP + sanitizeTermlinePart(p.def) + MARKER_CLOSE
        : String(p?.text ?? ''),
    )
    .join('');
}
