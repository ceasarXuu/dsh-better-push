#!/usr/bin/env node
/**
 * Verify the Notifications settings surface and click-navigation in a running
 * DSH web instance over the Chrome DevTools Protocol.
 *
 * Usage: node dev/verify-settings.mjs <dev-url> [cdp-port]
 */
const DEV_URL = process.argv[2]
const CDP_PORT = Number(process.argv[3] ?? 9333)
if (DEV_URL === undefined) {
  console.error('usage: node dev/verify-settings.mjs <dev-url> [cdp-port]')
  process.exit(2)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
const socket = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  }
})
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
await send('Page.navigate', { url: DEV_URL }, sessionId)
await sleep(8_000)

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'page evaluation failed')
  }
  return result.result.value
}

/** Click the first control whose text/aria-label matches, retrying while the UI hydrates. */
async function clickByText(pattern, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const clicked = await evaluate(`(() => {
      const pattern = new RegExp(${JSON.stringify(pattern)}, 'iu')
      const candidates = [...document.querySelectorAll('button, [role="button"], [role="tab"], a')]
      const hit = candidates.find((el) => {
        const text = (el.innerText || '').trim()
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim()
        return pattern.test(text) || pattern.test(label)
      })
      if (hit === undefined) return { clicked: null, sample: candidates.slice(0, 12).map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 20)) }
      hit.scrollIntoView({ block: 'center' })
      hit.click()
      return { clicked: (hit.innerText || hit.getAttribute('aria-label') || '').trim().slice(0, 30) }
    })()`)
    if (clicked.clicked !== null) return clicked.clicked
    if (Date.now() > deadline) return { failed: true, sample: clicked.sample }
    await sleep(700)
  }
}

const report = {}

// 1. The debug handle and the session catalog.
report.pluginLoaded = await evaluate(`Boolean(window.__dshBetterPush)`)
report.workspaceAvailable = await evaluate(`window.__dshBetterPush?.workspaceAvailable === true`)

// 2. Open Settings from the account menu (the Plugins rail button opens the
//    plugin manager page, not the settings overlay).
report.openedAccountMenu = await clickByText('账号菜单|Account menu|账户')
await sleep(1_000)
report.openedSettings = await clickByText('^设置|^Settings')
await sleep(2_000)

// 3. Is our "Notifications" section in the settings sidebar?
report.sidebar = await evaluate(`(() => {
  const items = [...document.querySelectorAll('button, [role="tab"], [role="button"], a')]
    .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim())
    .filter((text) => text.length > 0 && text.length < 24)
  return { hasNotifications: items.some((text) => /^(通知|Notifications)$/u.test(text)), items: items.slice(0, 20) }
})()`)

report.openedSection = await clickByText('^(通知|Notifications)$')
await sleep(1_200)

report.section = await evaluate(`(() => {
  const text = document.body.innerText
  const labels = [...document.querySelectorAll('label')].map((label) => (label.innerText || '').replace(/\\s+/gu, ' ').trim()).filter(Boolean)
  return {
    titleShown: /macOS (系统)?通知|macOS notifications/u.test(text),
    introShown: /回合完成、等待审批|Native banners for turns/u.test(text),
    checkboxCount: document.querySelectorAll('input[type="checkbox"]').length,
    textInputCount: document.querySelectorAll('input[type="text"]').length,
    numberInputCount: document.querySelectorAll('input[type="number"]').length,
    labels: labels.slice(0, 24),
    hasTestButton: [...document.querySelectorAll('button')].some((el) => /发送测试通知|Send test notification/u.test(el.innerText || '')),
    hasChannelPanel: /通知通道|Delivery channel/u.test(text),
    hasNavigationPanel: /会话跳转|Session navigation/u.test(text),
  }
})()`)

// 4. Toggle the master switch and confirm the host stored it.
report.toggle = await evaluate(`(async () => {
  const label = [...document.querySelectorAll('label')].find((el) => /启用 macOS 系统通知|Enable macOS notifications/u.test(el.innerText || ''))
  const input = label?.querySelector('input[type="checkbox"]')
  if (input === undefined || input === null) return { found: false }
  const before = input.checked
  input.click()
  await new Promise((resolve) => setTimeout(resolve, 3500))
  const state = await (await fetch('/plugin/better-push/state', { credentials: 'same-origin' })).json()
  const afterHost = state.config.enabled
  // Restore the switch so the dev profile is left as it was.
  const label2 = [...document.querySelectorAll('label')].find((el) => /启用 macOS 系统通知|Enable macOS notifications/u.test(el.innerText || ''))
  label2?.querySelector('input[type="checkbox"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 3500))
  const restored = await (await fetch('/plugin/better-push/state', { credentials: 'same-origin' })).json()
  return { found: true, before, hostAfterToggle: afterHost, hostRestored: restored.config.enabled }
})()`)

// 5. Click-navigation: open a session from the catalog.
report.navigation = await evaluate(`(async () => {
  const push = window.__dshBetterPush
  let ids = push?.listSessions?.() ?? []
  if (ids.length === 0) {
    const create = [...document.querySelectorAll('button')].find((el) => /新建会话|New session|New chat/u.test((el.innerText || '').trim()))
    if (create !== undefined) { create.click(); await new Promise((resolve) => setTimeout(resolve, 2500)) }
    ids = push?.listSessions?.() ?? []
  }
  if (ids.length === 0) return { sessionCount: 0 }
  const target = ids[0]
  const opened = push.openSession(target)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const state = await (await fetch('/plugin/better-push/state', { credentials: 'same-origin' })).json()
  return {
    sessionCount: ids.length,
    target,
    openedReturn: opened,
    diag: push.diag,
    hostClientDiag: state.clientDiag,
    bodyHasSessionUi: /发送消息|Send|composer/iu.test(document.body.innerText.slice(0, 400)),
  }
})()`)

console.log(JSON.stringify(report, null, 2))
await send('Target.closeTarget', { targetId })
socket.close()
