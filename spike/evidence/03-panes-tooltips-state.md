# Evidence: tooltips, panes, state, palette

## Tooltips (UI kit only)

SDK exports: `Tip`, `Tooltip`, `TooltipContent`, `TooltipProvider`, `TooltipTrigger`, and `Popover*`.

Live `apps/desktop/src/components/ui/tooltip.tsx`:

```ts
interface TipProps {
  label: React.ReactNode
  children: React.ReactNode
  delayDuration?: number
}
```

`Tip` is the drop-in for native `title=`. If `label` is falsy, children render untouched. Default delay 200ms. Open state is trigger-hover only, never sticky, never click-blocking. Uses `TooltipTrigger asChild`, so **children must be a single element** that can take a ref and pointer events (a `<button type="button">` styled as an inline term is the safe pattern; a bare text node will not work).

`label` is `ReactNode`, so a short definition string is fine. Long interactive content belongs in a pane or a `Popover`, not a tip: `disableHoverableContent` defaults true, and tips are labels not interactive surfaces.

Rohan's constraint: use only the Hermes UI kit. No outside component libraries.

## Opening a right pane and passing a term

Proven pane shape (hermes-widgets Desktop tests):

```js
ctx.register({
  id: 'glossary',
  area: 'panes', // PANES_AREA — never type:'pane' or area:'right'
  title: 'Concepts',
  data: { placement: 'right', width: '340px' },
  render: () => /* React element */
})
```

`host.revealPane(paneId)` (live `sdk/index.ts`): "Reveal a contributed pane and its zone from an explicit user action." Feature-detect `typeof host.revealPane === 'function'`. The contribution-scoped id is `<pluginId>:<paneId>`. Example from core bots: `host.revealPane(screenPaneId(bot))`.

`host.paneVisibility(paneId)` is a readonly atom, true while the pane is on screen. It does not open the pane.

`host.undismissPane(paneId)` forgets a persisted Close without fronting the pane.

`host.openWorkspace(id, { render, title, ... })` docks a tab in the **main** workspace zone, not the right dock. Optional later; not the spike.

`ctx.runAction` / `listActions` run built-in view/navigation actions only, not an arbitrary plugin pane.

Palette: `PALETTE_AREA` = `'palette'`, `data: { id, label, keywords?, run }`. Can add "Open concepts pane" as a convenience, not required for the spike.

## Passing the term to the pane

SDK exports `atom`, `computed` from nanostores, and `useValue` (`useStore` from `@nanostores/react`). Documented as "Plugin-local reactive state (share between a trigger and its panel...)".

Pattern:

```js
import { atom, useValue } from '@hermes/plugin-sdk'
const $selectedTerm = atom(null) // { name, def, sessionId } | null
// in directive render click:
$selectedTerm.set({ name: attrs.name, def: attrs.def, sessionId })
host.revealPane('concept-links:glossary')
// in pane render:
const term = useValue($selectedTerm)
```

There is no separate "events bus" required. Do not patch app stores.

## Risk from hermes-widgets assumption-corrections

Closing the pane disables the plugin **only when the plugin has just one pane**. If the glossary pane is the plugin's only pane, closing it may turn the plugin off and stop directive rendering. Spike should either keep a second cheap pane, document the risk, or accept it for the spike and watch for it in Desktop.

Do not install this spike into the live Hermes Desktop yet.
