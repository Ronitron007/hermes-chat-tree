// Encoding for a whole sentence carried by one paragraph-level directive:
// "A [[monoid|combines values]] lets you fold a list."
// Plain ESM with no imports so it can be concatenated into plugin.js.

export const MARKER_OPEN = '[[';
export const MARKER_SEP = '|';
export const MARKER_CLOSE = ']]';

const UNSAFE = /[|[\]{}"'\\\r\n]/g;

// Keeps the marker encoding and the surrounding directive attribute body valid.
export function sanitizeTermlinePart(s) {
  return String(s ?? '').replace(UNSAFE, '').trim();
}

export function parseTermline(value) {
  const input = typeof value === 'string' ? value : '';
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

export function formatTermline(pieces) {
  return (Array.isArray(pieces) ? pieces : [])
    .map((p) =>
      p?.kind === 'term'
        ? MARKER_OPEN + sanitizeTermlinePart(p.name) + MARKER_SEP + sanitizeTermlinePart(p.def) + MARKER_CLOSE
        : String(p?.text ?? ''),
    )
    .join('');
}
