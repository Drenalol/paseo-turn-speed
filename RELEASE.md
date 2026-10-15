# Release process

How to ship a new version of this plugin and keep the three listings in sync.

## Listings

| Where | Source of truth | How it updates |
| --- | --- | --- |
| GitHub | `main` + version tags | push |
| npm [`paseo-turn-speed`](https://www.npmjs.com/package/paseo-turn-speed) | `npm publish` | manual |
| Official [paseo.sh/plugins](https://paseo.sh/plugins) | npm artifact ([submission #475](https://github.com/getpaseo/plugins/issues/475), merged via PR #476) | bot opens a bump PR on each npm release; a reviewer merges |
| Community [paseo.cafe](https://paseo.cafe) | `registry/turn-speed.json` ([submission #380](https://github.com/paseo-cafe/paseo-cafe/issues/380), merged via PR #381) | scans refresh ~every 6 h; no action needed |

Local development stays on the directory source (`paseo plugin install "$(pwd)"`);
public installs use `npm:paseo-turn-speed`.

## Cutting a release

1. Bump `version` in `package.json` (semver; the npm version is the update
   identity both registries track).
2. `npm run verify` (typecheck + unit tests + client-bundle check).
3. `git commit` then `git tag vX.Y.Z`.
4. `git push origin main --follow-tags` — tags are lightweight, so also run
   `git push origin vX.Y.Z` (`--follow-tags` only pushes annotated tags).
5. Publish (see npm gotchas below): `npm publish`.
6. Wait for the staged publish to finish: `npm view paseo-turn-speed@latest version`
   returns `0.0.0-stage` for a couple of minutes, then the new version.
7. Smoke-test both install sources and remove the temporary instances:
   ```bash
   paseo plugin add npm:paseo-turn-speed --id turn-speed-smoke   # expect: running
   paseo plugin remove turn-speed-smoke
   paseo plugin add github:Drenalol/paseo-turn-speed --id turn-speed-smoke-git
   paseo plugin remove turn-speed-smoke-git
   ```

## npm gotchas (learned the hard way)

- **Publishing requires 2FA.** The account uses a passkey. The passkey CLI flow
  only exists in npm 11+; the npm first in `PATH` (`~/.local/bin/npm`, hermes
  bundle) is 10.9.8 and fails with `EOTP`. Use `/usr/local/bin/npm publish`.
- The publish command prints `https://www.npmjs.com/auth/cli/<id>` and waits for
  the browser passkey confirmation. The CLI session expires in minutes — open
  the link promptly. Without a TTY, wrap it in a PTY (`expect`) so the
  "Press ENTER to open in the browser..." prompt gets answered.
- `npm login --auth-type=web` behaves the same way: the browser step must finish
  while the CLI is still polling, otherwise it falls back to a `Username:`
  prompt and dies in non-interactive shells.

## Manifest restrictions from the paseo.cafe scanner

The cafe security scanner
([scripts/plugin-security/static-scan.ts](https://github.com/paseo-cafe/paseo-cafe/blob/main/scripts/plugin-security/static-scan.ts))
only allows these top-level `paseo-plugin.json` keys: `id`, `description`,
`requirements`, `build`. Anything else is a blocking finding.

Paseo 0.11.2 itself supports `name`, `icon` and `media` (see
`PluginManifestSchema` in `@getpaseo/server`), but they are kept out of the
manifest so the cafe scanner stays green. `assets/icon.png` is ready for the
day the scanner allow-list catches up.

Other registry-validation rules that bit us:

- The cafe `npm package` form field is copied verbatim — submit the exact
  unscoped name `paseo-turn-speed` (a scoped guess 404s and fails validation).
- `OVERVIEW.md` must not contain the strings `paseo plugin add`,
  `npm install`, `npm i` (registry docs belong in the README).
- The README keeps an `## Install` section and a `## Known limitations`
  section — cafe detects those headings and pulls them into the listing — plus
  an `images/` folder for screenshots.

## History

- 2026-10-15 — v1.0.0 published; approved and merged in the official registry
  (PR getpaseo/plugins#476) the same day.
- v1.0.1 — manifest trimmed to the scanner allow-list; cafe admission passed
  after re-submission (paseo-cafe#380/#381 merged).
