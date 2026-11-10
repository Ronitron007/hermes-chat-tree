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

// `t` parts escape `\`, `;` and `=` with a backslash so a name or definition may hold them.
export function escapeTermListPart(s) {
  return String(s ?? '').replace(/[\\;=]/g, '\\$&');
}

// Also removes the host's markdown backslashes (`\[`), which can reach a part unremoved.
export function unescapeTermListPart(s) {
  return typeof s === 'string' ? s.replace(/\\([\\;=`*_~[\]<>$&])/g, '$1') : '';
}

// "monoid=def;;functor=def" -> [{ name, def }]. Splits on unescaped `;;`, then on the
// first unescaped `=` per pair, then unescapes each part.
export function parseTermList(t) {
  const out = [];
  const input = typeof t === 'string' ? t : '';
  let name = null;
  let cur = '';
  const finish = () => {
    const n = unescapeTermListPart(name ?? cur).trim();
    if (n !== '') out.push({ name: n, def: name === null ? '' : unescapeTermListPart(cur).trim() });
    name = null;
    cur = '';
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      cur += ch + input[++i];
    } else if (ch === ';' && input[i + 1] === ';') {
      finish();
      i++;
    } else if (ch === '=' && name === null) {
      name = cur;
      cur = '';
    } else {
      cur += ch;
    }
  }
  finish();
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

const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s()<>]+$/i;
const LINK_AT = /^\[([^[\]]+)\]\(([^()\s]+)\)/;
const isWord = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch) => ch === undefined || /\s/.test(ch);

const pushText = (nodes, text) => {
  if (text === '') return;
  const last = nodes[nodes.length - 1];
  if (last && last.kind === 'text') last.text += text;
  else nodes.push({ kind: 'text', text });
};

// Index of the first closing run for which `ok(index)` holds, hopping over code
// spans so a marker inside backticks never closes an outer span.
function findCloser(input, from, ok) {
  for (let j = from; j < input.length; j++) {
    if (input[j] === '`') {
      const end = input.indexOf('`', j + 1);
      if (end !== -1) j = end;
      continue;
    }
    if (ok(j)) return j;
  }
  return -1;
}

// Conservative inline markdown: **bold**, __bold__, *italic*, _italic_, `code`
// and [label](http(s)/mailto url). Anything that does not close cleanly stays
// literal text. Returns nodes of { kind: 'text', text } or
// { kind: 'strong' | 'em' | 'code' | 'link', children, href? }.
export function parseInlineMarkdown(input, allowed = { strong: true, em: true, link: true }) {
  const s = typeof input === 'string' ? input : '';
  const nodes = [];
  let i = 0;
  const wrap = (kind, from, to, skip, extra, rules) => {
    const children = parseInlineMarkdown(s.slice(from, to), rules);
    nodes.push({ kind, ...extra, children });
    i = to + skip;
  };

  while (i < s.length) {
    const ch = s[i];

    if (ch === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const end = s.indexOf(fence, i + run);
      if (end > i + run && s[end + run] !== '`') {
        nodes.push({ kind: 'code', children: [{ kind: 'text', text: s.slice(i + run, end) }] });
        i = end + run;
        continue;
      }
      pushText(nodes, fence);
      i += run;
      continue;
    }

    if (ch === '!' && s[i + 1] === '[') {
      const img = LINK_AT.exec(s.slice(i + 1));
      if (img) {
        pushText(nodes, s.slice(i, i + 1 + img[0].length));
        i += 1 + img[0].length;
        continue;
      }
    }

    if (ch === '[' && allowed.link) {
      const m = LINK_AT.exec(s.slice(i));
      if (m && SAFE_HREF.test(m[2])) {
        const children = parseInlineMarkdown(m[1], { ...allowed, link: false });
        nodes.push({ kind: 'link', href: m[2], children });
        i += m[0].length;
        continue;
      }
    }

    if ((ch === '*' || ch === '_') && allowed.strong && allowed.em && s.startsWith(ch.repeat(3), i)
      && !isSpace(s[i + 3]) && (ch === '*' || !isWord(s[i - 1]))) {
      const close = findCloser(s, i + 3, (j) => s.startsWith(ch.repeat(3), j) && !isSpace(s[j - 1])
        && (ch === '*' || !isWord(s[j + 3])));
      if (close > i + 3) {
        nodes.push({
          kind: 'strong',
          children: [{ kind: 'em', children: parseInlineMarkdown(s.slice(i + 3, close), { strong: false, em: false, link: allowed.link }) }],
        });
        i = close + 3;
        continue;
      }
    }

    if ((ch === '*' || ch === '_') && s[i + 1] === ch) {
      const left = ch === '*' || !isWord(s[i - 1]);
      if (allowed.strong && left && !isSpace(s[i + 2]) && s[i + 2] !== ch) {
        const close = findCloser(s, i + 2, (j) => s[j] === ch && s[j + 1] === ch && s[j + 2] !== ch
          && !isSpace(s[j - 1]) && s[j - 1] !== ch && (ch === '*' || !isWord(s[j + 2])));
        if (close > i + 2) {
          wrap('strong', i + 2, close, 2, {}, { ...allowed, strong: false });
          continue;
        }
      }
      pushText(nodes, ch + ch);
      i += 2;
      continue;
    }

    if (ch === '*' || ch === '_') {
      const left = ch === '*' || !isWord(s[i - 1]);
      if (allowed.em && left && !isSpace(s[i + 1])) {
        const close = findCloser(s, i + 1, (j) => s[j] === ch && s[j - 1] !== ch && s[j + 1] !== ch
          && !isSpace(s[j - 1]) && (ch === '*' || !isWord(s[j + 1])));
        if (close > i + 1) {
          wrap('em', i + 1, close, 1, {}, { ...allowed, em: false });
          continue;
        }
      }
    }

    pushText(nodes, ch);
    i++;
  }
  return nodes;
}

const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';
const PH_RE = /\uE000(\d+)\uE001/;

const textOf = (nodes) =>
  nodes.map((n) => (n.kind === 'text' ? n.text : n.kind === 'term' ? n.name : textOf(n.children))).join('');

// Replaces the first text leaf (document order) that `split` can break up.
// Code spans are verbatim, so a name inside one is never chipped.
function mapFirstLeaf(nodes, split) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === 'code') continue;
    if (n.kind === 'text') {
      const parts = split(n.text);
      if (parts) return [...nodes.slice(0, i), ...parts, ...nodes.slice(i + 1)];
    } else if (n.kind !== 'term') {
      const kids = mapFirstLeaf(n.children, split);
      if (kids) return [...nodes.slice(0, i), { ...n, children: kids }, ...nodes.slice(i + 1)];
    }
  }
  return null;
}

function expandPlaceholders(nodes, terms) {
  return nodes.flatMap((n) => {
    if (n.kind === 'term') return [n];
    if (n.kind !== 'text') return [{ ...n, children: expandPlaceholders(n.children, terms) }];
    const out = [];
    let rest = n.text;
    for (let m = PH_RE.exec(rest); m; m = PH_RE.exec(rest)) {
      if (m.index > 0) out.push({ kind: 'text', text: rest.slice(0, m.index) });
      out.push({ kind: 'term', ...terms[Number(m[1])] });
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest !== '') out.push({ kind: 'text', text: rest });
    return out;
  });
}

// Like materializeTermline, but the sentence is parsed as inline markdown first, so
// term chips can sit inside strong/em/a/code nodes and no marker characters leak
// into the neighbouring text. Returns { nodes, sentence } where `sentence` is the
// visible text.
export function materializeInline(attrs) {
  const pick = (x) => (typeof x === 'string' ? unescapeTermlineValue(x).trim() : '');
  const sentenceText = pick(attrs?.v) || pick(attrs?.text);
  if (sentenceText === '') return { nodes: [], sentence: '' };

  const legacy = scanMarkers(sentenceText.replace(/[\uE000\uE001]/g, ''));
  if (legacy.pieces.some((p) => p.kind === 'term')) {
    const terms = [];
    const masked = legacy.pieces
      .map((p) => {
        if (p.kind === 'text') return p.text;
        terms.push({ name: p.name, def: p.def });
        return `${PH_OPEN}${terms.length - 1}${PH_CLOSE}`;
      })
      .join('');
    const nodes = expandPlaceholders(parseInlineMarkdown(masked), terms);
    return { nodes, sentence: textOf(nodes) };
  }

  let nodes = parseInlineMarkdown(sentenceText.replace(/[\uE000\uE001]/g, ''));
  const done = new Set();
  for (const { name, def } of parseTermList(attrs?.t)) {
    const key = name.toLowerCase();
    if (done.has(key)) continue;
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRe(name).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}_])`,
      'iu',
    );
    const next = mapFirstLeaf(nodes, (text) => {
      const m = re.exec(text);
      if (!m) return null;
      const parts = [];
      if (m.index > 0) parts.push({ kind: 'text', text: text.slice(0, m.index) });
      parts.push({ kind: 'term', name: m[0], def });
      if (m.index + m[0].length < text.length) parts.push({ kind: 'text', text: text.slice(m.index + m[0].length) });
      return parts;
    });
    if (next) {
      nodes = next;
      done.add(key);
    }
  }
  return { nodes, sentence: textOf(nodes) };
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
