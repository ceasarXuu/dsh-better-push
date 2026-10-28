/**
 * dsh-better-push — host half.
 *
 * Watches every live DSH Session and turns the notification-worthy moments of
 * the agent lifecycle into macOS system notifications:
 *
 *   - a turn finished (and how long it took, plus a short reply preview)
 *   - a turn failed / was interrupted / ran out of tokens
 *   - a tool call is waiting for the user's approval
 *   - the agent is asking the user a question
 *   - a background job settled
 *   - a subagent turn finished
 *   - a workflow run finished
 *
 * Delivery has two paths, chosen per notification:
 *
 *   1. **Attached window (preferred).** The browser half polls
 *      `GET /plugin/better-push/poll`; the host answers with the notifications
 *      that happened since the caller's cursor. The browser half turns them
 *      into renderer `Notification`s, which macOS attributes to *DeepSeek
 *      Harness* and which can focus the window and open the Session on click.
 *   2. **No window attached.** When no client has polled for a few seconds (the
 *      window was closed), the host falls back to `osascript display
 *      notification`, which works head-lessly but is attributed to Script
 *      Editor and cannot focus DSH on click. Opt out with
 *      `fallbackWhenNoClient: false`.
 *
 * The host owns the policy (which event kinds, quiet hours, sound); the browser
 * half owns the surface decisions that need renderer state (foreground check,
 * localization, click-to-focus).
 *
 * Settings are the plugin row's `config`, so they render automatically in the
 * Plugins page from the `Config` schema below and are written back to
 * `~/.dsh/profiles/<profile>/cordis.patch.yml`.
 */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/** Cordis plugin name (also the `name` of the row in `cordis.patch.yml`). */
export const name = 'better-push'

/**
 * No required service: every trigger is a cordis event (`session/event`,
 * `user-questions/request`), so the plugin works in any composition that has a
 * Session service. The HTTP surface is attached opportunistically through
 * `ctx.inject(['webServer'], …)`.
 */
export const inject = []

/** HTTP prefix owned on the host web server. Keep in sync with `client.js`. */
const API_PREFIX = '/plugin/better-push'

/** A client counts as attached while it polled this recently. */
const CLIENT_ACTIVE_MS = 6_000

/** Buffered notifications older than this are never replayed to a client. */
const ITEM_TTL_MS = 60_000

/** Upper bound of the notification ring buffer. */
const MAX_ITEMS = 64

/** Duplicate suppression for the same session + kind. */
const DEDUPE_MS = 2_000
const APPROVAL_DEDUPE_MS = 30_000

/** Reply preview length, in characters. */
const PREVIEW_MAX = 160

/** Default macOS sound for the `osascript` fallback. */
const DEFAULT_SOUND = 'Glass'

/**
 * Plugin configuration. Rendered automatically by the Plugins settings page.
 * Every field defaults to the product decision recorded for this plugin, so a
 * profile patch only has to state what it changes.
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('Master switch for macOS system notifications.').volatile(),
  whenBackgroundOnly: Schema.boolean()
    .default(true)
    .description('Only notify while the DeepSeek Harness window is not focused.').volatile(),
  sound: Schema.boolean()
    .default(true)
    .description('Play a sound with each notification.').volatile(),
  turnEnd: Schema.boolean()
    .default(true)
    .description('Notify when an agent turn finishes.').volatile(),
  approvals: Schema.boolean()
    .default(true)
    .description('Notify when a tool call is waiting for your approval.').volatile(),
  questions: Schema.boolean()
    .default(true)
    .description('Notify when the agent asks you a question.').volatile(),
  errors: Schema.boolean()
    .default(true)
    .description('Notify when a turn fails, is interrupted, or runs out of tokens.').volatile(),
  jobs: Schema.boolean()
    .default(true)
    .description('Notify when a background job settles.').volatile(),
  subagents: Schema.boolean()
    .default(true)
    .description('Notify when a subagent turn finishes.').volatile(),
  workflows: Schema.boolean()
    .default(true)
    .description('Notify when a workflow run finishes.').volatile(),
  preview: Schema.boolean()
    .default(true)
    .description('Include a short preview of the assistant reply in the notification body.').volatile(),
  minTurnSeconds: Schema.number()
    .default(0)
    .description('Skip turn-finished notifications shorter than this many seconds (0 = notify every turn).').volatile(),
  quietHours: Schema.string()
    .default('')
    .description('Quiet hours as HH:MM-HH:MM, local time (empty = always notify; overnight ranges are allowed).').volatile(),
  fallbackWhenNoClient: Schema.boolean()
    .default(true)
    .description('Deliver through macOS osascript when no app window is attached (window closed).').volatile(),
  fallbackSoundName: Schema.string()
    .default(DEFAULT_SOUND)
    .description('macOS sound name for the osascript fallback (e.g. Glass, Ping, Pop).').volatile(),
})

/* ------------------------------------------------------------------ */
/* 1. Pure helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Read a live (`.volatile()`) config value. The settings document hands
 * volatile fields to `apply` as reactive refs; the notifier works off a plain
 * snapshot, and a settings write reloads this plugin with a fresh value.
 */
export function unref(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/** Snapshot every config value, unwrapping volatile refs. */
export function normalizeConfig(raw) {
  const value = {}
  for (const [key, entry] of Object.entries(raw ?? {})) value[key] = unref(entry)
  return value
}

/** Truncate one line to a display budget, collapsing whitespace. */
export function summarize(text, max = PREVIEW_MAX) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1).trimEnd()}…`
}

/** Concatenate the text blocks of an assistant message. */
export function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').trim()
}

/** Human-readable duration used by the fallback body. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m${String(rest)}s`
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h${String(minutes % 60)}m`
}

/** Parse `HH:MM-HH:MM`; returns undefined for an empty or malformed value. */
export function parseQuietHours(spec) {
  if (typeof spec !== 'string') return undefined
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/u.exec(spec)
  if (match === null) return undefined
  const [startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number)
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return undefined
  const start = startHour * 60 + startMinute
  const end = endHour * 60 + endMinute
  if (start === end) return undefined
  return { start, end }
}

/** Whether `date` falls inside the quiet-hours window (overnight aware). */
export function inQuietHours(spec, date = new Date()) {
  const window = parseQuietHours(spec)
  if (window === undefined) return false
  const now = date.getHours() * 60 + date.getMinutes()
  return window.start < window.end
    ? now >= window.start && now < window.end
    : now >= window.start || now < window.end
}

/** Quote one value as an AppleScript string literal (no raw line breaks). */
export function appleScriptString(value) {
  const flat = String(value ?? '').replace(/[\r\n]+/gu, ' ')
  return `"${flat.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/** Build the `osascript -e` program for one fallback notification. */
export function appleScriptFor({ title, body, subtitle, sound }) {
  const parts = [`display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`]
  if (typeof subtitle === 'string' && subtitle.length > 0) parts.push(`subtitle ${appleScriptString(subtitle)}`)
  if (typeof sound === 'string' && sound.length > 0) parts.push(`sound name ${appleScriptString(sound)}`)
  return parts.join(' ')
}

/** Best-effort Session display name: title when known, else the folder name. */
export function sessionLabel(session, titles) {
  const id = session?.header?.id
  const title = typeof id === 'string' ? titles.get(id) : undefined
  if (typeof title === 'string' && title.trim().length > 0) return summarize(title, 60)
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return basename(cwd)
  return 'DSH'
}

/** Stable delivery key for dedupe and notification replacement. */
export function dedupeKey(spec) {
  return `${spec.sessionId ?? 'app'}:${spec.kind}`
}

/** Localized-ish fallback copy; the attached client renders proper locale text. */
export function fallbackCopy(item, config) {
  const title = (label) => (item.sessionTitle === undefined ? label : `${label} · ${item.sessionTitle}`)
  const duration = formatDuration(item.durationMs ?? NaN)
  switch (item.kind) {
    case 'turn-end': {
      const body = [item.preview, duration].filter((part) => typeof part === 'string' && part.length > 0).join(' · ')
      return { title: title('回合完成 / Turn finished'), body: body || 'The agent finished its turn.' }
    }
    case 'turn-error':
      return { title: title('回合出错 / Turn failed'), body: item.detail ?? 'The turn failed.' }
    case 'turn-aborted':
      return { title: title('回合中断 / Turn interrupted'), body: item.detail ?? 'The turn was interrupted.' }
    case 'approval':
      return { title: title('需要你的确认 / Approval needed'), body: item.detail ?? 'A tool call is waiting for approval.' }
    case 'question':
      return { title: title('DSH 在等你回答 / Question waiting'), body: item.detail ?? 'The agent asked a question.' }
    case 'job':
      return { title: title('后台任务结束 / Job finished'), body: `${item.detail ?? 'job'} · ${item.status ?? ''}`.trim() }
    case 'subagent':
      return { title: title('子代理完成 / Subagent finished'), body: item.detail ?? 'A subagent finished.' }
    case 'workflow':
      return { title: title('工作流结束 / Workflow finished'), body: item.detail ?? 'A workflow finished.' }
    default:
      return { title: title('DSH'), body: item.detail ?? 'Notification' }
  }
}

/* ------------------------------------------------------------------ */
/* 2. Runtime state                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build the mutable notifier state for one plugin instance.
 * @param config - validated plugin configuration.
 * @param options.deliver - fallback delivery hook (tests replace it).
 */
export function createState(config, options = {}) {
  const state = {
    config: normalizeConfig(config),
    /** When this plugin instance bound; lets a hot reload be told apart. */
    createdAt: Date.now(),
    /** Monotonic notification id; the client cursor is the last id it read. */
    counter: 0,
    /** Buffered notifications waiting for an attached client. */
    items: [],
    /** clientId → { seen: epoch ms, permission: 'granted' | 'denied' | 'default' }. */
    clients: new Map(),
    /** sessionId → Session title, fed by the `session/title` event. */
    titles: new Map(),
    /** sessionId → epoch ms of the current `turn/start`. */
    turns: new Map(),
    /** sessionId → last assistant reply preview. */
    previews: new Map(),
    /** `${sessionId}:${kind}` → epoch ms of the last emitted notification. */
    dedupe: new Map(),
    /** approval request id → notification id, so the decision can dismiss it. */
    approvals: new Map(),
    /** workflow run id → run name, fed by `tool-workflow/run-start`. */
    runs: new Map(),
    /** Number of notifications delivered through the osascript fallback. */
    fallbackCount: 0,
    /** Number of notifications handed to attached clients. */
    pushedCount: 0,
    /** Whether the last notification was dropped by quiet hours / filters. */
    lastSkip: undefined,
    /** Fallback delivery (osascript in production; a recorder in tests). */
    deliver: options.deliver ?? ((item) => deliverViaOsascript(item, state.config)),
    /** Everything handed to the fallback, for diagnostics and tests. */
    delivered: [],
  }
  return state
}

/** Public (client-facing) configuration: the policy the client honors. */
export function publicConfig(state) {
  const config = state.config
  return {
    enabled: config.enabled !== false,
    whenBackgroundOnly: config.whenBackgroundOnly !== false,
    sound: config.sound !== false,
    preview: config.preview !== false,
  }
}

/** Clients that polled recently enough to be considered attached. */
export function activeClients(state, now = Date.now()) {
  const active = []
  for (const [id, client] of state.clients) {
    if (now - client.seen <= CLIENT_ACTIVE_MS) active.push({ id, ...client })
  }
  return active
}

/** Whether delivery through an attached client is currently possible. */
function clientChannelUsable(state) {
  const active = activeClients(state)
  return active.some((client) => client.permission !== 'denied')
}

/** Drop expired ring-buffer entries. */
export function pruneItems(state, now = Date.now()) {
  state.items = state.items.filter((item) => now - item.at <= ITEM_TTL_MS).slice(-MAX_ITEMS)
  for (const [key, at] of state.dedupe) if (now - at > APPROVAL_DEDUPE_MS) state.dedupe.delete(key)
  for (const [id, at] of state.turns) if (now - at > 6 * 60 * 60 * 1000) state.turns.delete(id)
  for (const id of state.approvals.keys()) {
    if (!state.items.some((item) => item.id === state.approvals.get(id))) state.approvals.delete(id)
  }
}

/* ------------------------------------------------------------------ */
/* 3. Delivery                                                         */
/* ------------------------------------------------------------------ */

/** `osascript display notification`; fire-and-forget, never blocks the turn. */
function deliverViaOsascript(item, config) {
  const copy = fallbackCopy(item, config)
  const script = appleScriptFor({
    title: copy.title,
    body: copy.body,
    subtitle: undefined,
    sound: config.sound === false ? undefined : (config.fallbackSoundName || DEFAULT_SOUND),
  })
  try {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 }, () => {})
  } catch (_ignored) {
    /* a notification is never worth failing a turn over */
  }
}

/**
 * Emit one notification: dedupe, apply quiet hours, then hand it to an attached
 * client or fall back to osascript. Never throws into the agent loop.
 */
export function pushNotification(state, spec, now = Date.now()) {
  const config = state.config
  if (config.enabled === false) return undefined
  if (inQuietHours(config.quietHours, new Date(now))) {
    state.lastSkip = 'quiet-hours'
    return undefined
  }
  const key = dedupeKey(spec)
  const last = state.dedupe.get(key)
  const window = spec.kind === 'approval' ? APPROVAL_DEDUPE_MS : DEDUPE_MS
  if (last !== undefined && now - last < window) {
    state.lastSkip = 'duplicate'
    return undefined
  }
  state.dedupe.set(key, now)

  const item = {
    id: state.counter + 1,
    at: now,
    sound: config.sound !== false,
    ...spec,
  }
  state.counter = item.id
  if (spec.kind === 'approval' && typeof spec.approvalId === 'string') state.approvals.set(spec.approvalId, item.id)
  state.items = [...state.items, item].slice(-MAX_ITEMS)

  if (clientChannelUsable(state)) {
    state.pushedCount += 1
    return item
  }
  if (config.fallbackWhenNoClient !== false) {
    state.fallbackCount += 1
    try {
      state.deliver(item)
    } catch (_ignored) {
      /* a notification is never worth failing a turn over */
    }
  }
  return item
}

/* ------------------------------------------------------------------ */
/* 4. Event classification                                            */
/* ------------------------------------------------------------------ */

/** Session header id, or undefined for a detached Session. */
function sessionIdOf(session) {
  const id = session?.header?.id
  return typeof id === 'string' ? id : undefined
}

/** Observe one durable session event and emit at most one notification. */
export function observeSessionEvent(state, session, event) {
  if (event === null || typeof event !== 'object') return
  const config = state.config
  const id = sessionIdOf(session)
  const isSubagent = session?.header?.origin === 'subagent'
  const time = typeof event.time === 'number' ? event.time : Date.now()
  const data = event.data ?? {}

  switch (event.type) {
    case 'session/title': {
      if (id !== undefined && typeof data.title === 'string') state.titles.set(id, data.title)
      return
    }
    case 'turn/start': {
      if (id !== undefined) state.turns.set(id, time)
      return
    }
    case 'assistant/message': {
      if (id === undefined) return
      if (data.interrupted === true) return
      const text = messageText(data.message)
      if (text.length > 0) state.previews.set(id, summarize(text))
      return
    }
    case 'turn/end': {
      if (id !== undefined) {
        const started = state.turns.get(id)
        state.turns.delete(id)
        const reason = data.reason ?? {}
        const durationMs = typeof started === 'number' ? time - started : undefined
        onTurnEnd(state, session, { id, isSubagent, reason, durationMs, time })
      }
      return
    }
    case 'approval/asked': {
      if (config.approvals === false) return
      const toolName = typeof data.toolName === 'string' ? data.toolName : 'tool call'
      pushNotification(state, {
        kind: 'approval',
        sessionId: id,
        sessionTitle: sessionLabel(session, state.titles),
        detail: toolName,
        approvalId: typeof data.id === 'string' ? data.id : undefined,
        cwd: session?.header?.cwd,
      }, time)
      return
    }
    case 'approval/decided': {
      if (typeof data.id !== 'string') return
      const notificationId = state.approvals.get(data.id)
      if (notificationId === undefined) return
      state.approvals.delete(data.id)
      pushDismiss(state, { sessionId: id, dismissId: notificationId, time, outcome: data.outcome })
      return
    }
    // `job/settled` is deliberately NOT handled here: every foreground Bash
    // call is a job too, so the durable event alone cannot tell a background
    // command from one the agent is still waiting on. The jobs service carries
    // `awaited` for exactly that distinction — see observeJobEvent().
    case 'tool-workflow/run-start': {
      if (typeof data.runId === 'string') state.runs.set(data.runId, typeof data.name === 'string' ? data.name : 'workflow')
      return
    }
    case 'tool-workflow/run-end': {
      if (config.workflows === false) return
      const name = typeof data.runId === 'string' ? state.runs.get(data.runId) : undefined
      if (typeof data.runId === 'string') state.runs.delete(data.runId)
      pushNotification(state, {
        kind: 'workflow',
        sessionId: id,
        sessionTitle: sessionLabel(session, state.titles),
        detail: name ?? (typeof data.stopReason === 'string' ? data.stopReason : 'workflow'),
        status: typeof data.stopReason === 'string' ? data.stopReason : undefined,
        cwd: session?.header?.cwd,
      }, time)
      return
    }
    default:
      return
  }
}

/** Turn-end fan-out: completed, failed, aborted, or a subagent's turn. */
function onTurnEnd(state, session, { id, isSubagent, reason, durationMs, time }) {
  const config = state.config
  const kind = typeof reason === 'object' && reason !== null ? reason.kind : undefined
  const preview = config.preview === false ? undefined : state.previews.get(id)
  state.previews.delete(id)

  if (isSubagent) {
    if (config.subagents === false) return
    pushNotification(state, {
      kind: 'subagent',
      sessionId: id,
      sessionTitle: sessionLabel(session, state.titles),
      detail: typeof session?.header?.agentPreset === 'string' ? session.header.agentPreset : undefined,
      status: typeof kind === 'string' ? kind : undefined,
      durationMs,
      cwd: session?.header?.cwd,
    }, time)
    return
  }

  if (kind === 'completed') {
    if (config.turnEnd === false) return
    if (Number(config.minTurnSeconds) > 0 && typeof durationMs === 'number' && durationMs < Number(config.minTurnSeconds) * 1000) return
    pushNotification(state, {
      kind: 'turn-end',
      sessionId: id,
      sessionTitle: sessionLabel(session, state.titles),
      preview,
      durationMs,
      cwd: session?.header?.cwd,
    }, time)
    return
  }

  if (config.errors === false) return
  if (kind === 'aborted' && reason?.reason?.kind === 'user') return
  if (kind === 'error') {
    const message = reason?.error?.message
    pushNotification(state, {
      kind: 'turn-error',
      sessionId: id,
      sessionTitle: sessionLabel(session, state.titles),
      detail: typeof message === 'string' ? summarize(message, 160) : 'The turn failed.',
      cwd: session?.header?.cwd,
    }, time)
    return
  }
  if (kind === 'aborted') {
    pushNotification(state, {
      kind: 'turn-aborted',
      sessionId: id,
      sessionTitle: sessionLabel(session, state.titles),
      detail: typeof reason?.reason?.kind === 'string' ? `interrupted (${reason.reason.kind})` : 'interrupted',
      cwd: session?.header?.cwd,
    }, time)
    return
  }
  const labels = { 'max-tokens': 'context window exhausted', blocked: 'the turn was blocked', interrupted: 'interrupted' }
  pushNotification(state, {
    kind: 'turn-error',
    sessionId: id,
    sessionTitle: sessionLabel(session, state.titles),
    detail: labels[kind] ?? 'The turn ended unexpectedly.',
    cwd: session?.header?.cwd,
  }, time)
}

/** Queue a dismiss instruction so the client closes a resolved notification. */
export function pushDismiss(state, { sessionId, dismissId, time, outcome }) {
  const item = {
    id: state.counter + 1,
    at: typeof time === 'number' ? time : Date.now(),
    sound: false,
    kind: 'dismiss',
    sessionId,
    dismissId,
    outcome: typeof outcome === 'string' ? outcome : undefined,
  }
  state.counter = item.id
  state.items = [...state.items, item].slice(-MAX_ITEMS)
  return item
}

/**
 * Observe one `ctx.jobs.events` record and notify only for jobs that settled
 * after their owner stopped waiting (`awaited === false`), i.e. real background
 * work. Foreground tool calls are awaited and stay silent.
 */
export function observeJobEvent(state, event, titles) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type !== 'settled') return undefined
  if (event.awaited === true) return undefined
  if (state.config.jobs === false) return undefined
  if (event.cause === 'teardown') return undefined
  const job = event.job ?? {}
  const owner = typeof job.owner === 'string' ? job.owner : undefined
  const label = typeof job.label === 'string' && job.label.length > 0 ? summarize(job.label, 80) : undefined
  const kind = typeof job.kind === 'string' ? job.kind : 'job'
  return pushNotification(state, {
    kind: 'job',
    sessionId: owner,
    sessionTitle: owner === undefined ? undefined : titles.get(owner),
    detail: label ?? kind,
    status: typeof job.status === 'string' ? job.status : undefined,
  })
}

/** Observe the question waterfall without answering it. */
export function notifyQuestion(state, request) {
  if (state.config.questions === false) return undefined
  const agent = request?.agent
  const session = agent?.session
  const header = session?.header
  const sessionId = typeof header?.id === 'string' ? header.id : undefined
  const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
  const detail = typeof first?.question === 'string' ? summarize(first.question, 160) : 'The agent asked a question.'
  return pushNotification(state, {
    kind: 'question',
    sessionId,
    sessionTitle: session === undefined ? undefined : sessionLabel(session, state.titles),
    detail,
    cwd: header?.cwd,
  })
}

/* ------------------------------------------------------------------ */
/* 5. HTTP surface                                                     */
/* ------------------------------------------------------------------ */

/** JSON response with the headers the client relies on. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/** Read a small JSON request body. */
async function readJson(req, limit = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const text = Buffer.concat(chunks).toString('utf8')
    return text.trim().length === 0 ? {} : JSON.parse(text)
  } catch (_invalidJson) {
    return {}
  }
}

/** Health/diagnostics snapshot used by the settings page and by `curl`. */
export function stateSnapshot(state) {
  return {
    name,
    version: '0.1.0',
    loadedAt: state.createdAt,
    config: publicConfig(state),
    clients: activeClients(state).length,
    clientIds: activeClients(state).map((client) => `${client.id}:${client.permission}`),
    cursor: state.counter,
    buffered: state.items.length,
    pushed: state.pushedCount,
    fallback: state.fallbackCount,
    lastSkip: state.lastSkip ?? null,
    titles: state.titles.size,
  }
}

/** Handle one request under {@link API_PREFIX}. */
export async function handleRequest(state, ctx, req, res) {
  let url
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch (_invalidUrl) {
    sendJson(res, 400, { error: { code: 'bad-url', message: 'malformed request URL' } })
    return
  }
  const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && path === '/poll') {
    const clientId = url.searchParams.get('client') ?? 'anonymous'
    const permission = url.searchParams.get('permission') ?? 'default'
    const requested = Number(url.searchParams.get('since') ?? '-1')
    state.clients.set(clientId, { seen: Date.now(), permission })
    const latest = state.counter
    // A fresh client starts at the current cursor: stale notifications must not
    // replay after a reload.
    if (!Number.isFinite(requested) || requested < 0) {
      sendJson(res, 200, { cursor: latest, config: publicConfig(state), items: [] })
      return
    }
    const items = state.items.filter((item) => item.id > requested)
    sendJson(res, 200, { cursor: latest, config: publicConfig(state), items })
    return
  }

  if (method === 'GET' && path === '/state') {
    sendJson(res, 200, stateSnapshot(state))
    return
  }

  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, name })
    return
  }

  if (method === 'POST' && path === '/test') {
    const body = await readJson(req)
    const item = pushNotification(state, {
      kind: 'test',
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      sessionTitle: typeof body.title === 'string' ? summarize(body.title, 60) : 'DeepSeek Harness',
      detail: typeof body.body === 'string' ? summarize(body.body, 160) : 'If you can see this, macOS notifications work.',
    })
    sendJson(res, 200, { ok: true, item: item ?? null, delivered: item === undefined ? 'skipped' : clientChannelUsable(state) ? 'client' : 'fallback' })
    return
  }

  sendJson(res, 404, { error: { code: 'not-found', message: `no route ${method} ${path}` } })
}

/* ------------------------------------------------------------------ */
/* 6. Plugin body                                                      */
/* ------------------------------------------------------------------ */

/**
 * Cordis plugin body.
 * @param ctx - host plugin context.
 * @param config - validated {@link Config} value.
 */
export function apply(ctx, config) {
  const state = createState(config)

  ctx.on('session/created', (session) => {
    const id = sessionIdOf(session)
    if (id !== undefined) state.titles.set(id, sessionLabel(session, state.titles))
  })
  ctx.on('session/event', (session, event) => {
    try {
      observeSessionEvent(state, session, event)
    } catch (error) {
      ctx.logger?.warn?.('better-push: event observer failed', error)
    }
  })
  ctx.on('session/disposed', (session) => {
    const id = sessionIdOf(session)
    if (id === undefined) return
    state.titles.delete(id)
    state.turns.delete(id)
    state.previews.delete(id)
  })
  // A question waterfall: notify, then delegate to the real answerer. Never
  // answer it here — returning an answer would steal the question from the UI.
  ctx.on('user-questions/request', (request, next) => {
    try {
      notifyQuestion(state, request)
    } catch (error) {
      ctx.logger?.warn?.('better-push: question observer failed', error)
    }
    return next()
  })

  // Background-job completion. The jobs hub is the only surface that knows
  // whether a job was still awaited, so foreground Bash calls never notify.
  ctx.inject(['jobs'], (sub) => {
    const dispose = sub.jobs.events.subscribe({ owners: 'all' }, (event) => {
      try {
        observeJobEvent(state, event, state.titles)
      } catch (error) {
        ctx.logger?.warn?.('better-push: job observer failed', error)
      }
    })
    sub.effect(() => dispose, 'better-push: job feed')
  })

  ctx.inject(['webServer'], (sub) => {
    const route = sub.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        handleRequest(state, sub, req, res).catch((error) => {
          try {
            sendJson(res, 500, { error: { code: 'internal', message: String(error?.message ?? error) } })
          } catch (_alreadySent) {
            /* response was already closed */
          }
        })
      },
    })
    sub.effect(() => route, 'better-push: http route')
  })

  ctx.effect(() => {
    const timer = setInterval(() => pruneItems(state), 15_000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'better-push: housekeeping')

  ctx.logger?.info?.('better-push: ready (macOS notifications)')
}
