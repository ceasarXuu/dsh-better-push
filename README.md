# dsh-better-push

**Native macOS notifications for DeepSeek Harness.** When you step away from the
window and the agent finishes a turn, asks for an approval, asks you a question,
hits an error, or a background job / subagent / workflow settles, macOS tells
you — with the **DeepSeek Harness** app name and icon. Click the banner and the
window comes forward on the Session that fired it.

```
┌───────────────────────────────────────────────┐
│ 🔔 DeepSeek Harness                           │
│ 回合完成 · dsh-better-push                     │
│ Fixed the parser; tests pass. · 耗时 2m14s     │
└───────────────────────────────────────────────┘
```

> Third-party plugin. Not an official DeepSeek / DeepSeek Harness component.

## What it notifies

| Trigger | What you see | Default |
|---|---|---|
| Turn finished | Session name, a one-line reply preview, elapsed time | on |
| Tool call waiting for approval | Session name + tool name; banner closes itself once you decide | on |
| Agent asking a question | Session name + the question | on |
| Turn failed / interrupted / out of context | The provider or turn error | on |
| Background job settled | Job label + status (`run_in_background` commands, promoted commands) | on |
| Subagent turn finished | Parent conversation name + preset; click opens the parent Session | off |
| Workflow run finished | Workflow name + stop reason | on |
| Test notification | Pushed from the settings page or `POST /plugin/better-push/test` | — |

Foreground Bash calls are **not** notified even though they are jobs
internally: the plugin reads the job feed's `awaited` flag, so only work you
actually left running in the background pings you.

## Install

Requires **DeepSeek Harness 0.2.1-rc.3 or newer (below 0.3.0)** on **macOS**,
with the desktop or web surface.

This repository is the distribution for now — the plugin is **not published to
npm yet**. Both install paths below take the package straight from GitHub.

- **Plugin Manager:** Settings → Plugins → Add → paste
  `https://github.com/ceasarXuu/dsh-better-push` (the manager also accepts
  `github:ceasarXuu/dsh-better-push`), then keep it enabled.
- **CLI:** quit the app first (the profile is locked while it runs), then:

  ```sh
  dsh plugin --profile desktop add github:ceasarXuu/dsh-better-push
  ```

  From a local checkout, `dsh plugin --profile desktop add /absolute/path/to/dsh-better-push`
  links the directory instead.

Restart the app once. Settings live in the profile's `cordis.patch.yml` under
row id `better-push`.

### macOS permission

The first banner makes macOS ask whether **DeepSeek Harness** may send
notifications. If you misclicked, re-enable it in **System Settings →
Notifications → DeepSeek Harness**. Focus modes still win: while a Focus is on,
banners are delivered silently to Notification Center.

## Settings

Everything is editable in **Settings → 通知 / Notifications** (its own section
in the settings sidebar, next to General and Plugins; the same form also appears
in Settings → Plugins → the plugin's row) and stored in the profile patch. Every
switch is independent, and changes apply immediately: the settings page writes
the profile patch, the loader commits `volatile` fields into the running plugin,
and the browser half picks the new policy up on its next poll.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for all system notifications. |
| `notifyInForeground` | `true` | Also notify while the DSH window is focused. Turn off to only notify from the background. |
| `sound` | `true` | Play a sound with each notification. |
| `turnEnd` | `true` | Notify when a turn finishes. |
| `approvals` | `true` | Notify when a tool call waits for approval. |
| `questions` | `true` | Notify when the agent asks you a question. |
| `errors` | `true` | Notify on failed, interrupted or out-of-context turns. |
| `jobs` | `true` | Notify when a background job settles. |
| `subagents` | `false` | Notify when a subagent / Agent Teams teammate turn finishes. Off by default: a busy team would otherwise ping on every child turn. |
| `workflows` | `true` | Notify when a workflow run finishes. |
| `preview` | `true` | Put a short assistant-reply preview in the finished-turn body. |
| `minTurnSeconds` | `0` | Skip finished-turn notifications shorter than this (0 = notify every turn). |
| `quietHours` | `""` | `HH:MM-HH:MM` local quiet window; overnight ranges allowed. |
| `fallbackWhenNoClient` | `true` | Use `osascript` when no app window is attached (window closed). |
| `fallbackSoundName` | `Glass` | Sound used by the `osascript` fallback. |

## How it works

Two halves, one package:

- **Host half (`index.js`)** watches `session/event` for every live Session
  (`turn/end`, `approval/asked`, `approval/decided`, `tool-workflow/*`,
  `session/title`), the `user-questions/request` waterfall (observed, never
  answered), and the `jobs` feed. It classifies, dedupes, applies quiet hours,
  and serves a tiny HTTP surface under `/plugin/better-push`:
  `GET /poll` (notifications since a cursor — also the presence heartbeat),
  `GET /state` (diagnostics), `GET /health`, `POST /test`.
- **Browser half (`client.js`)** polls that route once a second and turns items
  into renderer `Notification`s. On the desktop that means a **UNUserNotification**
  banner attributed to *DeepSeek Harness*, the app icon, macOS's own click
  activation, and `uiWorkspace.openSession(sessionId)` so the click lands on the
  right Session. It also closes the approval banner when the approval resolves.

Delivery is renderer-first. When no window is attached (you closed it while a
job ran), the host falls back to `osascript display notification` so you still
hear about it — at the cost of Script Editor attribution and a click that cannot
open DSH. Turn `fallbackWhenNoClient` off if you would rather miss it.

Why a poll and not a socket: the desktop renderer runs on `dsh-app://app` and
the Electron shell forwards same-origin fetches to the host; one request a
second on loopback is free, and it doubles as the presence signal that decides
between the two delivery paths.

## Diagnostics

```sh
# what the plugin sees right now
curl -s http://127.0.0.1:61670/plugin/better-push/state | jq
# { "clients": 1, "clientIds": ["web-…:granted"], "cursor": 3, "fallback": 0, … }

# show a banner through the normal channel
curl -s -X POST http://127.0.0.1:61670/plugin/better-push/test \
  -H 'content-type: application/json' -d '{"body":"hello"}'
```

`clients: 0` means the window is closed and delivery is on the fallback path.
`clientIds` ending in `denied` means the renderer cannot notify and the host is
already falling back for it.

## Development

```sh
pnpm install          # @deepseek-ai/schemastery only
node --test test/*.test.mjs
```

Client bundles hot-swap in a running GUI (~500 ms, no restart); host code needs
an app restart. To test host changes without touching your profile, boot a
separate web instance and drive it with the bundled CDP verifier — see
[`dev/README.md`](dev/README.md).

## Limits

- macOS only for now; the renderer half would work on Windows/Linux but the
  fallback and the copy are macOS-specific and untested there.
- The renderer path cannot choose a custom sound (Web Notifications expose
  `silent` only), cannot set a subtitle, and cannot show action buttons.
- No dock badge, no notification history screen, no per-session mute yet.
- Click-to-focus is best-effort: macOS activates the app on banner click,
  `window.focus()` cannot raise a minimized window by itself.
- osascript fallback banners are attributed to Script Editor and clicking one
  opens Script Editor — a macOS limitation of the legacy `display notification`
  path, not a plugin bug.

## License

MIT. See [LICENSE](LICENSE).
