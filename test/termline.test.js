import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKER_OPEN,
  MARKER_SEP,
  MARKER_CLOSE,
  parseTermline,
  formatTermline,
  sanitizeTermlinePart,
  unescapeTermlineValue,
  parseTermList,
  escapeTermListPart,
  unescapeTermListPart,
  materializeTermline,
  parseInlineMarkdown,
  materializeInline,
} from '../src/termline.js';

test('marker constants', () => {
  assert.deepEqual([MARKER_OPEN, MARKER_SEP, MARKER_CLOSE], ['[[', '|', ']]']);
});

test('parse: a sentence with two terms', () => {
  const value = 'A [[monoid|combines values]] lets you fold, and a [[functor|maps over a box]] maps over it.';
  const { pieces, sentence } = parseTermline(value);
  assert.deepEqual(pieces, [
    { kind: 'text', text: 'A ' },
    { kind: 'term', name: 'monoid', def: 'combines values' },
    { kind: 'text', text: ' lets you fold, and a ' },
    { kind: 'term', name: 'functor', def: 'maps over a box' },
    { kind: 'text', text: ' maps over it.' },
  ]);
  assert.equal(sentence, 'A monoid lets you fold, and a functor maps over it.');
});

test('parse and format round-trip', () => {
  const value = 'A [[monoid|combines values]] and [[functor|maps]] end.';
  assert.equal(formatTermline(parseTermline(value).pieces), value);
  const edge = '[[a|b]][[c|d]]';
  assert.equal(formatTermline(parseTermline(edge).pieces), edge);
  assert.equal(parseTermline(edge).pieces.length, 2);
});

test('parse: unmatched [[ stays text', () => {
  assert.deepEqual(parseTermline('open [[ never closed').pieces, [{ kind: 'text', text: 'open [[ never closed' }]);
  const mixed = parseTermline('a [[ stray and [[real|def]] ok');
  assert.deepEqual(mixed.pieces, [
    { kind: 'text', text: 'a [[ stray and ' },
    { kind: 'term', name: 'real', def: 'def' },
    { kind: 'text', text: ' ok' },
  ]);
  assert.equal(mixed.sentence, 'a [[ stray and real ok');
  assert.equal(parseTermline('close ]] only').sentence, 'close ]] only');
});

test('parse: a term with no | has an empty def; empty text pieces are omitted', () => {
  const { pieces, sentence } = parseTermline('[[monoid]]');
  assert.deepEqual(pieces, [{ kind: 'term', name: 'monoid', def: '' }]);
  assert.equal(sentence, 'monoid');
  assert.equal(formatTermline(pieces), '[[monoid|]]');
  assert.deepEqual(parseTermline('[[monoid|]]').pieces, pieces);
});

test('parse: empty and non-string input', () => {
  for (const v of ['', undefined, null, 5]) assert.deepEqual(parseTermline(v), { pieces: [], sentence: '' });
});

test('sanitize strips marker, attr and newline characters', () => {
  assert.equal(sanitizeTermlinePart('a|b[c]d{e}f"g\'h\\i\nj\rk'), 'abcdefghijk');
  assert.equal(sanitizeTermlinePart('  plain words  '), 'plain words');
  assert.equal(sanitizeTermlinePart(undefined), '');
});

test('format sanitises term parts so the encoding stays valid', () => {
  const out = formatTermline([
    { kind: 'text', text: 'x ' },
    { kind: 'term', name: 'a|b', def: 'c]]d' },
  ]);
  assert.equal(out, 'x [[ab|cd]]');
  assert.deepEqual(parseTermline(out).pieces[1], { kind: 'term', name: 'ab', def: 'cd' });
});

test('unescape: host backslash escapes are removed, other backslashes stay', () => {
  assert.equal(unescapeTermlineValue('\\[\\[a\\]\\] \\*b\\* \\& \\x'), '[[a]] *b* & \\x');
  assert.equal(unescapeTermlineValue(undefined), '');
});

test('parse: host-escaped markers still yield a term and the plain sentence', () => {
  const { pieces, sentence } = parseTermline('A \\[\\[monoid|def\\]\\] works');
  assert.deepEqual(pieces, [
    { kind: 'text', text: 'A ' },
    { kind: 'term', name: 'monoid', def: 'def' },
    { kind: 'text', text: ' works' },
  ]);
  assert.equal(sentence, 'A monoid works');
});

test('parseTermList: splits on ;; and the first =, trims, skips empty names', () => {
  assert.deepEqual(parseTermList(' a = x=y ;;;; =nope;; b ;;c=d'), [
    { name: 'a', def: 'x=y' },
    { name: 'b', def: '' },
    { name: 'c', def: 'd' },
  ]);
  assert.deepEqual(parseTermList(undefined), []);
});

test('materialize: t pairs chip the first whole-word occurrence, keeping original spelling', () => {
  const out = materializeTermline({
    v: 'A monoid lets you fold, and a functor maps over it.',
    t: 'monoid=combines values;;functor=maps over a box',
  });
  assert.deepEqual(out.pieces, [
    { kind: 'text', text: 'A ' },
    { kind: 'term', name: 'monoid', def: 'combines values' },
    { kind: 'text', text: ' lets you fold, and a ' },
    { kind: 'term', name: 'functor', def: 'maps over a box' },
    { kind: 'text', text: ' maps over it.' },
  ]);
  assert.equal(out.sentence, 'A monoid lets you fold, and a functor maps over it.');

  const cased = materializeTermline({ text: 'Monoids and a Monoid.', t: 'monoid=d;;missing=x' });
  assert.deepEqual(cased.pieces.filter((p) => p.kind === 'term'), [{ kind: 'term', name: 'Monoid', def: 'd' }]);
  assert.equal(cased.sentence, 'Monoids and a Monoid.');
});

test('materialize: legacy markers win, no value gives no pieces', () => {
  const legacy = materializeTermline({ v: 'A [[monoid|d]] works', t: 'works=ignored' });
  assert.equal(legacy.pieces.filter((p) => p.kind === 'term').length, 1);
  assert.equal(legacy.sentence, 'A monoid works');
  assert.deepEqual(materializeTermline({ t: 'a=b' }), { pieces: [], sentence: '' });
  assert.deepEqual(materializeTermline(null), { pieces: [], sentence: '' });
});

test('termList escapes: round-trip names and defs holding \\, ; and =', () => {
  assert.equal(escapeTermListPart('a=b;c\\d'), 'a\\=b\\;c\\\\d');
  assert.equal(unescapeTermListPart(escapeTermListPart('a=b;c\\d;;')), 'a=b;c\\d;;');
  const t = [
    ['x=y', 'maps a=b; then c;;d'],
    ['f', 'path C:\\dir'],
  ]
    .map(([n, d]) => `${escapeTermListPart(n)}=${escapeTermListPart(d)}`)
    .join(';;');
  assert.deepEqual(parseTermList(t), [
    { name: 'x=y', def: 'maps a=b; then c;;d' },
    { name: 'f', def: 'path C:\\dir' },
  ]);
});

test('parseTermList: an escaped ;; does not split and unescaped t still parses', () => {
  assert.deepEqual(parseTermList('a=one\\;\\;two;;b=three'), [
    { name: 'a', def: 'one;;two' },
    { name: 'b', def: 'three' },
  ]);
  assert.deepEqual(parseTermList('monoid=def;;functor=def'), [
    { name: 'monoid', def: 'def' },
    { name: 'functor', def: 'def' },
  ]);
});

test('materialize: a def with = and ; reaches the chip intact', () => {
  const out = materializeTermline({ v: 'A monoid works.', t: 'monoid=x\\=y\\; z' });
  assert.deepEqual(out.pieces[1], { kind: 'term', name: 'monoid', def: 'x=y; z' });
});

const flat = (nodes) =>
  nodes.map((n) => (n.kind === 'text' ? n.text : n.kind === 'term' ? `<${n.name}>` : `${n.kind}(${flat(n.children)})`)).join('');

test('inline markdown: bold, italic, code and a link in one sentence', () => {
  const nodes = parseInlineMarkdown('A **bold** and *it* or _al_ with `x*y` and [docs](https://example.com/a).');
  assert.equal(flat(nodes), 'A strong(bold) and em(it) or em(al) with code(x*y) and link(docs).');
  assert.equal(nodes.find((n) => n.kind === 'link').href, 'https://example.com/a');
  assert.equal(flat(parseInlineMarkdown('__b__ and ***both***')), 'strong(b) and strong(em(both))');
});

test('inline markdown: unclosed or unsafe markers stay literal', () => {
  for (const s of ['a **unclosed typo', '*lonely', 'snake_case_name here', '2 * 3 * 4', '`open', '[x](javascript:alert(1))', '![img](https://e.com/a.png)']) {
    assert.deepEqual(parseInlineMarkdown(s), [{ kind: 'text', text: s }], s);
  }
  assert.equal(flat(parseInlineMarkdown('**unclosed and *ok*')), '**unclosed and em(ok)');
  assert.equal(flat(parseInlineMarkdown('use <b>x</b>')), 'use <b>x</b>');
});

test('materializeInline: **monad** leaves a chip and no stray markers', () => {
  const { nodes, sentence } = materializeInline({ v: 'In Haskell, a **monad** sequences effects.', t: 'monad=a wrapper' });
  assert.equal(flat(nodes), 'In Haskell, a strong(<monad>) sequences effects.');
  assert.equal(sentence, 'In Haskell, a monad sequences effects.');
  assert.ok(!JSON.stringify(nodes).includes('**'));
});

test('materializeInline: terms inside em and link spans, and legacy markers inside bold', () => {
  const a = materializeInline({ v: 'An *idempotent* call, see [monad docs](https://e.com) and `functor`.', t: 'idempotent=same result;;monad=m;;functor=f' });
  assert.equal(flat(a.nodes), 'An em(<idempotent>) call, see link(<monad> docs) and code(<functor>).');
  const b = materializeInline({ v: 'A **[[monoid|combines *values*]]** here.' });
  assert.equal(flat(b.nodes), 'A strong(<monoid>) here.');
  assert.equal(b.nodes[1].children[0].def, 'combines *values*');
});

test('materializeInline: plain v and t behave like materializeTermline', () => {
  const attrs = { v: 'A monoid lets you fold, and a functor maps over it.', t: 'monoid=a;;functor=b' };
  const plain = materializeTermline(attrs);
  const rich = materializeInline(attrs);
  assert.deepEqual(rich.nodes, plain.pieces);
  assert.equal(rich.sentence, plain.sentence);
  assert.deepEqual(materializeInline({}), { nodes: [], sentence: '' });
});

test('materializeInline chips a surface plural and a multiword name inside bold text', () => {
  const plural = materializeInline({ v: '**Monads** are a way to chain computations.', t: 'Monads=A pattern' });
  assert.equal(plural.sentence, 'Monads are a way to chain computations.');
  assert.deepEqual(plural.nodes[0], {
    kind: 'strong',
    children: [{ kind: 'term', name: 'Monads', def: 'A pattern' }],
  });

  const v = 'Use **CSS Flexbox** for one axis and **CSS Grid** for two.';
  const multi = materializeInline({ v, t: 'CSS Flexbox=Rows or columns;;CSS Grid=Rows and columns' });
  assert.equal(multi.sentence, 'Use CSS Flexbox for one axis and CSS Grid for two.');
  assert.deepEqual(multi.nodes[1], { kind: 'strong', children: [{ kind: 'term', name: 'CSS Flexbox', def: 'Rows or columns' }] });
  assert.deepEqual(multi.nodes[3], { kind: 'strong', children: [{ kind: 'term', name: 'CSS Grid', def: 'Rows and columns' }] });
});

test('materializeTermline finds a surface plural and a multiword name', () => {
  const { pieces } = materializeTermline({ v: 'Use **CSS Flexbox** and Monads.', t: 'CSS Flexbox=a;;Monads=b' });
  assert.deepEqual(
    pieces.filter((p) => p.kind === 'term'),
    [{ kind: 'term', name: 'CSS Flexbox', def: 'a' }, { kind: 'term', name: 'Monads', def: 'b' }],
  );
});
