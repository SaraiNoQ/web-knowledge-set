# Project map

| Path | Purpose |
| --- | --- |
| `src/` | React/Vite interface, editor, preview, and product workflows. |
| `server/` | Local Node service, REST API, SQLite access, capture, import/export, backup, diagnostics, and LLM calls. |
| `shared/` | Types shared by the browser interface and local service. |
| `extension/` | Shared Chrome/Firefox clipper popup, active-tab extractor, manifests, and styles. |
| `cloud/` | Cloudflare Worker, D1 migrations, and cloud deployment configuration. |
| `src-tauri/` | Thin Tauri desktop shell, capabilities, sidecar lifecycle, macOS integration, and icons. |
| `tests/` | Node unit/integration tests and fixed fixtures. |
| `e2e/` | Playwright user-flow and local-session tests. |
| `scripts/` | Source sync, release validation, packaging, notices, smoke checks, and benchmarks. |
| `docs/` | User, architecture, security, support, format, release, and feature-ledger documentation. |
| `licenses/` | Reviewed license-text overrides used by notice generation. |
| `.github/` | PR CI, production deployment, templates, and macOS release workflows. |
| `package.json` / `pnpm-lock.yaml` | Locked Node commands and dependencies. |
| `vite.config.ts` / `tsconfig*.json` | Frontend build and TypeScript project configuration. |
| `AGENTS.md` / `CLAUDE.md` | Project map and mandatory contributor workflow; keep both mirrored in sync for Codex and Claude Code. |

# Mandatory delivery workflow

Default sequence: update main → feature branch → acceptance item → implement → server gates → independent review → commit and PR → GitHub checks → merge → main checks → production deployment → evidence.

## Authorization and boundaries

- The canonical origin is `git@github.com:SaraiNoQ/web-knowledge-set.git`. Verify it before pushing. Never rewrite shared history, force-push a shared branch, push directly to main, or bypass protection with administrator privileges.
- Within the requested feature, agents are authorized to create/push branches, open/update PRs, merge a reviewed passing PR, and deploy cloud-related changes merged into main. This is standing authorization for compatible releases; destructive migrations, data deletion, resource replacement, desktop releases and AMO signing require explicit task authorization.
- One independently acceptable feature slice uses one short-lived `codex/<topic>` branch and one PR. Keep unrelated changes out. A PR can contain multiple focused, reviewed and passing milestone commits; do not accumulate completed stages into one final commit.
- Local workspaces are for editing, Git and synchronization only. Never install dependencies, compile, run applications or dependency-backed tests locally. Development gates run on `root@123.207.203.208` using `/Users/sarainoq/Documents/settings/key1.pem`. GitHub-hosted ephemeral Linux/macOS CI is an explicit exception. Native macOS artifacts require macOS runner evidence.

## 1. Start and register

- Read both contributor files. Inspect `git status`, origin, remote main and any PR for the task. Fetch main before choosing a baseline. Never discard, stash, commit or move another task's changes without authorization; use a separate worktree when needed.
- New features branch from latest `origin/main`; continue the existing branch only for the same unmerged feature. Never reuse an already merged feature branch for a new task.
- Before implementation, add an unchecked acceptance item to the narrowest relevant document (otherwise `docs/FEATURES.md`). State scope, acceptance and migration impact. Keep affected user/privacy/security/support/format documents current.

## 2. Implement, verify and independently review

- Use a server source mirror isolated by task/run, below `/root/dev/`; production automation uses its own non-root account and directories. Never synchronize into a mirror another task is using. Mirrors are not Git worktrees.
- Use `scripts/sync-to-campus.sh <user@host> <absolute-isolated-directory>` with the task's SSH configuration. Exclude `.git`, credentials, dependencies, generated artifacts, browser caches, reports and local data. Never use synchronization to copy production credentials or real libraries.
- Toolchain: Node `24.19.0`, pnpm `11.7.0`, Rust from `rust-toolchain.toml`; frozen lockfile installation. Do not substitute the server's global Node/pnpm versions.
- Before every milestone commit, run `check`, complete `test`, `build`, `cloud:check`, `cloud:bundle`, `notices:check`, `firefox:amo`, `node scripts/check-delivery.mjs`, and `node --test tests/delivery-policy.test.mjs` on the server. Run relevant Playwright scenarios; before PR merge run the full browser suite in CI. Serialize all server browser tests with the common `/tmp/zhiye-e2e.lock` because fixture ports are fixed.
- For Rust/Tauri/runtime changes also run formatting, Clippy with warnings denied, tests and platform build/smoke. For migrations, backups, restore, imports and deletion, verify populated old data and failure preservation. Never waive a failed test because a single-test rerun passed; repair or obtain a complete passing applicable run.
- After gates pass, ask an agent that did not implement the change to review the complete uncommitted diff for correctness, security, data loss, migration compatibility, tests and unnecessary complexity. Resolve findings and rerun affected gates. No self-review substitute.
- Mark the acceptance item `- [x] ~~...~~` only after implementation, gates and independent review pass. Deployment/real-service acceptance remains unchecked until actually verified. Review the final documentation changes too.

## 3. Commit and open/update PR

- Run `git diff --check`, inspect the staged file list and staged diff, then make an immediate focused Conventional Commit (`feat`, `fix`, `docs`, `chore`, `ci`, or `test`). Never commit unverified/incomplete code, artifacts, secrets or unrelated edits.
- Push the feature branch, then create a PR using `gh pr create --base main --head <branch> --title <title> --body-file <file>`. Reuse an existing PR for the feature. Attach every created/continued PR to the current chat with the app's PR attachment tool.
- Fill the PR template with acceptance boundaries, exact server gate results, independent reviewer findings/resolution, reviewed SHA, migrations, deployment impact and recovery limits. Keep this evidence accurate after updates. Agent review is not approval by another GitHub identity.

## 4. Merge and follow through

- Wait for `ci-required` and every applicable check to succeed; resolve review conversations. If main advances, merge latest main into the feature branch, resolve conflicts, repeat affected server gates and independent review, and wait for fresh CI.
- Before merging, independently review the entire PR difference and final head SHA. Any later code change invalidates that approval and requires fresh review/checks.
- Use `gh pr merge <number> --merge --match-head-commit <reviewed-head-sha>`. Do not use `--admin`, squash or rebase merging. Verify GitHub reports the PR merged and its original commits are ancestors of main.
- Follow main CI and the deployment run through completion. Delete the merged branch only after confirming merge; do not switch a dirty workspace or remove a worktree still used by another task.
- Report PR URL, merged SHA, checks, deployment and unverified acceptance separately. A commit/push/PR merge, a dry-run, a partial Worker release or Access redirects alone never proves full production acceptance.

# GitHub Actions and protection

- `CI` handles PRs targeting main, main pushes and manual checks using read-only permissions and ephemeral runners. No production secrets in PR jobs; never execute PR code using `pull_request_target`.
- Pin external Actions to full commit SHAs. Validate workflow syntax, mirrored contributor files, locked toolchain and append-only migration history. Store failing test/trace evidence with a bounded retention period.
- `ci-required` must always run and fail if required upstream jobs fail, are cancelled or unexpectedly skipped. Do not apply top-level path filters to this required workflow. Conditional macOS checks must agree with the change detector.
- Protect main: PRs, `ci-required` from GitHub Actions, strict up-to-date checks, resolved conversations, no forced pushes/deletions and administrator enforcement. Do not demand a second account approval in this single-maintainer repository. Enable merge commits and automatic deletion of merged branches.

# Firefox extension packaging

- The Firefox and Chrome extension versions are sourced from `extension/manifest.firefox.json` and `extension/manifest.chrome.json`; keep them equal for a release. The current Firefox source package is `0.3.9`, with fixed AMO ID `clipper@zhiye.sarainoq.cn`; signed releases are recorded in `docs/FIREFOX_AMO.md`.
- Build and validate from the server mirror, not the local source workspace:

      cd /root/dev/zhiye
      pnpm install --frozen-lockfile
      pnpm firefox:amo

  `pnpm firefox:amo` creates and validates `dist/extensions/zhiye-clipper-firefox.zip` and `dist/extensions/zhiye-clipper-firefox-source.zip`; it also runs the pinned `web-ext 10.6.0` lint gate. Do not commit `dist/`.
- For a self-distributed AMO-signed package, sign the compiled directory (not the source ZIP) as unlisted. Prefer interactive variables so credentials do not enter shell history or logs:

      read -r -p "AMO API key: " AMO_API_KEY
      read -r -s -p "AMO API secret: " AMO_API_SECRET; printf '\n'
      npm exec --yes --package=web-ext@10.6.0 -- web-ext sign \
        --source-dir=dist/extensions/zhiye-clipper-firefox \
        --artifacts-dir=dist/extensions/amo-signed \
        --channel=unlisted \
        --api-key="$AMO_API_KEY" \
        --api-secret="$AMO_API_SECRET"
      unset AMO_API_KEY AMO_API_SECRET

  The signed `.xpi` is written below `dist/extensions/amo-signed/`. Never put AMO API keys, API secrets, pairing codes, Access credentials, or signed artifacts in Git. If a secret is pasted into chat, a commit, or a command log, revoke and rotate it before continuing. `docs/FIREFOX_AMO.md` is the source of truth for AMO metadata and review requirements.
- To serve a signed Firefox download online, record the SHA-256 of the XPI returned by a successful AMO unlisted signing run, then after the final server `build` and `firefox:amo` gates run `node scripts/stage-firefox-xpi.mjs /path/to/AMO-signed.xpi <recorded-sha256>`; it checks that exact digest, the current manifest, signature entries, and built extension contents before copying to `dist/extensions/zhiye-clipper-firefox.xpi`. Rebuild only if you stage the XPI again before `cloud:bundle` and deployment. Never publish an unsigned ZIP renamed as `.xpi`.

# Cloudflare production delivery

- Only successful CI for a push to this repository's main can initiate automatic production delivery. Check out the CI run's exact SHA, never a moving branch or a PR artifact. Manual bootstrap/retry must identify an exact main SHA with successful push CI.
- Production uses `cloud/wrangler.web.jsonc` (`zhiye-web`) and `cloud/wrangler.clip.jsonc` (`zhiye-clip`). Example configs are dry-run only. Preserve existing domains, Access policies and DB/BACKUPS/IMAGES/CAPTURE_QUEUE/BROWSER bindings; never recreate resources during normal deployment.
- Deploy on the designated server under a dedicated non-root SSH account, isolated SHA/run/attempt directory, pinned host key and production-only credentials. Serialize production operations in GitHub and with a server lock; never cancel an in-progress release to make room for another.
- Compare against the last successfully deployed SHA, not merely the previous Git commit. Skip documentation-only cumulative changes; unknown paths require release preparation. Recheck main immediately before production writes; stale runs stop.
- Repeat the full server release gates and browser checks. Final build and `firefox:amo` must precede signed-XPI staging; verify its recorded SHA-256 and current build contents with `scripts/stage-firefox-xpi.mjs`. Missing/mismatched signed XPI blocks publication. Do not rebuild after staging without staging again.
- Existing published migrations are immutable. New migrations declare `-- deployment: compatible` or `-- deployment: manual` and undergo independent review. Compatible changes require populated-old-schema and old/new-reader compatibility evidence; destructive or uncertain changes pause for explicit approval of that exact SHA. Never bypass a failed migration or manually change production D1.
- Save the previous pair of Worker versions before mutation. Apply approved pending migrations once, publish both Workers with their production configs and verify applicable bindings. Two deployments are not atomic: a partial release must be reported and recorded.
- Restore the previous pair only when resource/schema compatibility is confirmed; otherwise stop for recovery. Worker rollback does not undo D1/R2 data or resource changes. Never retry a schema/binding failure blindly.
- Check stable responses, Web Access redirects/denial and extension origin/token rejection after publication. Record authenticated read/write, actual pairing/clip and image/XPI delivery separately; unperformed business checks remain unverified.
- Save SHA, run, migrations, old/new Worker versions and smoke results as deployment evidence. Documentation evidence returns through a separate PR, never a deployment job's direct push to main. Documentation-only evidence must not trigger another production release.
- Before initial activation, confirm main contains current production changes, configure production environment/secrets and complete an exact-SHA manual bootstrap. Until then say “automatic deployment is not enabled”. See `docs/DEVELOPMENT_WORKFLOW.md` for setup and current evidence.

# Platform releases

- macOS and AMO releases are separate explicit tasks, not side effects of a Web merge. For a desktop release align package/Cargo/Tauri/Info.plist versions, merge through PR first, and tag the exact verified main tip `vX.Y.Z`.
- Desktop workflows derive version and bundle version from reviewed source, validate the tag/main/source and packaged app identity, publish DMG plus SHA256SUMS only after macOS checks, and verify downloaded release assets. Existing ad-hoc signing is not Developer ID signing or Apple notarization; never claim either without its actual evidence.
- Keep Firefox/Chrome manifest versions, AMO source, signed XPI, release notes and metadata aligned. Record version, source SHA, lint, signing channel and distribution URL without credentials. Signed packages remain outside Git and build-cleaned directories.
