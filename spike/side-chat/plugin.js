/* side-chat-spike: throwaway spike, see docs/research/2026-11-11-chat-tree/spike-side-chat.md.
 * Forks the focused chat with session.branch_whole, asks the branch one question with a
 * one-turn model_override, and opens the branch. Every call result goes into the pane log.
 */
import * as sdk from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const { host, atom, useValue } = sdk
const Button = sdk.Button || 'button'
const Input = sdk.Input || 'input'
const ScrollArea = sdk.ScrollArea || 'div'

const $log = atom([])
const $branch = atom(null)
const $form = atom({ question: '', model: '', provider: '' })

const show = (value) => {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function log(step, ok, value) {
  $log.set([...$log.get(), { at: new Date().toLocaleTimeString(), step, ok, text: show(value) }])
}

async function call(step, fn) {
  try {
    const value = await fn()
    log(step, true, value)
    return value
  } catch (error) {
    log(step, false, error?.message ?? error)
    return null
  }
}

async function fork() {
  const sessionId = host.state.focusedSessionId.get() ?? host.state.activeSessionId.get()
  if (!sessionId) return log('fork', false, 'No focused chat. Open a chat with at least one message.')
  const result = await call('session.branch_whole', () =>
    host.request('session.branch_whole', {
      session_id: sessionId,
      name: 'Side question',
      idempotency_key: `side-chat-spike-${Date.now()}`,
    }),
  )
  if (result?.session_id) $branch.set(result)
}

async function ask() {
  const branch = $branch.get()
  if (!branch) return log('ask', false, 'Fork first.')
  const { question, model, provider } = $form.get()
  if (!question.trim()) return log('ask', false, 'Type a question.')
  const params = { session_id: branch.session_id, text: question }
  if (model.trim()) {
    params.model_override = { model: model.trim(), ...(provider.trim() ? { provider: provider.trim() } : {}) }
  }
  await call('prompt.submit', () => host.request('prompt.submit', params))
}

async function open() {
  const branch = $branch.get()
  if (!branch) return log('open', false, 'Fork first.')
  await call('host.openSession', async () => {
    await host.openSession(branch.stored_session_id, { intent: 'tab' })
    return 'opened'
  })
}

function field(key, placeholder) {
  const form = $form.get()
  return jsx(Input, {
    value: form[key],
    placeholder,
    onChange: (event) => $form.set({ ...$form.get(), [key]: event.target.value }),
  })
}

function renderPane() {
  const entries = useValue($log)
  const branch = useValue($branch)
  useValue($form)
  return jsx(ScrollArea, {
    children: jsxs('div', {
      className: 'flex flex-col gap-2 p-4 text-sm',
      children: [
        jsx('p', { children: 'Spike: fork the focused chat, ask on a cheaper model, open the branch.' }),
        jsx(Button, { type: 'button', onClick: fork, children: '1. Fork focused chat' }),
        jsx('p', { className: 'text-xs opacity-70', children: branch ? `Branch: ${branch.session_id}` : 'No branch yet' }),
        field('question', 'Side question'),
        field('model', 'Override model (blank = session model)'),
        field('provider', 'Override provider (optional)'),
        jsx(Button, { type: 'button', onClick: ask, children: '2. Ask in branch' }),
        jsx(Button, { type: 'button', onClick: open, children: '3. Open branch' }),
        jsx(Button, { type: 'button', onClick: () => $log.set([]), children: 'Clear log' }),
        ...entries.map((entry, i) =>
          jsx(
            'pre',
            {
              className: 'whitespace-pre-wrap text-xs',
              style: { color: entry.ok ? undefined : 'var(--destructive, #c0392b)' },
              children: `${entry.at} ${entry.step} ${entry.ok ? 'ok' : 'error'}\n${entry.text}`,
            },
            i,
          ),
        ),
      ],
    }),
  })
}

export default {
  id: 'side-chat-spike',
  name: 'Side Chat Spike',
  register(ctx) {
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Side chat spike',
      data: { placement: 'right', width: '360px' },
      render: renderPane,
    })
    ctx.register({
      id: 'open-side-chat-spike',
      area: 'palette',
      data: {
        id: 'open-side-chat-spike',
        label: 'Open side chat spike',
        keywords: ['side', 'branch', 'spike'],
        run: () => host.revealPane?.('side-chat-spike:pane'),
      },
    })
  },
}
