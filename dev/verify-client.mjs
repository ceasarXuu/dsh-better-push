#!/usr/bin/env node
/**
 * End-to-end client verification over the Chrome DevTools Protocol.
 *
 * Boots a fresh page against a `dsh web` instance, installs a `Notification`
 * spy before any app script runs, waits for the browser half of the plugin to
 * poll, then asks the host to push a test notification and reports what the
 * browser half did.
 *
 * Usage: node dev/verify-client.mjs <dev-url> [cdp-port]
 */
const DEV_URL = process.argv[2]
const CDP_PORT = Number(process.argv[3] ?? 9333)
if (DEV_URL === undefined) {
  console.error('usage: node dev/verify-client.mjs <dev-url> [cdp-port]')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Notification spy: runs before every app script in the document. */
const SPY = `
(() => {
  const log = (window.__pushSpy = [])
  const closed = (window.__pushClosed = [])
  class FakeNotification extends EventTarget {
    static permission = 'granted'
    static requestPermission() { return Promise.resolve('granted') }
    constructor(title, options = {}) {
      super()
      this.title = title
      this.body = options.body
      this.tag = options.tag
      this.silent = options.silent
      log.push({ title, body: options.body ?? null, tag: options.tag ?? null, silent: options.silent ?? null, at: Date.now() })
    }
    close() { closed.push(this.tag ?? null) }
  }
  Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true })
})()
`

const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
const { webSocketDebuggerUrl } = await response.json()
const socket = new WebSocket(webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) reject(new Error(message.error.message))
    else resolve(message.result)
  }
})

/** Send one CDP command and await its result. */
function send(method, params = {}, sessionId) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Page.addScriptToEvaluateOnNewDocument', { source: SPY }, sessionId)
await send('Page.navigate', { url: DEV_URL }, sessionId)
await sleep(8_000)

/** Evaluate an async expression in the page and return its JSON value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'page evaluation failed')
  }
  return result.result.value
}

const report = await evaluate(`(async () => {
  const json = async (path, init) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  const before = await json('/plugin/better-push/state')
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const settled = await json('/plugin/better-push/state')
  const pushed = await json('/plugin/better-push/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'cdp client probe' }),
  })
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const opened = await json('/plugin/better-push/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'cdp second probe' }),
  })
  await new Promise((resolve) => setTimeout(resolve, 2500))
  return {
    before: before.body,
    settled: settled.body,
    pushed: pushed.body,
    opened: opened.body,
    spy: window.__pushSpy,
    closed: window.__pushClosed,
    hasModuleLoader: typeof window.__ModuleLoader__ !== 'undefined',
    permission: (() => { try { return Notification.permission } catch (_error) { return 'threw' } })(),
  }
})()`)

console.log(JSON.stringify(report, null, 2))
await send('Target.closeTarget', { targetId })
socket.close()
