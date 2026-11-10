// Atom-like store shared by the click handler and the pane. In the real plugin this
// role is played by the SDK's nanostores `atom` (evidence/03); this is the headless twin.

export function createTermStore() {
  let current = null
  const listeners = new Set()

  return {
    get: () => current,
    set(term) {
      current = term == null ? null : { name: term.name, def: term.def, sessionId: term.sessionId ?? null }
      for (const fn of [...listeners]) fn(current)
    },
    subscribe(fn) {
      listeners.add(fn)
      fn(current)
      return () => {
        listeners.delete(fn)
      }
    }
  }
}
