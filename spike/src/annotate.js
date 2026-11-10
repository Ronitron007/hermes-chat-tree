// Mechanical annotator: the core of the Python transform_llm_output layer
// (evidence/02), written in JS so it can be tested headlessly.

import { DIRECTIVE_BODY_MAX, PARAGRAPH_MAX } from './directive-parser.js'

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Regions that must never be touched: fenced code (an unclosed fence runs to the
// end), inline code, and any existing ::name{...} directive.
const FENCE = '```[\\s\\S]*?(?:```|$)'
const INLINE = '`[^`\\n]+`'
const DIRECTIVE = '::[a-z][a-z0-9-]{0,63}\\{[^{}]*\\}'
const PROTECTED_SOURCE = [FENCE, INLINE, DIRECTIVE].join('|')

/**
 * Double quotes unless the value contains ", then single quotes. If it has both,
 * turn " into ' and keep double-quote wrapping: wrapping in single quotes after
 * that swap would leave a ' inside and the parser would cut the value short.
 */
function quoteAttr(value) {
  if (!value.includes('"')) return `"${value}"`
  if (!value.includes("'")) return `'${value}'`
  return `"${value.replace(/"/g, "'")}"`
}

// The attr body is [^{}], so braces cannot survive; whitespace is flattened so a
// definition can never introduce a paragraph break.
const cleanDef = def => def.replace(/[{}]/g, m => (m === '{' ? '(' : ')')).replace(/\s+/g, ' ').trim()

// Quotes are handled by quoteAttr; braces and newlines cannot appear in a name at all.
const usable = e =>
  e && typeof e.term === 'string' && e.term.length > 0 && e.term === e.term.trim() &&
  !/[{}\n]/.test(e.term) && !(e.term.includes('"') && e.term.includes("'")) &&
  typeof e.def === 'string' && cleanDef(e.def).length > 0

/**
 * @param {string} markdown
 * @param {{term: string, def: string}[]} glossary
 * @returns {{text: string, terms: string[]}} terms = unique names actually marked, in order of first use
 */
export function annotateTerms(markdown, glossary) {
  const entries = new Map()
  for (const e of glossary ?? []) if (usable(e) && !entries.has(e.term)) entries.set(e.term, cleanDef(e.def))
  if (typeof markdown !== 'string' || entries.size === 0) return { text: markdown, terms: [] }

  const alternation = [...entries.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|')
  // The parser only recognises a directive after whitespace or at the very start,
  // so a term glued to punctuation (e.g. "(monoid)") is skipped rather than broken.
  const re = new RegExp(
    `(${PROTECTED_SOURCE})|(?<=^|\\s)(${alternation})(?![\\p{L}\\p{N}_])`,
    'gu'
  )

  const starts = [0]
  for (const m of markdown.matchAll(/\n\n/g)) starts.push(m.index + 2)
  const lengths = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1] - 2 : markdown.length) - s)
  const paragraphAt = offset => {
    let i = starts.length - 1
    while (starts[i] > offset) i--
    return i
  }

  const marked = []
  const text = markdown.replace(re, (match, prot, term, offset) => {
    if (prot !== undefined) return match
    const directive = `::term{name=${quoteAttr(term)} def=${quoteAttr(entries.get(term))}}`
    const body = directive.slice('::term{'.length, -1)
    const p = paragraphAt(offset)
    const grown = lengths[p] + directive.length - match.length
    if (body.length > DIRECTIVE_BODY_MAX || grown > PARAGRAPH_MAX) return match
    lengths[p] = grown
    if (!marked.includes(term)) marked.push(term)
    return directive
  })
  return { text, terms: marked }
}
