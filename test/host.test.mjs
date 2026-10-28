import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Config,
  appleScriptFor,
  createState,
  formatDuration,
  handleRequest,
  inQuietHours,
  messageText,
  normalizeConfig,
  observeJobEvent,
  observeSessionEvent,
  parseQuietHours,
  pushNotification,
  stateSnapshot,
  summarize,
} from '../index.js'

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Validated config with every default applied. */
function defaults(overrides = {}) {
  return Config(overrides)
}

/** A Session-shaped object (only the fields the plugin reads). */
function fakeSession({ id = 'session-1', cwd = '/Users/me/projects/demo-app', origin, agentPreset, parentSession } = {}) {
  return { header: { id, cwd, origin, agentPreset, parentSession } }
}

/** Event-shaped object as `Session.append` publishes it. */
function evt(type, data, time = Date.now()) {
  return { type, data, time, seq: 0 }
}

/** State with an attached client, so notifications buffer instead of falling back. */
function stateWithClient(config = defaults(), clientOptions = { permission: 'granted' }) {
  const state = createState(config, { deliver: (item) => state.delivered.push(item) })
  state.clients.set('client-1', { seen: Date.now(), ...clientOptions })
  return state
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

test('summarize collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(summarize('  hello \n world  '), 'hello world')
  const long = summarize('x'.repeat(200), 20)
  assert.equal(long.length, 20)
  assert.ok(long.endsWith('…'))
})

test('messageText joins only text blocks', () => {
  const message = {
    content: [
      { type: 'text', text: 'first' },
      { type: 'tool_call', id: 'x' },
      { type: 'text', text: 'second' },
    ],
  }
  assert.equal(messageText(message), 'first second')
  assert.equal(messageText(undefined), '')
})

test('formatDuration renders seconds, minutes and hours', () => {
  assert.equal(formatDuration(4_000), '4s')
  assert.equal(formatDuration(60_000), '1m')
  assert.equal(formatDuration(95_000), '1m35s')
  assert.equal(formatDuration(3_900_000), '1h5m')
  assert.equal(formatDuration(Number.NaN), '')
})

test('parseQuietHours accepts valid windows and rejects junk', () => {
  assert.deepEqual(parseQuietHours('22:00-08:00'), { start: 1320, end: 480 })
  assert.deepEqual(parseQuietHours('9:05 - 17:30'), { start: 545, end: 1050 })
  assert.equal(parseQuietHours(''), undefined)
  assert.equal(parseQuietHours('25:00-08:00'), undefined)
  assert.equal(parseQuietHours('12:00-12:00'), undefined)
})

test('inQuietHours handles same-day and overnight windows', () => {
  const overnight = '22:00-08:00'
  assert.equal(inQuietHours(overnight, new Date(2026, 0, 1, 23, 30)), true)
  assert.equal(inQuietHours(overnight, new Date(2026, 0, 1, 7, 59)), true)
  assert.equal(inQuietHours(overnight, new Date(2026, 0, 1, 8, 0)), false)
  assert.equal(inQuietHours(overnight, new Date(2026, 0, 1, 12, 0)), false)
  const sameDay = '09:00-17:00'
  assert.equal(inQuietHours(sameDay, new Date(2026, 0, 1, 10, 0)), true)
  assert.equal(inQuietHours(sameDay, new Date(2026, 0, 1, 18, 0)), false)
  assert.equal(inQuietHours('', new Date()), false)
})

test('appleScriptFor escapes quotes, backslashes and newlines', () => {
  const script = appleScriptFor({
    title: 'DSH "quoted"',
    body: 'line1\nline2 \\ backslash',
    sound: 'Glass',
  })
  assert.ok(script.startsWith('display notification "line1 line2 \\\\ backslash" with title "DSH \\"quoted\\""'))
  assert.ok(script.includes('sound name "Glass"'))
  assert.ok(!script.includes('\n'))
  const silent = appleScriptFor({ title: 't', body: 'b', sound: undefined })
  assert.ok(!silent.includes('sound name'))
})

/* ------------------------------------------------------------------ */
/* Turn lifecycle                                                      */
/* ------------------------------------------------------------------ */

test('a completed turn buffers one notification for an attached client', () => {
  const state = stateWithClient()
  const session = fakeSession()
  const start = evt('turn/start', { turn: 1 }, 1_000)
  observeSessionEvent(state, session, start)
  observeSessionEvent(state, session, evt('session/title', { title: 'Fix the parser' }, 1_100))
  observeSessionEvent(state, session, evt('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Done — the parser handles EOF now.' }] } }, 1_500))
  observeSessionEvent(state, session, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5_000))

  assert.equal(state.items.length, 1)
  const item = state.items[0]
  assert.equal(item.kind, 'turn-end')
  assert.equal(item.sessionId, 'session-1')
  assert.equal(item.sessionTitle, 'Fix the parser')
  assert.equal(item.preview, 'Done — the parser handles EOF now.')
  assert.equal(item.durationMs, 4_000)
  assert.equal(state.delivered.length, 0)
  assert.equal(state.pushedCount, 1)
})

test('without an attached client the fallback runs instead of buffering', () => {
  const state = createState(defaults(), { deliver: (item) => state.delivered.push(item) })
  const session = fakeSession({ cwd: '/Users/me/projects/demo-app' })
  observeSessionEvent(state, session, evt('turn/start', { turn: 1 }, 1_000))
  observeSessionEvent(state, session, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2_000))
  assert.equal(state.items.length, 1)
  assert.equal(state.delivered.length, 1)
  assert.equal(state.fallbackCount, 1)
  // The folder name stands in for the Session title.
  assert.equal(state.delivered[0].sessionTitle, 'demo-app')
})

test('fallbackWhenNoClient=false drops the notification when no window is attached', () => {
  const state = createState(defaults({ fallbackWhenNoClient: false }), { deliver: () => {} })
  observeSessionEvent(state, fakeSession(), evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2_000))
  assert.equal(state.items.length, 1)
  assert.equal(state.fallbackCount, 0)
})

test('a failed turn reports the provider error', () => {
  const state = stateWithClient()
  observeSessionEvent(state, fakeSession(), evt('turn/end', {
    turn: 1,
    reason: { kind: 'error', error: { message: 'rate limited', code: 'rate-limit' } },
  }))
  assert.equal(state.items[0].kind, 'turn-error')
  assert.equal(state.items[0].detail, 'rate limited')
})

test('a user-cancelled turn stays silent; an interrupt is reported', () => {
  const state = stateWithClient()
  observeSessionEvent(state, fakeSession(), evt('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 1_000))
  assert.equal(state.items.length, 0)
  state.dedupe.clear()
  observeSessionEvent(state, fakeSession({ id: 'session-2' }), evt('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } }, 1_100))
  assert.equal(state.items[0].kind, 'turn-aborted')
})

test('the errors switch silences failures but not finished turns', () => {
  const state = stateWithClient(defaults({ errors: false }))
  observeSessionEvent(state, fakeSession(), evt('turn/end', { turn: 1, reason: { kind: 'max-tokens' } }, 1_000))
  assert.equal(state.items.length, 0)
  observeSessionEvent(state, fakeSession({ id: 'session-2' }), evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_100))
  assert.equal(state.items.length, 1)
})

test('minTurnSeconds skips quick turns', () => {
  const state = stateWithClient(defaults({ minTurnSeconds: 10 }))
  observeSessionEvent(state, fakeSession(), evt('turn/start', { turn: 1 }, 1_000))
  observeSessionEvent(state, fakeSession(), evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3_000))
  assert.equal(state.items.length, 0)
  observeSessionEvent(state, fakeSession(), evt('turn/start', { turn: 2 }, 10_000))
  observeSessionEvent(state, fakeSession(), evt('turn/end', { turn: 2, reason: { kind: 'completed' } }, 25_000))
  assert.equal(state.items.length, 1)
})

test('subagent notifications are off by default and notify when switched on', () => {
  const subagent = fakeSession({ id: 'sub-1', origin: 'subagent', agentPreset: 'reviewer' })

  // Default: a busy Agent Team must not ping on every child turn.
  const quiet = stateWithClient(defaults())
  assert.equal(normalizeConfig(defaults()).subagents, false)
  observeSessionEvent(quiet, subagent, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_000))
  assert.equal(quiet.items.length, 0)

  const loud = stateWithClient(defaults({ subagents: true }))
  observeSessionEvent(loud, subagent, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_000))
  assert.equal(loud.items.length, 1)
  assert.equal(loud.items[0].kind, 'subagent')
  assert.equal(loud.items[0].detail, 'reviewer')
})

test('a subagent notification clicks through to the parent conversation', () => {
  const state = stateWithClient(defaults({ subagents: true }))
  const parent = fakeSession({ id: 'parent-1', cwd: '/Users/me/projects/demo-app' })
  observeSessionEvent(state, parent, evt('session/title', { title: 'Refactor the parser' }, 1_000))
  // The child session announces itself through a normal event first.
  const child = fakeSession({ id: 'child-1', origin: 'subagent', agentPreset: 'reviewer', parentSession: 'parent-1' })
  observeSessionEvent(state, child, evt('turn/start', { turn: 1 }, 1_100))
  observeSessionEvent(state, child, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2_000))

  const item = state.items.at(-1)
  assert.equal(item.kind, 'subagent')
  assert.equal(item.sessionId, 'child-1')
  assert.equal(item.openSessionId, 'parent-1')
  assert.equal(item.sessionTitle, 'Refactor the parser')
  assert.equal(item.detail, 'reviewer')
})

test('a background job owned by a subagent opens the parent conversation', () => {
  const state = stateWithClient()
  const parent = { header: { id: 'parent-2', cwd: '/Users/me/projects/demo-app' } }
  observeSessionEvent(state, parent, evt('session/title', { title: 'Ship the plugin' }, 1_000))
  observeSessionEvent(state, fakeSession({ id: 'child-2', origin: 'subagent', parentSession: 'parent-2' }), evt('step/start', { turn: 1, step: 1 }, 1_100))
  observeJobEvent(state, {
    type: 'settled',
    awaited: false,
    cause: 'producer',
    job: { id: 'job-9', kind: 'bash', label: 'pnpm test', status: 'completed', owner: 'child-2' },
  }, state.titles)
  const item = state.items.at(-1)
  assert.equal(item.kind, 'job')
  assert.equal(item.sessionId, 'child-2')
  assert.equal(item.openSessionId, 'parent-2')
  assert.equal(item.sessionTitle, 'Ship the plugin')
})

test('duplicate turn-end notifications are coalesced', () => {
  const state = stateWithClient()
  const session = fakeSession()
  observeSessionEvent(state, session, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 10_000))
  observeSessionEvent(state, session, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 10_500))
  assert.equal(state.items.length, 1)
  observeSessionEvent(state, session, evt('turn/end', { turn: 2, reason: { kind: 'completed' } }, 12_500))
  assert.equal(state.items.length, 2)
})

/* ------------------------------------------------------------------ */
/* Approvals and questions                                             */
/* ------------------------------------------------------------------ */

test('an approval request notifies and its decision dismisses the banner', () => {
  const state = stateWithClient()
  const session = fakeSession()
  observeSessionEvent(state, session, evt('approval/asked', { id: 'approval-1', toolName: 'bash' }, 1_000))
  assert.equal(state.items.length, 1)
  assert.equal(state.items[0].kind, 'approval')
  assert.equal(state.items[0].detail, 'bash')

  observeSessionEvent(state, session, evt('approval/decided', { id: 'approval-1', outcome: 'allowed-once' }, 5_000))
  const dismiss = state.items.at(-1)
  assert.equal(dismiss.kind, 'dismiss')
  assert.equal(dismiss.dismissId, state.items[0].id)
})

test('the approvals switch silences approval banners', () => {
  const state = stateWithClient(defaults({ approvals: false }))
  observeSessionEvent(state, fakeSession(), evt('approval/asked', { id: 'approval-1', toolName: 'bash' }, 1_000))
  assert.equal(state.items.length, 0)
})

/* ------------------------------------------------------------------ */
/* Jobs, workflows, quiet hours                                        */
/* ------------------------------------------------------------------ */

test('a background job notifies only once its owner stopped waiting', () => {
  const state = stateWithClient()
  // Awaited: a foreground Bash call the agent is still blocked on — silent.
  observeJobEvent(state, {
    type: 'settled',
    awaited: true,
    cause: 'producer',
    job: { id: 'job-1', kind: 'bash', label: 'pnpm test', status: 'completed', owner: 'session-1' },
  }, state.titles)
  assert.equal(state.items.length, 0)

  // Not awaited: a promoted / run_in_background command — notify.
  observeJobEvent(state, {
    type: 'settled',
    awaited: false,
    cause: 'producer',
    job: { id: 'job-2', kind: 'bash', label: 'pnpm test', status: 'completed', owner: 'session-1' },
  }, state.titles)
  assert.equal(state.items.length, 1)
  assert.equal(state.items[0].kind, 'job')
  assert.equal(state.items[0].detail, 'pnpm test')
  assert.equal(state.items[0].status, 'completed')
  assert.equal(state.items[0].sessionId, 'session-1')

  // A teardown is bookkeeping, not an outcome the user asked about.
  observeJobEvent(state, {
    type: 'settled',
    awaited: false,
    cause: 'teardown',
    job: { id: 'job-3', kind: 'bash', label: 'x', status: 'killed', owner: 'session-1' },
  }, state.titles)
  assert.equal(state.items.length, 1)

  // Non-settled records are ignored.
  observeJobEvent(state, { type: 'registered', job: { id: 'job-4' } }, state.titles)
  assert.equal(state.items.length, 1)
})

test('the jobs switch silences background-job notifications', () => {
  const state = stateWithClient(defaults({ jobs: false }))
  observeJobEvent(state, {
    type: 'settled',
    awaited: false,
    cause: 'producer',
    job: { id: 'job-1', kind: 'bash', label: 'pnpm test', status: 'completed', owner: 'session-1' },
  }, state.titles)
  assert.equal(state.items.length, 0)
})

test('a workflow run reports its name and stop reason', () => {
  const state = stateWithClient()
  const session = fakeSession()
  observeSessionEvent(state, session, evt('tool-workflow/run-start', { runId: 'run-1', name: 'release-check' }, 1_000))
  observeSessionEvent(state, session, evt('tool-workflow/run-end', { runId: 'run-1', stopReason: 'completed' }, 9_000))
  assert.equal(state.items.length, 1)
  assert.equal(state.items[0].kind, 'workflow')
  assert.equal(state.items[0].detail, 'release-check')
})

test('quiet hours suppress notifications entirely', () => {
  const pad = (value) => String(value).padStart(2, '0')
  const clock = (offsetMinutes) => {
    const point = new Date(Date.now() + offsetMinutes * 60_000)
    return `${pad(point.getHours())}:${pad(point.getMinutes())}`
  }
  const state = stateWithClient(defaults({ quietHours: `${clock(-5)}-${clock(5)}` }))
  observeSessionEvent(state, fakeSession(), evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, Date.now()))
  assert.equal(state.items.length, 0)
  assert.equal(state.lastSkip, 'quiet-hours')
})

test('a volatile config write takes effect without a reload', () => {
  // What the loader hands `apply`: volatile fields are reactive refs updated in
  // place by the settings write (`loader/volatile-update`).
  let live = { enabled: true, subagents: false }
  const ref = { get: () => live.subagents }
  const state = createState({
    ...defaults(),
    enabled: { get: () => live.enabled },
    subagents: ref,
  }, { deliver: (item) => state.delivered.push(item) })
  state.clients.set('client-1', { seen: Date.now(), permission: 'granted' })

  const child = fakeSession({ id: 'child-1', origin: 'subagent', parentSession: 'parent-1' })
  observeSessionEvent(state, child, evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_000))
  assert.equal(state.items.length, 0)

  // The settings page flips the switch; the same instance must honor it.
  live = { enabled: true, subagents: true }
  observeSessionEvent(state, child, evt('turn/end', { turn: 2, reason: { kind: 'completed' } }, 5_000))
  assert.equal(state.items.length, 1)

  live = { enabled: false, subagents: true }
  observeSessionEvent(state, fakeSession({ id: 'session-2' }), evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6_000))
  assert.equal(state.items.length, 1)
})

test('a disabled plugin emits nothing', () => {
  const state = stateWithClient(defaults({ enabled: false }))
  observeSessionEvent(state, fakeSession(), evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_000))
  assert.equal(state.items.length, 0)
  assert.equal(pushNotification(state, { kind: 'test' }), undefined)
})

/* ------------------------------------------------------------------ */
/* HTTP surface                                                        */
/* ------------------------------------------------------------------ */

/** Minimal node http response double. */
function fakeRes() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(body) {
      out.body = body ?? ''
    },
  }
}

/** Minimal node http request double. */
function fakeReq(url, { method = 'GET', body } = {}) {
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

test('a fresh poll returns the cursor without replaying history', async () => {
  const state = stateWithClient()
  observeSessionEvent(state, fakeSession(), evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_000))
  const res = fakeRes()
  await handleRequest(state, {}, fakeReq('/plugin/better-push/poll?client=c1&since=-1'), res)
  const payload = JSON.parse(res.out.body)
  assert.equal(payload.cursor, 1)
  assert.deepEqual(payload.items, [])
  assert.equal(payload.config.notifyInForeground, true)
})

test('a follow-up poll returns only items after the cursor', async () => {
  const state = stateWithClient()
  observeSessionEvent(state, fakeSession(), evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_000))
  const res = fakeRes()
  await handleRequest(state, {}, fakeReq('/plugin/better-push/poll?client=c1&since=0'), res)
  const payload = JSON.parse(res.out.body)
  assert.equal(payload.items.length, 1)
  assert.equal(payload.items[0].kind, 'turn-end')
  // The poll is the presence heartbeat.
  assert.equal(state.clients.get('c1').permission, 'default')
})

test('permission=denied from the only client switches delivery to the fallback', async () => {
  const state = createState(defaults(), { deliver: (item) => state.delivered.push(item) })
  state.clients.set('c1', { seen: Date.now(), permission: 'denied' })
  await handleRequest(state, {}, fakeReq('/plugin/better-push/poll?client=c1&since=0&permission=denied'), fakeRes())
  observeSessionEvent(state, fakeSession(), evt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_000))
  assert.equal(state.delivered.length, 1)
})

test('the state endpoint reports clients, counters and config', async () => {
  const state = stateWithClient()
  const res = fakeRes()
  await handleRequest(state, {}, fakeReq('/plugin/better-push/state'), res)
  const payload = JSON.parse(res.out.body)
  assert.equal(payload.name, 'better-push')
  assert.equal(payload.clients, 1)
  assert.equal(payload.config.sound, true)
  assert.equal(stateSnapshot(state).name, 'better-push')
})

test('clients report workspace navigation availability and click outcomes', async () => {
  const state = stateWithClient()
  const pollRes = fakeRes()
  await handleRequest(state, {}, fakeReq('/plugin/better-push/poll?client=c1&since=0&permission=granted&ws=1'), pollRes)

  const stateRes = fakeRes()
  await handleRequest(state, {}, fakeReq('/plugin/better-push/state'), stateRes)
  assert.ok(JSON.parse(stateRes.out.body).clientIds.includes('c1:granted:ws'))

  const diagRes = fakeRes()
  await handleRequest(state, {}, fakeReq('/plugin/better-push/diag', {
    method: 'POST',
    body: JSON.stringify({ workspace: true, permission: 'granted', lastClick: { sessionId: 'session-1', ok: false, error: 'no binding' } }),
  }), diagRes)
  assert.equal(JSON.parse(diagRes.out.body).ok, true)

  const afterRes = fakeRes()
  await handleRequest(state, {}, fakeReq('/plugin/better-push/state'), afterRes)
  const after = JSON.parse(afterRes.out.body)
  assert.equal(after.clientDiag.lastClick.ok, false)
  assert.equal(after.clientDiag.lastClick.error, 'no binding')
  assert.equal(after.clientDiag.workspace, true)
})

test('the test endpoint pushes a notification through the active channel', async () => {
  const state = stateWithClient()
  const res = fakeRes()
  await handleRequest(state, {}, fakeReq('/plugin/better-push/test', { method: 'POST', body: '{"body":"hello"}' }), res)
  const payload = JSON.parse(res.out.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.delivered, 'client')
  assert.equal(state.items[0].kind, 'test')
  assert.equal(state.items[0].detail, 'hello')
})

test('unknown routes answer 404 JSON', async () => {
  const state = createState(defaults(), { deliver: () => {} })
  const res = fakeRes()
  await handleRequest(state, {}, fakeReq('/plugin/better-push/nope'), res)
  assert.equal(res.out.status, 404)
})
