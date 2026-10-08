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

# Development workflow

Default: **focused change → targeted check → one PR → automatic merge → cloud deployment only when needed**. Full validation is for an explicitly requested major/formal release, not everyday fixes. A workflow-only task stops after changing the workflow; do not expand it into live acceptance, UI integration or deployment activation.

## Daily work

1. Read this file and the files relevant to the task. Check the working tree and canonical origin `git@github.com:SaraiNoQ/web-knowledge-set.git`; fetch main. Start a new `codex/<topic>` branch from latest main, or continue the same unmerged task. Never overwrite another task's changes.
2. Make the smallest complete change. Small fixes need only a PR problem/acceptance note; do not add feature-ledger entries, release notes, version bumps or tags by habit. Update user/security documentation only when behavior requires it. Large features/releases may use a specification and acceptance ledger.
3. Run the minimum checks below. Reuse passing evidence for unchanged code/toolchain. A failure requires its related checks again, not the entire repository.
4. Get one focused independent review for the PR. Reuse it while the reviewed code is unchanged; do not require a new review for every commit, CI update or merge operation.
5. Make a focused Conventional Commit, push and open/update one PR. Do not split a small task into procedural milestones, commits or evidence-only PRs. Attach the PR to the chat.
6. When applicable checks pass and review findings are resolved, automatically merge with `gh pr merge <number> --merge --match-head-commit <reviewed-head>`. This and cloud-related automatic deployment have standing user authorization; do not ask again. Never push directly to main, force-push shared history or use `--admin`.
7. Report the PR, checks and actual deployment result briefly. Do not claim unperformed checks. Deploy results normally live in Actions summaries/artifacts; Git release-evidence updates are for formal releases or significant incidents, not every small fix.

## Minimum verification

| Change | Required checks |
| --- | --- |
| Documentation/rules/workflows | `git diff --check`; mirrored instructions, affected syntax/policy checks. No application dependency install/build or product suites. |
| Small CSS/layout/text/icon fix | One relevant existing browser regression or a focused visual/manual check. Build only assets needed to exercise it. No unrelated types/unit/cloud/native/AMO suites. |
| Small UI logic/TypeScript fix | Affected TypeScript project and one relevant regression. No full browser suite or macOS merely because UI is shared. |
| Service/cloud/extension/native fix | Affected module/API/platform checks and necessary build/dry-run only. |
| Auth/migration/backup/restore/deletion | Focused security, compatibility and data-preservation checks plus review. Do not replace these with a visual check; do not automatically add unrelated suites. |
| Explicit major/formal release | Full CI: frozen install, types, unit/integration/E2E, dependency/security/notice checks and applicable cloud/extension/native/package acceptance. |

CI selects checks from changed paths. `validation:release`, a release tag, or an explicit `full_validation=true` selects full release validation. Known workflow/native-only changes do not republish Worker assets. Unknown paths stay conservative. Do not promote an everyday fix to a full release just because files are large, tests are available, or main was merged.

## Environment

- Local workspace: editing, Git and synchronization only. Do not install dependencies, build, run servers/apps or dependency-backed tests locally.
- Developer checks run on `root@123.207.203.208` with `/Users/sarainoq/Documents/settings/key1.pem`; use an isolated `/root/dev/zhiye-<task>` mirror. GitHub ephemeral Linux/macOS CI is the platform exception. Mirrors are not Git worktrees.
- Use locked Node `24.19.0`, pnpm `11.7.0`; use the project Rust toolchain only for native work. Reuse dependencies/caches when the lockfile is unchanged.
- Sync with `scripts/sync-to-campus.sh <user@host> <isolated-directory>`; exclude Git metadata, credentials, dependencies, artifacts and local data. Never sync over another task's active mirror.
- Server browser tests use `bash scripts/run-server-e2e.sh <spec> [-g <test>]`. The pre-created root:zhiye-ci 0660 `/run/lock/zhiye-e2e.lock` prevents fixed-port conflicts; never replace a live lock.

## PR and safety rules

- PRs state the problem, acceptance and targeted check/result. Add migration, release or recovery details only when relevant. Resolve conflicts with latest main and rerun only affected checks. Preserve original commits with merge commits.
- `ci-required` always returns a result and only accepts explicitly planned skips. PR jobs are read-only and receive no production secrets; never execute PR code through `pull_request_target`. Pin external Actions to commit SHAs.
- main protection applies to administrators: PRs, up-to-date `ci-required`, resolved conversations, no forced pushes/deletion. Do not require a second account approval in this single-maintainer repository.
- Never commit secrets, signed binaries, generated dependencies, real libraries or backups. Keep AGENTS.md and CLAUDE.md identical when instructions change.

## Production delivery

- Deploy only an exact main SHA with successful push CI, using the dedicated non-root account and production Environment. Check current main, the previous successful source and actual Worker versions; stop on drift or an unmerged production baseline.
- Routine deploys reuse CI, build required assets and run publishing safety guards. Do not repeat full tests or packaging checks. Source transfer is compressed; deployment is serialized on GitHub and the server.
- Use the tracked production `cloud/wrangler.web.jsonc` / `cloud/wrangler.clip.jsonc` for `zhiye-web` / `zhiye-clip`; example configs are dry-run only. Preserve existing Access domains and applicable DB/BACKUPS/IMAGES/CAPTURE_QUEUE/BROWSER bindings; never recreate resources as a normal deployment.
- Published migrations are immutable. Compatible additions may deploy automatically after focused old-data checks; manual/destructive/uncertain migrations require explicit protected approval for that SHA. A persistent unreleased schema risk blocks automatic rollback, even on retry.
- Build before staging the exact AMO-signed XPI recorded in `extension/amo/signed-release.json`. Missing/hash/version/content mismatch blocks publication. Never publish an unsigned ZIP renamed to XPI; do not rebuild after staging without staging again.
- Publish both Workers and verify bindings and stable Access/extension boundaries. A partial failure is not success; restore the previous pair only when schema/resources remain compatible. Never blindly retry failed migrations/bindings or roll back production data.
- Keep credentials out of logs/source and remove private release requests on exit. Record source SHA, Worker IDs, migration/recovery state and smoke results. Boundary checks do not prove authenticated read/write, real clipping or downloads; report those separately.

## Explicit releases and references

- macOS and AMO publishing are separate explicit release tasks. A routine UI fix neither bumps versions nor creates release tags or signed packages.
- Stable desktop tags must match current main and aligned package/Cargo/Tauri/Info.plist versions. Reuse the exact tag's full CI; publish verified DMG/checksums only on macOS evidence. Ad-hoc signing is not Developer ID signing or Apple notarization.
- Firefox/Chrome release versions must match; AMO ID stays `clipper@zhiye.sarainoq.cn`. Signed artifacts stay outside Git and cleaned build directories. AMO credentials/signing are only needed for an actual extension release.
- Read detailed runbooks only when needed: `docs/DEVELOPMENT_WORKFLOW.md`, `docs/CLOUDFLARE.md`, `docs/FIREFOX_AMO.md`, and the relevant release notes. Do not reread all release/history documents for a small fix.
