# Releasing

The plugin is distributed from this repository (no npm package). A release is
three artifacts that must agree on one version:

| Artifact | What it is | Where |
|---|---|---|
| git tag `v<version>` | the source at the release version | GitHub tags |
| packed tarball | `npm pack` output, exactly what a plugin install unpacks | GitHub release asset |
| `market/index.json` | DSH plugin-market index entry pinned to the release commit | `main` branch (raw URL) |

## Checklist

```sh
# 0. Working tree clean; tests and syntax green
node --test test/*.test.mjs
node --check index.js && node --check client.js

# 1. Version: every release bumps it (the tarball and market entry carry it)
npm version patch --no-git-tag-version      # or minor / major

# 2. Pack from the tag commit, not from the docs-edited worktree
git add -A && git commit -m "release: v<version>"
git tag -a "v<version>" -m "v<version> — <summary>"
git push && git push origin "v<version>"

git worktree add -q /tmp/pkg-release "v<version>"
(cd /tmp/pkg-release && pnpm pack)
git worktree remove /tmp/pkg-release

# 3. Attach the tarball to the release (create the release first if needed)
gh release create "v<version>" --title "v<version> — <summary>" --notes "<notes>"
gh release upload "v<version>" "/tmp/pkg-release/ceasarxuu-dsh-better-push-<version>.tgz" --clobber

# 4. Re-point the market index at the release commit and refresh the timestamp
#    (the index lives on main, so it always names a commit that already exists)
COMMIT=$(git rev-parse "v<version>^{commit}")
python3 - "$COMMIT" <<'PY'
import json, sys, time
commit = sys.argv[1]
path = 'market/index.json'
data = json.load(open(path))
data['plugins'][0]['versions'][0]['source']['commit'] = commit
data['plugins'][0]['versions'][0]['publishTimestamp'] = int(time.time())
json.dump(data, open(path, 'w'), indent=2, ensure_ascii=False)
open(path, 'a').write('\n')
PY
```

Then commit and push the `market/` change:

```sh
git add market/index.json && git commit -m "market: point at v<version>" && git push
```

## Verify before announcing

```sh
# 1. The index parses with the DSH validator and yields the expected install spec
cd /tmp && mkdir -p market-check && cd market-check
pnpm add @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.3
node --input-type=module -e '
import { readFileSync } from "node:fs"
import { parseMarketIndex, marketInstallTarget } from "@deepseek-ai/dsh-plugin-market-index"
const raw = JSON.parse(readFileSync("<repo>/market/index.json", "utf8"))
const parsed = parseMarketIndex(raw, "https://raw.githubusercontent.com/ceasarXuu/dsh-better-push/main/market/index.json")
console.log(marketInstallTarget(parsed.plugins[0].name, parsed.plugins[0].versions[0]))
'

# 2. That spec really installs (this is exactly what Install runs)
mkdir -p /tmp/spec-check && cd /tmp/spec-check && printf '{"name":"spec-check","private":true}\n' > package.json
pnpm add "git+https://github.com/ceasarXuu/dsh-better-push.git#<commit>"
ls node_modules/@ceasarxuu/dsh-better-push   # cordis.patch.yml + client.js must be there

# 3. The tarball installs too
pnpm add "/tmp/pkg-release/ceasarxuu-dsh-better-push-<version>.tgz"

# 4. In a real app: Settings → Plugins → Add → the market index URL, install from
#    the list, restart, then `curl -s http://127.0.0.1:61670/plugin/better-push/state`.
```

## Compatibility policy

`engines.dsh` is `>=0.2.1-rc.3 <0.3.0`. Widen it only after installing and
running on the older version; narrow it when a DSH API change breaks the
session-event vocabulary, the client bundle contract (`__ModuleLoader__`,
`dsh.client`), `configForms`, or `uiWorkspace.openSession`.

## Rollback

Delete the bad release asset and publish a new patch version; the market index
is versioned content, so reverting `market/index.json` to the previous commit
also rolls back what Discover offers.

## npm

Not used today. If the package is later published, keep the market entry's
`source` as `{"type": "git", ...}` or switch it to
`{"type": "npm"}` and point the README at `dsh plugin add @ceasarxuu/dsh-better-push`.
