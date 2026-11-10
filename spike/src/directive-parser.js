// Mirror of the live Hermes Desktop directive contract (evidence/01-directives.md,
// source: apps/desktop/src/lib/transcript-directives.ts). Limits and regexes are
// copied from that evidence; the segment object shape is this spike's own.

export const DIRECTIVE_BODY_MAX = 2048
export const PARAGRAPH_MAX = 4800

const SEGMENT_RE_SOURCE = String.raw`(?<=^|\s)::([a-z][a-z0-9-]{0,63})(?:\{([^{}]{0,2048})\})?`
const ATTR_RE_SOURCE = String.raw`([a-z][\w-]{0,63})=(?:"([^"]*)"|'([^']*)')`

/** Parse `key="value" key2='value'` pairs. Keys lowercased, no escapes, last key wins. */
export function parseAttrs(body) {
  const attrs = {}
  if (typeof body !== 'string') return attrs
  const re = new RegExp(ATTR_RE_SOURCE, 'gi')
  let m
  while ((m = re.exec(body)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? ''
  }
  return attrs
}

/**
 * Split text into prose and directive segments.
 * Returns null when there is nothing to do (no '::') or the text is over the
 * 4800-char cap, in which case the host shows the raw text.
 */
export function segmentTranscriptDirectives(text) {
  if (typeof text !== 'string' || !text.includes('::') || text.length > PARAGRAPH_MAX) return null

  const re = new RegExp(SEGMENT_RE_SOURCE, 'g')
  const segments = []
  let cursor = 0
  let m
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length
    // `{` right after the name but no captured body: unclosed or over the cap. Leave as text.
    if (m[2] === undefined && text[end] === '{') continue
    if (m.index > cursor) segments.push({ kind: 'prose', text: text.slice(cursor, m.index) })
    segments.push({ kind: 'directive', name: m[1], attrs: parseAttrs(m[2] ?? ''), source: m[0] })
    cursor = end
  }
  if (cursor < text.length) segments.push({ kind: 'prose', text: text.slice(cursor) })
  return segments
}
