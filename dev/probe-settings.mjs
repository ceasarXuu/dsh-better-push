#!/usr/bin/env node
/**
 * Probe the settings UI of a running DSH web instance via CDP and report
 * whether the better-push configuration form is reachable and rendered.
 *
 * Usage: node dev/probe-settings.mjs <dev-url> [cdp-port]
 */
const DEV_URL = process.argv[2]
const CDP_PORT = Number(process.argv[3] ?? 9333)
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
await sleep(7_000)

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return result.result.value
}

/** Click the first element whose text or aria-label matches a pattern. */
const clickByText = (pattern) => evaluate(`(() => {
  const pattern = new RegExp(${JSON.stringify(pattern)}, 'i')
  const candidates = [...document.querySelectorAll('button, [role="tab"], [role="button"], a')]
  const hit = candidates.find((el) => {
    const text = (el.innerText || '').trim()
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || ''
    return pattern.test(text) || pattern.test(label)
  })
  if (hit === undefined) return null
  hit.click()
  return (hit.innerText || hit.getAttribute('aria-label') || '').trim().slice(0, 40)
})()`)

const report = { steps: [] }
report.steps.push({ step: 'boot', buttons: await evaluate(`[...document.querySelectorAll('button, [role="button"], [role="tab"]')].map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim()).filter((text) => text.length > 0).slice(0, 25)`) })

const openedSettings = await clickByText('设置|settings')
report.steps.push({ step: 'open-settings', clicked: openedSettings })
await sleep(1_500)
report.steps.push({ step: 'after-settings', text: await evaluate(`document.body.innerText.slice(0, 400)`) })

const openedPlugins = await clickByText('^插件$|^Plugins$|插件')
report.steps.push({ step: 'open-plugins', clicked: openedPlugins })
await sleep(1_500)
report.steps.push({
  step: 'after-plugins',
  text: await evaluate(`document.body.innerText.slice(0, 1200)`),
  inputs: await evaluate(`[...document.querySelectorAll('input, textarea, select')].length`),
  switches: await evaluate(`[...document.querySelectorAll('[role="switch"], input[type="checkbox"]')].length`),
  mentionsPlugin: await evaluate(`/better[- ]?push|Better Push/i.test(document.body.innerText)`),
  mentionsFields: await evaluate(`/whenBackgroundOnly|fallbackWhenNoClient|quietHours/.test(document.body.innerText)`),
})

console.log(JSON.stringify(report, null, 2))
await send('Target.closeTarget', { targetId })
socket.close()
