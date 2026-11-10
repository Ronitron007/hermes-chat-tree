import test from 'node:test'
import assert from 'node:assert/strict'
import { annotateTerms } from '../src/annotate.js'
import { segmentTranscriptDirectives } from '../src/directive-parser.js'

const monoid = [{ term: 'monoid', def: 'A set with identity' }]

test('marks a term in prose', () => {
  const { text, terms } = annotateTerms('A monoid is a set.', monoid)
  assert.ok(text.includes('::term{name="monoid"'))
  assert.deepEqual(terms, ['monoid'])
  const dirs = segmentTranscriptDirectives(text).filter(s => s.kind === 'directive')
  assert.deepEqual(dirs[0].attrs, { name: 'monoid', def: 'A set with identity' })
})

test('is case-sensitive and respects word boundaries', () => {
  const { text, terms } = annotateTerms('Monoid, monoids and nonmonoid', monoid)
  assert.equal(text, 'Monoid, monoids and nonmonoid')
  assert.deepEqual(terms, [])
})

test('does not rewrite inside a code fence or inline code', () => {
  const md = 'Use `monoid` here.\n\n```js\nconst monoid = 1\n```\n\nA monoid ok.'
  const { text } = annotateTerms(md, monoid)
  assert.ok(text.includes('`monoid`'))
  assert.ok(text.includes('const monoid = 1'))
  assert.equal(text.match(/::term\{/g).length, 1)
  assert.ok(text.endsWith('A ::term{name="monoid" def="A set with identity"} ok.'))
})

test('an unclosed fence protects the rest of the text', () => {
  const { text } = annotateTerms('```\nmonoid', monoid)
  assert.equal(text, '```\nmonoid')
})

test('does not annotate a term already inside a ::term body', () => {
  const md = 'A ::term{name="monoid" def="a monoid thing"} is here'
  const { text, terms } = annotateTerms(md, monoid)
  assert.equal(text, md)
  assert.deepEqual(terms, [])
})

test('longest term wins', () => {
  const { text, terms } = annotateTerms('a free monoid here', [
    { term: 'monoid', def: 'short' },
    { term: 'free monoid', def: 'long' }
  ])
  assert.deepEqual(terms, ['free monoid'])
  assert.ok(text.includes('name="free monoid"'))
  assert.ok(!text.includes('name="monoid"'))
})

test('defs containing " use single-quoted attrs and parse back', () => {
  const def = 'Called "fold" in some languages'
  const { text } = annotateTerms('A monoid ok', [{ term: 'monoid', def }])
  assert.ok(text.includes(`def='${def}'`))
  const dir = segmentTranscriptDirectives(text).find(s => s.kind === 'directive')
  assert.deepEqual(dir.attrs, { name: 'monoid', def })
})

test('defs with both quote kinds still parse back', () => {
  const { text } = annotateTerms('A monoid ok', [{ term: 'monoid', def: `It's "a" thing` }])
  const dir = segmentTranscriptDirectives(text).find(s => s.kind === 'directive')
  assert.equal(dir.attrs.def, "It's 'a' thing")
})

test('braces in defs are neutralised so the directive still parses', () => {
  const { text } = annotateTerms('A monoid ok', [{ term: 'monoid', def: 'a {b} c' }])
  const dir = segmentTranscriptDirectives(text).find(s => s.kind === 'directive')
  assert.equal(dir.attrs.def, 'a (b) c')
})

test('a 5000-char paragraph is left unmarked', () => {
  const md = 'A monoid ' + 'x'.repeat(4991)
  assert.equal(md.length, 5000)
  const { text, terms } = annotateTerms(md, monoid)
  assert.equal(text, md)
  assert.deepEqual(terms, [])
})

test('stops marking once a paragraph would pass 4800, other paragraphs unaffected', () => {
  const para = ('monoid ' + 'y'.repeat(40) + ' ').repeat(80).trim() // ~3.7k chars, 80 terms
  const { text } = annotateTerms(para + '\n\nA monoid.', monoid)
  const [first, second] = text.split(/\n\n/)
  assert.ok(first.length <= 4800)
  assert.ok(first.match(/::term\{/g).length < 80)
  assert.ok(second.includes('::term{'))
})

test('def pushing the brace body over 2048 is skipped', () => {
  const { text, terms } = annotateTerms('A monoid ok', [{ term: 'monoid', def: 'd'.repeat(2100) }])
  assert.equal(text, 'A monoid ok')
  assert.deepEqual(terms, [])
})

test('a term glued to punctuation is skipped, not broken', () => {
  const { text } = annotateTerms('(monoid) and "monoid"', monoid)
  assert.equal(text, '(monoid) and "monoid"')
})

test('is idempotent', () => {
  const once = annotateTerms('A monoid ok', monoid).text
  assert.equal(annotateTerms(once, monoid).text, once)
})
