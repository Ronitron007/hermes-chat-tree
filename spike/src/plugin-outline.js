// Outline of the Desktop plugin.js (evidence/01, /03, /04). The real file may import
// only @hermes/plugin-sdk, react and react/jsx-runtime, and has no JSX; this module
// takes everything as arguments so it can run under Node with mocks.
//
// In the real plugin.js:
//   import { jsx, jsxs } from 'react/jsx-runtime'
//   import { atom, useValue, Tip, ... } from '@hermes/plugin-sdk'
//   const plugin = createPlugin({ host, jsx, jsxs, atom, useValue, Tip, Button, ScrollArea, EmptyState })
//   export default { register: ctx => plugin.register(ctx) }   // export shape: unverified

export const PLUGIN_ID = 'concept-links'
export const PANE_ID = 'glossary'
export const DIRECTIVE_NAME = 'term'

const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives'
const PANES_AREA = 'panes'

export function createPlugin({ host, jsx, jsxs, atom, useValue, Tip, Button, ScrollArea, EmptyState }) {
  // { name, def, sessionId } | null, shared between the directive click and the pane
  const $selectedTerm = atom(null)
  const paneId = `${PLUGIN_ID}:${PANE_ID}`

  // attrs are untrusted model output: strings only, validated before use
  const str = v => (typeof v === 'string' ? v.trim() : '')

  function renderTerm({ attrs, source, sessionId }) {
    const name = str(attrs?.name)
    const def = str(attrs?.def)
    if (!name) return jsx('span', { children: source })

    const open = () => {
      $selectedTerm.set({ name, def, sessionId: sessionId ?? null })
      // Feature-detected: revealPane is documented in the live sdk/index.ts only.
      if (typeof host?.revealPane === 'function') host.revealPane(paneId)
    }

    const chip = jsx('button', {
      type: 'button',
      className: 'cursor-pointer underline decoration-dotted underline-offset-2',
      onClick: open,
      children: name
    })
    // Tip needs a single element child (TooltipTrigger asChild)
    return jsx(Tip, { label: def, children: chip })
  }

  function renderPane() {
    // Hook call inside render mirrors the evidence/03 pattern; whether the host
    // invokes pane render as a component is unverified.
    const term = useValue($selectedTerm)
    if (!term) {
      return jsx(EmptyState, {
        title: 'No concept selected',
        description: 'Click a dotted term in the chat to see it here.'
      })
    }
    return jsx(ScrollArea, {
      children: jsxs('div', {
        className: 'flex flex-col gap-3 p-4',
        children: [
          jsx('h2', { className: 'text-base font-semibold', children: term.name }),
          jsx('p', { className: 'text-sm', children: term.def }),
          jsx(Button, { type: 'button', onClick: () => $selectedTerm.set(null), children: 'Clear' })
        ]
      })
    })
  }

  function register(ctx) {
    ctx.register({
      id: DIRECTIVE_NAME,
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: { name: DIRECTIVE_NAME, render: renderTerm }
    })
    ctx.register({
      id: PANE_ID,
      area: PANES_AREA,
      title: 'Concepts',
      data: { placement: 'right', width: '340px' },
      render: renderPane
    })
  }

  return { register, $selectedTerm, PANE_ID, PLUGIN_ID, DIRECTIVE_NAME }
}
