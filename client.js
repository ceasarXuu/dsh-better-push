// dsh-better-push — browser half.
//
// Three jobs:
//
// 1. **Notify.** Polls the host half (`/plugin/better-push/poll`) and turns the
//    notifications it returns into renderer `Notification`s. On the DSH desktop
//    app those are native macOS banners attributed to *DeepSeek Harness* — the
//    icon is the app icon, and clicking one focuses the window and opens the
//    Session that fired it.
// 2. **Navigate.** A notification carries `openSessionId` (the root
//    conversation: a subagent/teammate turn points at its parent, because a
//    child Session cannot be opened in the workspace). The click handler opens
//    it through `uiWorkspace.openSession`.
// 3. **Configure.** Registers a top-level **Notifications** section in Settings
//    (`settings.section`) plus the plugin row's own config page
//    (`plugins.row.config`), rendering the host-side config schema through
//    `configForms`. The shipped UI renders no generic form for third-party
//    bundles, so the plugin brings its own surface.
//
// Why a poll instead of an event stream: the desktop renderer runs on the
// `dsh-app://app` origin, which the Electron shell forwards to the host. A
// plain same-origin `fetch` goes through that forwarder; EventSource on a
// custom scheme does not. One request per second on loopback is free, and it
// doubles as the presence heartbeat the host uses to decide whether an
// `osascript` fallback is needed (no client polling = window closed).
window.__ModuleLoader__.load({
  id: '@ceasarxuu/dsh-better-push',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /** Own locale namespace (reusing a shipped namespace throws). */
    const NS = 'betterPush'
    /** Host route prefix; keep in sync with `index.js`. */
    const API = '/plugin/better-push'
    /** Cordis row id of the host half: the settings namespace. */
    const ROW_ID = 'better-push'
    /** Presence heartbeat + notification latency budget. */
    const POLL_MS = 1000
    const POLL_ERROR_MS = 3000
    const REQUEST_TIMEOUT_MS = 4000

    /** English copy. */
    const en = {
      'title.turn-end': 'Turn finished',
      'title.turn-error': 'Turn failed',
      'title.turn-aborted': 'Turn interrupted',
      'title.approval': 'Approval needed',
      'title.question': 'DSH is waiting for your answer',
      'title.job': 'Background job finished',
      'title.subagent': 'Subagent finished',
      'title.workflow': 'Workflow finished',
      'title.test': 'Test notification',
      'title.generic': 'DeepSeek Harness',
      'body.turn-end': 'The agent finished its turn.',
      'body.error': 'The turn ended unexpectedly.',
      'body.approval': 'A tool call is waiting for your approval.',
      'body.question': 'The agent asked you a question.',
      'body.job': 'A background job finished.',
      'body.subagent': 'A subagent finished.',
      'body.workflow': 'A workflow run finished.',
      'body.test': 'If you can see this, macOS notifications work.',
      'duration': 'took {duration}',
      'clickHint': 'Click to open the session',
      'settings.nav': 'Notifications',
      'settings.title': 'macOS notifications',
      'settings.intro': 'Native banners for turns, approvals, questions, background jobs and workflows. Everything here is stored in this profile.',
      'settings.summary': 'Which events notify, foreground policy, sound, quiet hours and the closed-window fallback.',
      'settings.group.general': 'General',
      'settings.group.events': 'Which events',
      'settings.group.advanced': 'Quiet hours and fallback',
      'settings.loading': 'Loading settings…',
      'settings.unavailable': 'The host is not serving this plugin\'s settings document.',
      'settings.readonly': 'This deployment stores plugin settings read-only.',
      'settings.saving': 'Saving…',
      'settings.channel': 'Delivery channel',
      'settings.channelClient': 'App window connected — banners come from DeepSeek Harness.',
      'settings.channelFallback': 'No app window connected — falling back to osascript (shown as Script Editor).',
      'settings.channelCounts': '{pushed} delivered to the window · {fallback} through the fallback',
      'settings.navigation': 'Session navigation',
      'settings.navigationOk': 'available — clicking a banner opens its Session.',
      'settings.navigationMissing': 'unavailable — clicking a banner only brings the window forward.',
      'settings.test': 'Send test notification',
      'settings.testing': 'Sending…',
      'settings.testClient': 'Sent through the app window. If nothing appears, allow notifications for DeepSeek Harness in System Settings.',
      'settings.testFallback': 'Sent through the osascript fallback (it shows as Script Editor).',
      'settings.testFailed': 'Sending failed.',
      'settings.testBody': 'A test notification from dsh-better-push.',
      'settings.field.enabled': 'Enable macOS notifications',
      'settings.field.notifyInForeground': 'Also notify while the window is focused',
      'settings.field.sound': 'Play a sound',
      'settings.field.preview': 'Include a short reply preview',
      'settings.field.turnEnd': 'Turn finished',
      'settings.field.approvals': 'Tool call waiting for approval',
      'settings.field.questions': 'Agent asks a question',
      'settings.field.errors': 'Turn failed or interrupted',
      'settings.field.jobs': 'Background job settled',
      'settings.field.subagents': 'Subagent / teammate turn finished',
      'settings.field.workflows': 'Workflow run finished',
      'settings.field.quietHours': 'Quiet hours',
      'settings.field.minTurnSeconds': 'Skip turns shorter than (seconds)',
      'settings.field.fallbackWhenNoClient': 'Fall back to osascript when the window is closed',
      'settings.field.fallbackSoundName': 'Fallback sound name',
      'settings.hint.notifyInForeground': 'Off means banners only appear while the window is in the background.',
      'settings.hint.quietHours': 'HH:MM-HH:MM local time; empty disables it.',
      'settings.hint.minTurnSeconds': '0 notifies every finished turn.',
      'settings.hint.fallbackWhenNoClient': 'Fallback banners show as Script Editor and cannot reopen DSH.',
      'settings.hint.fallbackSoundName': 'Examples: Glass, Ping, Pop.',
    }

    /** Simplified Chinese copy. */
    const zh = {
      'title.turn-end': '回合完成',
      'title.turn-error': '回合出错',
      'title.turn-aborted': '回合中断',
      'title.approval': '需要你的确认',
      'title.question': 'DSH 在等你回答',
      'title.job': '后台任务完成',
      'title.subagent': '子代理完成',
      'title.workflow': '工作流完成',
      'title.test': '测试通知',
      'title.generic': 'DeepSeek Harness',
      'body.turn-end': 'agent 已完成这一回合。',
      'body.error': '回合异常结束。',
      'body.approval': '有工具调用正在等待你确认。',
      'body.question': 'agent 向你提了一个问题。',
      'body.job': '一个后台任务已结束。',
      'body.subagent': '一个子代理已结束。',
      'body.workflow': '一次工作流运行已结束。',
      'body.test': '能看到这条通知就说明 macOS 通知已打通。',
      'duration': '耗时 {duration}',
      'clickHint': '点击打开对应会话',
      'settings.nav': '通知',
      'settings.title': 'macOS 系统通知',
      'settings.intro': '回合完成、等待审批或回答、后台任务与工作流结束时的原生横幅。以下配置保存在当前 profile 里。',
      'settings.summary': '哪些事件通知、前台策略、提示音、免打扰时段，以及窗口关闭时的兜底。',
      'settings.group.general': '通用',
      'settings.group.events': '通知哪些事件',
      'settings.group.advanced': '免打扰与兜底',
      'settings.loading': '正在读取配置…',
      'settings.unavailable': '宿主没有提供本插件的配置文档。',
      'settings.readonly': '当前部署的插件配置是只读的。',
      'settings.saving': '保存中…',
      'settings.channel': '通知通道',
      'settings.channelClient': '应用窗口已连接——横幅由 DeepSeek Harness 发出。',
      'settings.channelFallback': '应用窗口未连接——正在走 osascript 兜底（显示为脚本编辑器）。',
      'settings.channelCounts': '窗口送达 {pushed} 条 · 兜底 {fallback} 条',
      'settings.navigation': '会话跳转',
      'settings.navigationOk': '可用——点击横幅会打开对应会话。',
      'settings.navigationMissing': '不可用——点击横幅只会把窗口带到前台。',
      'settings.test': '发送测试通知',
      'settings.testing': '发送中…',
      'settings.testClient': '已通过应用窗口发送。没看到的话，去系统设置里允许 DeepSeek Harness 通知。',
      'settings.testFallback': '已通过 osascript 兜底发送（显示为脚本编辑器）。',
      'settings.testFailed': '发送失败。',
      'settings.testBody': '这是一条来自 dsh-better-push 的测试通知。',
      'settings.field.enabled': '启用 macOS 系统通知',
      'settings.field.notifyInForeground': '窗口在前台时也通知',
      'settings.field.sound': '播放提示音',
      'settings.field.preview': '通知里带一行回复摘要',
      'settings.field.turnEnd': '回合完成',
      'settings.field.approvals': '工具调用等待审批',
      'settings.field.questions': 'agent 向你提问',
      'settings.field.errors': '回合出错或被中断',
      'settings.field.jobs': '后台任务结束',
      'settings.field.subagents': '子代理 / teammate 回合结束',
      'settings.field.workflows': '工作流运行结束',
      'settings.field.quietHours': '免打扰时段',
      'settings.field.minTurnSeconds': '跳过短于（秒）的回合',
      'settings.field.fallbackWhenNoClient': '窗口关闭时用 osascript 兜底',
      'settings.field.fallbackSoundName': '兜底提示音名称',
      'settings.hint.notifyInForeground': '关闭后只在窗口不在前台时通知。',
      'settings.hint.quietHours': 'HH:MM-HH:MM（本地时间），留空表示不启用。',
      'settings.hint.minTurnSeconds': '0 表示每个完成的回合都通知。',
      'settings.hint.fallbackWhenNoClient': '兜底横幅显示为“脚本编辑器”，点击无法回到 DSH。',
      'settings.hint.fallbackSoundName': '例如 Glass、Ping、Pop。',
    }

    /** Scoped styles for the settings page (design tokens only). */
    const CSS = `
.bpw-page { display: flex; flex-direction: column; max-width: 760px; color: var(--dsw-alias-label-primary, inherit); }
.bpw-title { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
.bpw-intro { margin: 0 0 8px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
.bpw-root { display: flex; flex-direction: column; gap: 6px; }
.bpw-groupTitle { margin: 18px 0 2px; font-size: 13px; font-weight: 600; }
.bpw-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 9px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25)); }
.bpw-rowText { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bpw-rowLabel { font-size: 13px; line-height: 18px; }
.bpw-rowHint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
.bpw-switch { flex: none; width: 16px; height: 16px; margin-top: 2px; accent-color: var(--dsw-alias-state-business-primary, #2b6bff); cursor: pointer; }
.bpw-input { flex: none; width: 180px; box-sizing: border-box; padding: 5px 8px; font: inherit; font-size: 12px; color: inherit; background: transparent; border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius: 6px; }
.bpw-input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #2b6bff)); outline-offset: 1px; }
.bpw-panel { margin-top: 20px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: 10px; display: flex; flex-direction: column; gap: 6px; }
.bpw-panelTitle { font-size: 12px; font-weight: 600; }
.bpw-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, inherit); }
.bpw-counts { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
.bpw-actions { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.bpw-button { padding: 5px 12px; font: inherit; font-size: 12px; color: inherit; background: transparent; border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); border-radius: 7px; cursor: pointer; }
.bpw-button:hover { background: var(--dsw-alias-bg-l2, rgba(127,127,127,.12)); }
.bpw-button[disabled] { opacity: .5; cursor: default; }
.bpw-result { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
.bpw-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
`

    /* ---------------------------------------------------------------- */
    /* Helpers                                                          */
    /* ---------------------------------------------------------------- */

    /** Short human duration; mirrors the host helper. */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return `${String(seconds)}s`
      const minutes = Math.floor(seconds / 60)
      const rest = seconds % 60
      if (minutes < 60) return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m${String(rest)}s`
      return `${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`
    }

    /** Current renderer notification permission, normalized. */
    function permissionOf() {
      try {
        if (typeof Notification === 'undefined') return 'unsupported'
        const value = Notification.permission
        if (value === 'granted' || value === 'denied' || value === 'default') return value
        return 'default'
      } catch (_unavailable) {
        return 'unsupported'
      }
    }

    /** Whether the DSH window is the focused window right now. */
    function windowIsFocused() {
      try {
        if (typeof document === 'undefined' || typeof document.hasFocus !== 'function') return true
        return document.hasFocus()
      } catch (_unavailable) {
        return true
      }
    }

    /** Random-enough id: the host only needs to tell clients apart. */
    function makeClientId() {
      const random = Math.random().toString(36).slice(2, 10)
      return `web-${random}`
    }

    /* ---------------------------------------------------------------- */
    /* Settings page                                                    */
    /* ---------------------------------------------------------------- */

    /** Field metadata for the generated settings form. */
    const FIELD_GROUPS = [
      {
        title: 'settings.group.general',
        fields: [
          { key: 'enabled', kind: 'boolean' },
          { key: 'notifyInForeground', kind: 'boolean', hint: 'settings.hint.notifyInForeground' },
          { key: 'sound', kind: 'boolean' },
          { key: 'preview', kind: 'boolean' },
        ],
      },
      {
        title: 'settings.group.events',
        fields: [
          { key: 'turnEnd', kind: 'boolean' },
          { key: 'approvals', kind: 'boolean' },
          { key: 'questions', kind: 'boolean' },
          { key: 'errors', kind: 'boolean' },
          { key: 'jobs', kind: 'boolean' },
          { key: 'subagents', kind: 'boolean' },
          { key: 'workflows', kind: 'boolean' },
        ],
      },
      {
        title: 'settings.group.advanced',
        fields: [
          { key: 'quietHours', kind: 'text', placeholder: '22:00-08:00', hint: 'settings.hint.quietHours' },
          { key: 'minTurnSeconds', kind: 'number', hint: 'settings.hint.minTurnSeconds' },
          { key: 'fallbackWhenNoClient', kind: 'boolean', hint: 'settings.hint.fallbackWhenNoClient' },
          { key: 'fallbackSoundName', kind: 'text', placeholder: 'Glass', hint: 'settings.hint.fallbackSoundName' },
        ],
      },
    ]

    /** Subscribe to one config form controller. */
    function useForm(form) {
      return React.useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
        () => form.getSnapshot(),
      )
    }

    /** Poll the host's `/state` while the settings page is visible. */
    function useChannelStatus() {
      const [status, setStatus] = React.useState(null)
      React.useEffect(() => {
        let cancelled = false
        let timer
        const load = async () => {
          try {
            const response = await fetch(`${API}/state`, { credentials: 'same-origin', cache: 'no-store' })
            if (response.ok) {
              const payload = await response.json()
              if (!cancelled) setStatus(payload)
            }
          } catch (_offline) {
            if (!cancelled) setStatus(null)
          }
          if (!cancelled) timer = window.setTimeout(load, 3000)
        }
        load()
        return () => {
          cancelled = true
          if (timer !== undefined) window.clearTimeout(timer)
        }
      }, [])
      return status
    }

    /** One labelled boolean row. */
    function BooleanRow({ label, hint, checked, disabled, onChange }) {
      return h('label', { className: 'bpw-row' },
        h('span', { className: 'bpw-rowText' },
          h('span', { className: 'bpw-rowLabel' }, label),
          hint === undefined ? null : h('span', { className: 'bpw-rowHint' }, hint)),
        h('input', {
          className: 'bpw-switch',
          type: 'checkbox',
          checked: checked === true,
          disabled,
          onChange: (event) => onChange(event.target.checked),
        }))
    }

    /** One labelled text/number row; commits on blur or Enter. */
    function InputRow({ label, hint, placeholder, kind, value, disabled, onCommit }) {
      const [draft, setDraft] = React.useState(value === undefined || value === null ? '' : String(value))
      React.useEffect(() => {
        setDraft(value === undefined || value === null ? '' : String(value))
      }, [value])
      const commit = () => {
        if (kind === 'number') {
          const parsed = Number(draft)
          if (!Number.isFinite(parsed) || parsed < 0) {
            setDraft(value === undefined ? '' : String(value))
            return
          }
          if (parsed === Number(value)) return
          onCommit(parsed)
          return
        }
        const next = draft.trim()
        if (next === String(value ?? '')) return
        onCommit(next)
      }
      return h('label', { className: 'bpw-row' },
        h('span', { className: 'bpw-rowText' },
          h('span', { className: 'bpw-rowLabel' }, label),
          hint === undefined ? null : h('span', { className: 'bpw-rowHint' }, hint)),
        h('input', {
          className: 'bpw-input',
          type: kind === 'number' ? 'number' : 'text',
          min: kind === 'number' ? 0 : undefined,
          step: kind === 'number' ? 1 : undefined,
          placeholder,
          value: draft,
          disabled,
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            event.currentTarget.blur()
          },
        }))
    }

    /** The delivery-channel panel plus the test button. */
    function ChannelPanel({ t, navigationAvailable }) {
      const status = useChannelStatus()
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState('')
      const clients = typeof status?.clients === 'number' ? status.clients : 0
      const granted = Array.isArray(status?.clientIds) && status.clientIds.some((id) => typeof id === 'string' && id.endsWith(':granted'))
      const connected = clients > 0 && granted
      const sendTest = async () => {
        setBusy(true)
        setResult('')
        try {
          const response = await fetch(`${API}/test`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ body: t('settings.testBody') }),
          })
          const payload = await response.json()
          setResult(payload?.delivered === 'client' ? t('settings.testClient') : t('settings.testFallback'))
        } catch (_offline) {
          setResult(t('settings.testFailed'))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'bpw-panel' },
        h('span', { className: 'bpw-panelTitle' }, t('settings.channel')),
        h('span', { className: 'bpw-status' }, connected ? t('settings.channelClient') : t('settings.channelFallback')),
        h('span', { className: 'bpw-counts' }, t('settings.channelCounts', {
          pushed: String(status?.pushed ?? 0),
          fallback: String(status?.fallback ?? 0),
        })),
        h('span', { className: 'bpw-panelTitle' }, t('settings.navigation')),
        h('span', { className: 'bpw-status' }, navigationAvailable ? t('settings.navigationOk') : t('settings.navigationMissing')),
        h('div', { className: 'bpw-actions' },
          h('button', { className: 'bpw-button', type: 'button', disabled: busy, onClick: sendTest },
            busy ? t('settings.testing') : t('settings.test')),
          result.length === 0 ? null : h('span', { className: 'bpw-result' }, result)))
    }

    /** The full settings form for one config form controller. */
    function SettingsForm({ t, form, navigationAvailable }) {
      const snapshot = useForm(form)
      const [saving, setSaving] = React.useState(0)
      const writable = snapshot?.writable !== false
      const value = snapshot?.value ?? {}
      const set = (field, next) => {
        setSaving((count) => count + 1)
        Promise.resolve(form.set(field, next))
          .catch(() => {})
          .finally(() => setSaving((count) => count - 1))
      }
      if (snapshot?.status === 'loading') {
        return h('p', { className: 'bpw-hint' }, t('settings.loading'))
      }
      const groups = FIELD_GROUPS.map((group) => h('div', { key: group.title },
        h('h4', { className: 'bpw-groupTitle' }, t(group.title)),
        group.fields.map((field) => {
          const label = t(`settings.field.${field.key}`)
          const hint = field.hint === undefined ? undefined : t(field.hint)
          if (field.kind === 'boolean') {
            return h(BooleanRow, {
              key: field.key,
              label,
              hint,
              checked: value[field.key] === true,
              disabled: !writable,
              onChange: (next) => set(field.key, next),
            })
          }
          return h(InputRow, {
            key: field.key,
            label,
            hint,
            kind: field.kind,
            placeholder: field.placeholder,
            value: value[field.key],
            disabled: !writable,
            onCommit: (next) => set(field.key, next),
          })
        })))
      return h('div', { className: 'bpw-root' },
        groups,
        writable ? null : h('p', { className: 'bpw-hint' }, t('settings.readonly')),
        saving > 0 ? h('p', { className: 'bpw-hint' }, t('settings.saving')) : null,
        h(ChannelPanel, { t, navigationAvailable }))
    }

    /**
     * The top-level Settings section (`settings.section`): title, intro and the
     * form for the plugin row's config document.
     */
    function SettingsSection(props) {
      const { t, form, navigationAvailable } = props
      return h('div', { className: 'bpw-page' },
        h('h2', { className: 'bpw-title' }, t('settings.title')),
        h('p', { className: 'bpw-intro' }, t('settings.intro')),
        form === undefined || form === null
          ? h('p', { className: 'bpw-hint' }, t('settings.unavailable'))
          : h(SettingsForm, { t, form, navigationAvailable }))
    }

    /**
     * The plugin row's own config page in the Plugins page
     * (`plugins.row.config`), rendered with `{ view, form }`.
     */
    function RowConfigPage(props) {
      const { t, view, form, navigationAvailable } = props
      if (view === 'summary') return h('span', null, t('settings.summary'))
      if (form === undefined || form === null) return null
      return h(SettingsForm, { t, form, navigationAvailable })
    }

    /* ---------------------------------------------------------------- */
    /* Notifier                                                         */
    /* ---------------------------------------------------------------- */

    /**
     * Mount the notifier and the settings surface.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'better-push: dictionaries')

      const clientId = makeClientId()
      /** Host policy, refreshed on every poll. */
      let config = { enabled: true, notifyInForeground: true, sound: true, preview: true }
      /** Last notification id handed to us; -1 means "start from the host cursor". */
      let cursor = -1
      let disposed = false
      let timer = 0
      /** notification id → { notification, key, sessionId } while on screen. */
      const live = new Map()
      /** Session navigation services, captured when their plugins are composed. */
      let workspace
      let sessions
      const diag = { workspace: false, permission: 'unknown', lastClick: undefined }
      /** Most recent item, exposed through the debug hook for support. */
      let lastItem

      ctx.inject(['uiWorkspace'], (sub) => {
        workspace = sub.uiWorkspace
        sub.effect(() => () => {
          workspace = undefined
        }, 'better-push: workspace navigation')
      })
      ctx.inject(['sessions'], (sub) => {
        sessions = sub.sessions
        sub.effect(() => () => {
          sessions = undefined
        }, 'better-push: session catalog')
      })

      // ---- Settings surface ------------------------------------------
      ctx.inject(['slots', 'configForms'], (sub) => {
        try {
          sub.effect(() => {
            const tag = document.createElement('style')
            tag.dataset.plugin = '@ceasarxuu/dsh-better-push'
            tag.dataset.pluginCss = '@ceasarxuu/dsh-better-push/settings.css'
            tag.textContent = CSS
            document.head.appendChild(tag)
            return () => { tag.remove() }
          }, 'better-push: settings stylesheet')
        } catch (error) {
          console.warn('[better-push] stylesheet failed', error)
        }
        const formOf = () => {
          try {
            return sub.configForms.get(ROW_ID)
          } catch (_unavailable) {
            return undefined
          }
        }
        const injected = () => ({ form: formOf(), navigationAvailable: workspace !== undefined })
        try {
          // Top-level Settings section: Settings → 通知.
          sub.effect(() => sub.slots.inject('settings.section', () => sub.slots.register({
            name: 'settings.section',
            id: 'better-push-notifications',
            order: 25,
            label: () => t('settings.nav'),
            locale: NS,
            inject: injected,
          }, SettingsSection)), 'better-push: settings section')
        } catch (error) {
          console.warn('[better-push] settings section registration failed', error)
        }
        try {
          // The same form inside the plugin's own row page in Settings → Plugins.
          sub.effect(() => sub.slots.inject('plugins.row.config', () => sub.slots.register({
            name: 'plugins.row.config',
            key: `@ceasarxuu/dsh-better-push#${ROW_ID}`,
            locale: NS,
            inject: injected,
          }, RowConfigPage)), 'better-push: row settings page')
        } catch (error) {
          console.warn('[better-push] row config registration failed', error)
        }
      })

      // ---- Diagnostics ------------------------------------------------
      /** Report navigation/click state to the host so `/state` can show it. */
      function reportDiag() {
        diag.workspace = workspace !== undefined
        diag.permission = permissionOf()
        try {
          fetch(`${API}/diag`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
              workspace: diag.workspace,
              permission: diag.permission,
              lastClick: diag.lastClick ?? null,
            }),
          }).catch(() => {})
        } catch (_offline) {
          /* diagnostics are best effort */
        }
      }

      // ---- Banner lifecycle -------------------------------------------
      /** Close every banner this plugin owns. */
      function closeAll() {
        for (const entry of live.values()) {
          try {
            entry.notification.close()
          } catch (_alreadyClosed) {
            /* closed by the OS */
          }
        }
        live.clear()
      }

      /** Close the previous banner for the same session + kind (no stacking). */
      function replacePrevious(item) {
        const key = `${item.sessionId ?? 'app'}:${item.kind}`
        for (const [id, entry] of [...live]) {
          if (entry.key !== key) continue
          try {
            entry.notification.close()
          } catch (_alreadyClosed) {
            /* closed by the OS */
          }
          live.delete(id)
        }
        return key
      }

      /**
       * Focus the window and open the Session that raised the notification.
       * `openSessionId` is the root conversation (a child Session cannot be
       * opened in the workspace), with the raw id as a second attempt.
       * @returns whether a Session was opened.
       */
      function activate(item) {
        try {
          if (typeof window !== 'undefined' && typeof window.focus === 'function') window.focus()
        } catch (_unavailable) {
          /* focus is best effort */
        }
        const candidates = []
        if (typeof item.openSessionId === 'string' && item.openSessionId.length > 0) candidates.push(item.openSessionId)
        if (typeof item.sessionId === 'string' && item.sessionId.length > 0 && !candidates.includes(item.sessionId)) candidates.push(item.sessionId)
        if (candidates.length === 0) {
          diag.lastClick = { sessionId: undefined, ok: true, error: undefined, at: Date.now() }
          reportDiag()
          return true
        }

        // A click must not lose its target to a race: make sure the catalog
        // knows the Session before retaining it (the host may have just created
        // it). `retain` loads history, so an unknown id would throw.
        const known = (target) => {
          try {
            return sessions?.list?.getSnapshot?.()?.byId?.[target] !== undefined
          } catch (_unavailable) {
            return true
          }
        }
        const ordered = candidates.filter(known)
        if (ordered.length === 0) ordered.push(...candidates)

        let lastError
        for (const target of ordered) {
          if (workspace === undefined || typeof workspace.openSession !== 'function') {
            lastError = 'uiWorkspace service unavailable'
            break
          }
          try {
            workspace.openSession(target)
            diag.lastClick = { sessionId: target, ok: true, error: undefined, at: Date.now() }
            reportDiag()
            return true
          } catch (error) {
            lastError = String(error?.message ?? error)
          }
        }
        diag.lastClick = { sessionId: ordered[0], ok: false, error: lastError, at: Date.now() }
        reportDiag()
        console.warn('[better-push] could not open session', ordered[0], lastError)
        return false
      }

      /** Compose the banner title: event label plus the Session label. */
      function titleFor(item) {
        const base = t(`title.${item.kind}`)
        return typeof item.sessionTitle === 'string' && item.sessionTitle.length > 0
          ? `${base} · ${item.sessionTitle}`
          : base
      }

      /** Compose the banner body from the kind-specific detail fields. */
      function bodyFor(item) {
        switch (item.kind) {
          case 'turn-end': {
            const parts = []
            if (typeof item.preview === 'string' && item.preview.length > 0) parts.push(item.preview)
            const duration = formatDuration(item.durationMs ?? NaN)
            if (duration.length > 0) parts.push(t('duration', { duration }))
            return parts.length > 0 ? parts.join(' · ') : t('body.turn-end')
          }
          case 'turn-error':
          case 'turn-aborted':
            return typeof item.detail === 'string' && item.detail.length > 0 ? item.detail : t('body.error')
          case 'approval':
            return typeof item.detail === 'string' && item.detail.length > 0 ? item.detail : t('body.approval')
          case 'question':
            return typeof item.detail === 'string' && item.detail.length > 0 ? item.detail : t('body.question')
          case 'job':
            return [item.detail, item.status].filter((part) => typeof part === 'string' && part.length > 0).join(' · ') || t('body.job')
          case 'subagent':
            return [item.detail, item.status].filter((part) => typeof part === 'string' && part.length > 0).join(' · ') || t('body.subagent')
          case 'workflow':
            return [item.detail, item.status].filter((part) => typeof part === 'string' && part.length > 0).join(' · ') || t('body.workflow')
          case 'test':
            return typeof item.detail === 'string' && item.detail.length > 0 ? item.detail : t('body.test')
          default:
            return typeof item.detail === 'string' ? item.detail : ''
        }
      }

      /** Show one banner, honoring the background-only policy and permission. */
      function show(item) {
        if (config.enabled === false) return
        // An explicit test is expected right now, even with foreground
        // notifications switched off.
        if (item.kind !== 'test' && config.notifyInForeground === false && windowIsFocused()) return
        if (permissionOf() !== 'granted') return
        const key = replacePrevious(item)
        try {
          const notification = new Notification(titleFor(item), {
            body: bodyFor(item),
            tag: `dsh:${item.sessionId ?? 'app'}`,
            silent: config.sound === false,
          })
          const entry = { notification, key, sessionId: item.sessionId }
          live.set(item.id, entry)
          notification.onclick = () => {
            activate(item)
            try {
              notification.close()
            } catch (_alreadyClosed) {
              /* closed by the OS */
            }
            live.delete(item.id)
          }
          notification.onclose = () => live.delete(item.id)
          notification.onerror = () => live.delete(item.id)
        } catch (error) {
          // macOS can refuse (permission, Focus mode); never break the UI over it.
          console.warn('[better-push] notification failed', error)
        }
      }

      /** Close a banner the host reports as resolved (approval answered). */
      function dismiss(item) {
        const entry = live.get(item.dismissId)
        if (entry === undefined) return
        try {
          entry.notification.close()
        } catch (_alreadyClosed) {
          /* closed by the OS */
        }
        live.delete(item.dismissId)
      }

      /** Handle one item from the host: a banner or a dismiss instruction. */
      function handleItem(item) {
        if (item === null || typeof item !== 'object') return
        lastItem = item
        if (item.kind === 'dismiss') {
          dismiss(item)
          return
        }
        show(item)
      }

      /** One poll; reschedules itself until the plugin unloads. */
      async function poll() {
        if (disposed) return
        const controller = new AbortController()
        const abort = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        let delay = POLL_MS
        try {
          const query = new URLSearchParams({
            client: clientId,
            since: String(cursor),
            permission: permissionOf(),
            ws: workspace === undefined ? '0' : '1',
          })
          const response = await fetch(`${API}/poll?${query.toString()}`, {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          })
          if (response.ok) {
            const payload = await response.json()
            if (payload !== null && typeof payload === 'object' && !disposed) {
              if (payload.config !== null && typeof payload.config === 'object') config = { ...config, ...payload.config }
              if (typeof payload.cursor === 'number') cursor = payload.cursor
              if (Array.isArray(payload.items)) for (const item of payload.items) handleItem(item)
            }
          } else {
            delay = POLL_ERROR_MS
          }
        } catch (_offline) {
          // The host may be restarting (profile hot reload); retry slowly.
          delay = POLL_ERROR_MS
        } finally {
          clearTimeout(abort)
        }
        if (disposed) return
        timer = window.setTimeout(() => { poll() }, delay)
      }

      // Debug handle: useful in DevTools and for support reports.
      try {
        window.__dshBetterPush = {
          get workspaceAvailable() { return workspace !== undefined },
          get config() { return { ...config } },
          get cursor() { return cursor },
          get lastItem() { return lastItem },
          get diag() { return { ...diag } },
          listSessions() {
            try {
              return sessions?.list?.getSnapshot?.()?.ids ?? []
            } catch (_unavailable) {
              return []
            }
          },
          openSession(target) {
            return activate({ sessionId: target })
          },
          openLast() {
            return lastItem === undefined ? false : activate(lastItem)
          },
        }
      } catch (_unavailable) {
        /* no window object */
      }

      ctx.effect(() => {
        disposed = false
        // Electron grants renderer notifications through the shell's permission
        // handler, so this resolves immediately there; in a plain browser the
        // user sees the normal prompt once.
        if (permissionOf() === 'default') {
          try {
            const result = Notification.requestPermission()
            if (result !== null && typeof result.then === 'function') result.catch(() => {})
          } catch (_unavailable) {
            /* no prompt available */
          }
        }
        const startup = window.setTimeout(() => { reportDiag() }, 2500)
        timer = window.setTimeout(() => { poll() }, 300)
        return () => {
          disposed = true
          window.clearTimeout(startup)
          clearTimeout(timer)
          closeAll()
        }
      }, 'better-push: notifier loop')
    }

    return { inject: ['locale'], apply }
  },
})
