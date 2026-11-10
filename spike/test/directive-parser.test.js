import test from 'node:test'
import assert from 'node:assert/strict'
import { segmentTranscriptDirectives, parseAttrs } from '../src/directive-parser.js'

const hasDirective = segs => Array.isArray(segs) && segs.some(s => s.kind === 'directive')

test('mid-prose directive splits into prose + directive + prose', () => {
  const segs = segmentTranscriptDirectives('See ::term{name="monoid" def="A set with identity"} here')
  assert.equal(segs.length, 3)
  assert.deepEqual(segs[0], { kind: 'prose', text: 'See ' })
  assert.equal(segs[1].kind, 'directive')
  assert.equal(segs[1].name, 'term')
  assert.deepEqual(segs[1].attrs, { name: 'monoid', def: 'A set with identity' })
  assert.equal(segs[1].source, '::term{name="monoid" def="A set with identity"}')
  assert.deepEqual(segs[2], { kind: 'prose', text: ' here' })
})

test('std::vector is not a directive', () => {
  const segs = segmentTranscriptDirectives('std::vector is a template')
  assert.ok(!hasDirective(segs))
})

test('unclosed brace stays prose', () => {
  const segs = segmentTranscriptDirectives('unclosed ::term{name="x" stays prose')
  assert.ok(!hasDirective(segs))
  if (segs) assert.equal(segs.map(s => s.text).join(''), 'unclosed ::term{name="x" stays prose')
})

test('brace body over 2048 chars stays prose', () => {
  const segs = segmentTranscriptDirectives(`a ::term{name="${'x'.repeat(2100)}"} b`)
  assert.ok(!hasDirective(segs))
})

test('paragraph over 4800 chars returns null', () => {
  const head = '::term{name="x"}'
  const text = head + 'a'.repeat(4801 - head.length)
  assert.equal(text.length, 4801)
  assert.equal(segmentTranscriptDirectives(text), null)
  assert.ok(hasDirective(segmentTranscriptDirectives(text.slice(0, 4800))))
})

test('text without :: returns null', () => {
  assert.equal(segmentTranscriptDirectives('plain text'), null)
})

test('single-quoted attrs work', () => {
  const segs = segmentTranscriptDirectives("x ::term{name='a' def='say \"hi\"'} y")
  assert.deepEqual(segs[1].attrs, { name: 'a', def: 'say "hi"' })
})

test('keys are lowercased', () => {
  assert.deepEqual(parseAttrs('Name="a" DEF=\'b\''), { name: 'a', def: 'b' })
})

test('no backslash escapes inside quotes', () => {
  assert.deepEqual(parseAttrs('def="a\\" b"'), { def: 'a\\' })
})

test('directive at line start and after newline is recognised', () => {
  const segs = segmentTranscriptDirectives('::term{name="a"}\nthen ::term{name="b"}')
  assert.equal(segs.filter(s => s.kind === 'directive').length, 2)
})

test('directive glued to punctuation is not recognised', () => {
  assert.ok(!hasDirective(segmentTranscriptDirectives('(::term{name="a"})')))
})
