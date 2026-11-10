import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlugin } from '../src/plugin-outline.js'
import { createTermStore } from '../src/term-state.js'

const el = (type, props) => ({ type, props })
const Tip = function Tip() {}
const Button = function Button() {}
const ScrollArea = function ScrollArea() {}
const EmptyState = function EmptyState() {}

function setup(host) {
  const registered = []
  const plugin = createPlugin({
    host,
    jsx: el,
    jsxs: el,
    atom: initial => {
      const s = createTermStore()
      if (initial) s.set(initial)
      return s
    },
    useValue: store => store.get(),
    Tip,
    Button,
    ScrollArea,
    EmptyState
  })
  plugin.register({ register: c => registered.push(c) })
  return { plugin, registered, directive: registered.find(c => c.area === 'transcript.directives'), pane: registered.find(c => c.area === 'panes') }
}

test('constants', () => {
  const { plugin } = setup({})
  assert.equal(plugin.PLUGIN_ID, 'concept-links')
  assert.equal(plugin.PANE_ID, 'glossary')
  assert.equal(plugin.DIRECTIVE_NAME, 'term')
})

test('registers a term directive and a right pane', () => {
  const { registered, directive, pane } = setup({})
  assert.equal(registered.length, 2)
  assert.equal(directive.data.name, 'term')
  assert.equal(typeof directive.data.render, 'function')
  assert.equal(pane.id, 'glossary')
  assert.equal(pane.title, 'Concepts')
  assert.deepEqual(pane.data, { placement: 'right', width: '340px' })
  assert.equal(typeof pane.render, 'function')
})

test('directive render produces a Tip wrapping a single button', () => {
  const { directive } = setup({})
  const tree = directive.data.render({ attrs: { name: 'monoid', def: 'A set' }, source: '', streaming: false, sessionId: 's1' })
  assert.equal(tree.type, Tip)
  assert.equal(tree.props.label, 'A set')
  assert.equal(tree.props.children.type, 'button')
  assert.equal(tree.props.children.props.type, 'button')
  assert.equal(tree.props.children.props.children, 'monoid')
})

test('click stores the term and reveals the pane', () => {
  const calls = []
  const { plugin, directive } = setup({ revealPane: id => calls.push(id) })
  const tree = directive.data.render({ attrs: { name: 'monoid', def: 'A set' }, source: '', streaming: false, sessionId: 's1' })
  tree.props.children.props.onClick()
  assert.deepEqual(plugin.$selectedTerm.get(), { name: 'monoid', def: 'A set', sessionId: 's1' })
  assert.deepEqual(calls, ['concept-links:glossary'])
})

test('click without host.revealPane still sets state and does not throw', () => {
  const { plugin, directive } = setup({})
  const tree = directive.data.render({ attrs: { name: 'a', def: 'b' }, source: '', streaming: false })
  assert.doesNotThrow(() => tree.props.children.props.onClick())
  assert.equal(plugin.$selectedTerm.get().name, 'a')
  assert.equal(plugin.$selectedTerm.get().sessionId, null)
})

test('directive without a name falls back to the source text', () => {
  const { directive } = setup({})
  const tree = directive.data.render({ attrs: {}, source: '::term', streaming: false, sessionId: null })
  assert.equal(tree.type, 'span')
  assert.equal(tree.props.children, '::term')
})

test('pane shows EmptyState until a term is selected, then name and def', () => {
  const { plugin, pane } = setup({})
  assert.equal(pane.render().type, EmptyState)
  plugin.$selectedTerm.set({ name: 'monoid', def: 'A set', sessionId: null })
  const tree = pane.render()
  assert.equal(tree.type, ScrollArea)
  const [title, def] = tree.props.children.props.children
  assert.equal(title.props.children, 'monoid')
  assert.equal(def.props.children, 'A set')
})
