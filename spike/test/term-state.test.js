import test from 'node:test'
import assert from 'node:assert/strict'
import { createTermStore } from '../src/term-state.js'

test('get returns null until set', () => {
  assert.equal(createTermStore().get(), null)
})

test('set stores name, def and sessionId', () => {
  const s = createTermStore()
  s.set({ name: 'monoid', def: 'd', sessionId: 's1' })
  assert.deepEqual(s.get(), { name: 'monoid', def: 'd', sessionId: 's1' })
})

test('missing sessionId becomes null', () => {
  const s = createTermStore()
  s.set({ name: 'a', def: 'b' })
  assert.equal(s.get().sessionId, null)
})

test('subscribe fires immediately and on change', () => {
  const s = createTermStore()
  const seen = []
  s.subscribe(v => seen.push(v))
  s.set({ name: 'a', def: 'b', sessionId: null })
  assert.equal(seen.length, 2)
  assert.equal(seen[0], null)
  assert.equal(seen[1].name, 'a')
})

test('unsubscribe stops notifications', () => {
  const s = createTermStore()
  let n = 0
  const off = s.subscribe(() => n++)
  off()
  s.set({ name: 'a', def: 'b' })
  assert.equal(n, 1)
})

test('set(null) clears', () => {
  const s = createTermStore()
  s.set({ name: 'a', def: 'b' })
  s.set(null)
  assert.equal(s.get(), null)
})
