# SST Fork Workflow

Maple runs against a local fork of `anomalyco/sst` so we can add features to the SST platform (the TypeScript component library under `platform/src/components/`) before they land upstream, and open PRs back to upstream from the same branches.

The SST CLI is a Go binary shipped as a prebuilt in the `sst` npm package. At runtime it extracts the platform source into `.sst/platform/` and runs it via Pulumi. We don't rebuild the Go binary — we just swap out the extracted platform source with a symlink to our fork. That means any edit in the fork is live in maple on the next `bun sst …` invocation, with no rebuild step.

## Layout

- Fork: `~/Documents/GitHub/sst` (remotes: `origin` = `Makisuo/sst`, `upstream` = `anomalyco/sst`)
- Maple: `~/Documents/GitHub/maple`
- Symlink: `maple/.sst/platform/src` -> `sst/platform/src`

`.sst/` is gitignored in maple, so the symlink never shows up in `git status`.

## Branches

- `dev` — tracks `upstream/dev`. Do not commit local patches here; this is the baseline you branch off for upstream PRs.
- `local-4.7.3` — local testing branch, based on the `v4.7.3` tag with our local-only patches cherry-picked on top. This is the branch you have checked out when running maple so the SST CLI sees the exact baseline it expects, plus our patches.
- `feat/*` — one branch per upstream PR, branched from `dev`.

When `v4.7.3` == `upstream/dev` (as it was at setup time), `dev` and `local-4.7.3` have the same content modulo the local patches. They diverge once upstream cuts a new release.

## Day-to-day: testing a change

Assume you're already on `local-4.7.3` in the fork.

```bash
# 1. Edit the component in the fork
cd ~/Documents/GitHub/sst
$EDITOR platform/src/components/cloudflare/worker.ts

# 2. Test in maple — no rebuild, the symlink reflects the edit immediately
cd ~/Documents/GitHub/maple
bun sst diff --stage <scratch-stage>
```

If the code compiles and Pulumi plans the expected resources, you're good. If the change touches a cross-cutting type, `bunx tsc --noEmit` from `~/Documents/GitHub/sst/platform` runs the platform's own typecheck in isolation.

## Syncing `dev` with upstream

Do this whenever you want the latest `anomalyco/sst:dev`, typically before starting a new feature branch.

```bash
cd ~/Documents/GitHub/sst
git fetch upstream
git checkout dev
git merge --ff-only upstream/dev   # fast-forward only — dev should have no local commits
git push origin dev                 # keep Makisuo/sst:dev in sync with upstream
```

If `git merge --ff-only` fails, someone (probably past-you) committed directly to `dev`. Move those commits to a feature branch with `git branch -f feat/whatever dev && git reset --hard upstream/dev`, then retry.

## Rebasing `local-4.7.3` onto a newer release

When upstream cuts a new release (say `v4.7.4`) and you've bumped maple's `sst` dep to match:

```bash
cd ~/Documents/GitHub/sst
git fetch upstream --tags
git checkout local-4.7.3
git rebase v4.7.4                   # replays local patches onto the new tag
git branch -m local-4.7.3 local-4.7.4
```

Then bump maple: `bun update sst` in `~/Documents/GitHub/maple`, and **re-create the symlink** (SST wipes `.sst/platform/` on version mismatch — see Recovery below).

## Adding a new feature + opening an upstream PR

```bash
cd ~/Documents/GitHub/sst

# 1. Start from fresh upstream dev
git fetch upstream
git checkout dev
git merge --ff-only upstream/dev

# 2. Branch for the feature
git checkout -b feat/<short-name>

# 3. Edit platform/src/... and test live in maple
cd ~/Documents/GitHub/maple
bun sst diff --stage <scratch-stage>
# iterate until the component does what you want

# 4. Commit in the fork
cd ~/Documents/GitHub/sst
git add platform/src/components/<area>/<file>.ts
git commit -m "Short imperative description"

# 5. Push the branch to Makisuo/sst and open the PR against upstream
git push -u origin feat/<short-name>
gh pr create \
  --repo anomalyco/sst \
  --base dev \
  --head Makisuo:feat/<short-name> \
  --title "Short imperative description" \
  --body-file .github/pr-body.md   # or inline with --body
```

### Also land the patch on `local-4.7.3` so maple keeps seeing it

Until upstream merges, the feature only exists on `feat/<short-name>`. To run maple against it via the symlink, cherry-pick onto the local testing branch:

```bash
cd ~/Documents/GitHub/sst
git checkout local-4.7.3
git cherry-pick feat/<short-name>
```

After upstream merges and you rebase `local-4.7.3` onto the next release tag, drop the cherry-picked commit — it's already included via upstream.

### Style notes for upstream PRs

From reading merged PRs on `anomalyco/sst`:

- Titles are imperative and prose-style, no `feat:` / `fix:` prefix. "Add X", "Support X", "Fix X". Backticks around code identifiers are fine.
- Commit messages match the PR title; squash-merges on the upstream side rewrite them anyway.
- PR bodies are conversational — what the change does, why it's needed, any API-design decisions, and a short test plan. Don't pad with boilerplate.
- Reference PR #6744 as a recent example of the expected length and voice.

## Recovery: symlink was wiped

SST wipes `.sst/platform/` and re-extracts from the Go binary when its internal version file doesn't match the installed CLI version. This happens on:

- `bun update sst` (new CLI version)
- `bun install` after a lockfile change that bumps `sst`
- Some `sst install` operations

When it happens, `.sst/platform/src` is a real directory again instead of a symlink, and your fork edits stop showing up in maple. To restore:

```bash
cd ~/Documents/GitHub/maple
rm -rf .sst/platform/src
ln -s /Users/makisuo/Documents/GitHub/sst/platform/src .sst/platform/src
```

After re-linking, check out the right branch in the fork for the new SST version (`local-<version>`), and confirm the symlink sees your patch:

```bash
grep -c "<some unique string from your patch>" .sst/platform/src/components/<area>/<file>.ts
```

## Drift between the fork and the installed CLI

The Go CLI expects the platform source to match the version it was built from. In practice, the platform is mostly component TypeScript that Pulumi executes at runtime, so small edits are safe. Things that can break if you run a fork branch far ahead of the installed CLI:

- A new component file that references a Go RPC method the CLI doesn't know about
- A new provider dep added to `platform/package.json` that isn't in the installed `.sst/platform/node_modules`
- Changes to the `dist/` layout (generated artifacts) — we don't symlink `dist/`, but component code that references a new `dist/` helper will fail

The `local-<version>` branch exists to avoid this: it pins local patches to the exact baseline the installed CLI expects. Only rebase it forward when you bump `sst` in maple.
