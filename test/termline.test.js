import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKER_OPEN,
  MARKER_SEP,
  MARKER_CLOSE,
  parseTermline,
  formatTermline,
  sanitizeTermlinePart,
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
