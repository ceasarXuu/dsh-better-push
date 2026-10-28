# Development

Host-side changes need an app restart, and restarting the desktop app kills the
agent Session that is doing the work. So host work is verified two ways
instead: unit tests, and a throwaway `dsh web` instance driven by Chrome
DevTools Protocol.

## 1. Unit tests

```sh
node --test test/*.test.mjs
npm run check          # node --check for both halves
```

`test/host.test.mjs` covers event classification, dedupe, quiet hours, config
switches, the jobs `awaited` rule, the poll protocol and the fallback decision.
Notifications never reach `osascript` in tests: `createState(config, { deliver })`
injects a recorder.

## 2. A throwaway web instance

```sh
# once: make the package resolvable from the web profile
ln -s "$PWD" ~/.dsh/profiles/web/node_modules/@ceasarxuu/dsh-better-push

# boot a separate host on port 6280 with dev/patch.yml as an overlay
dsh web --patch ./dev/patch.yml --port 6280 --no-open
```

`dev/patch.yml` inserts the plugin row with foreground notifications and the
subagent category switched on and the sound off, so a foreground browser still
exercises the banner path. The
command prints a tokenized URL (`http://127.0.0.1:6280/?token=…`).

Check the host half:

```sh
curl -s http://127.0.0.1:6280/plugin/better-push/state | jq
```

## 3. Verify the browser half (CDP)

> Caveat: a `--patch` launcher overlay is applied *after* the profile layer, so
> its `config:` shadows anything the settings page writes to the profile patch.
> To verify that a switch actually persists and takes effect, put the row in the
> `web` profile's own `cordis.patch.yml` instead of the overlay.

For the settings surface (the **Notifications** section, its 15 switches and
the test button) and click-to-open-session:

```sh
node dev/verify-settings.mjs "http://127.0.0.1:6280/?token=<token>" 9333
```

Headless Chrome cannot display banners, so the verifier replaces
`window.Notification` before any app script runs and records every construction:
that proves the client bundle loaded, polled, received, and localized the item.

```sh
# a Chrome with a debugging port
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9333 \
  --user-data-dir=/tmp/dsh-cdp-profile about:blank &

node dev/verify-client.mjs "http://127.0.0.1:6280/?token=<token>" 9333
```

A passing run shows `clients: 1`, `delivered: "client"`, and spy entries like:

```json
{ "title": "测试通知 · DeepSeek Harness", "body": "cdp client probe", "tag": "dsh:app", "silent": false }
```

The second test replaces the first (the `closed` array lists the tag), which is
the same replace-not-stack behavior a real session gets.

## 4. Verify the real desktop app

Client bundles hot-swap in a running GUI, host code does not. To see the native
path end to end, the plugin has to be in the profile and the app restarted:

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-better-push
# restart DeepSeek Harness, then:
curl -s -X POST http://127.0.0.1:61670/plugin/better-push/test \
  -H 'content-type: application/json' -d '{"body":"probe"}'
```

macOS delivery is provable from the unified log — look for the app bundle and
our tag in the notification request:

```sh
log show --last 2m --style compact --predicate 'process == "usernoted"' \
  | grep com.deepseek.dsh | grep -E "Presenting|Delivered|Presenting as banner"
# … <NotificationRecord app:"com.deepseek.dsh" … req:"n#dsh-app://app#dsh:app" …> as banner
```

For a temporary live install without a restart, append the row to
`~/.dsh/profiles/desktop/cordis.patch.yml` and symlink the package into the
profile's `node_modules`; the profile patch layer reloads live. Remove the row
to unload it.
