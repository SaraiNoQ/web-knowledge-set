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
| `.github/` | macOS smoke and release workflows. |
| `package.json` / `pnpm-lock.yaml` | Locked Node commands and dependencies. |
| `vite.config.ts` / `tsconfig*.json` | Frontend build and TypeScript project configuration. |
| `AGENTS.md` / `CLAUDE.md` | Project map and mandatory contributor workflow; keep both mirrored in sync for Codex and Claude Code. |

# Documentation workflow

- Before implementing a product feature, add it as an unchecked item to the most relevant document in `docs/`; use `docs/FEATURES.md` when no narrower specification exists.
- Record a short acceptance boundary with the item. After implementation, server gates, and independent review all pass, change it to a checked and struck-through item (`- [x] ~~...~~`).
- Update affected user, privacy, security, support, or format documents in the same milestone. Do not leave completed behavior documented only in the feature ledger.

# Development environment

- Keep the local workspace for source editing and synchronization only.
- Do not download or install project dependencies in the local workspace.
- Do not compile, run development servers, package the application, or execute dependency-backed tests locally.
- Synchronize the source to `/root/dev/zhiye` on `ssh -i /Users/sarainoq/Documents/settings/key1.pem root@123.207.203.208` before installing dependencies, compiling, testing, packaging, or running the application.
- Perform all dependency installation, build, test, packaging, and development-server work on that server. Cloudflare deployments are an exception: run their authenticated deploy command only after the cloud configuration is complete.
- Keep Git metadata, generated dependencies, build artifacts, and local data out of source synchronization (`.git`, `node_modules`, `dist`, `dist-server`, `target`, Playwright browser caches, test reports, and local data). The server directory is a build mirror, not a second Git worktree.

# Version control and milestone gates

- The canonical Git remote is `git@github.com:SaraiNoQ/web-knowledge-set.git`; verify `origin` before the first push and never rewrite shared history.
- Treat every milestone in `docs/DEVELOPMENT_PLAN.md` as a review and commit boundary. Keep unrelated work out of the milestone diff.
- Whenever an independently verifiable stage or feature slice is complete, run its applicable gates and review, then create an immediate focused Conventional Commit; do not accumulate multiple completed slices into one large final commit, and never commit incomplete or unverified code.
- Before committing a milestone, synchronize its source to `root@123.207.203.208:/root/dev/zhiye` using `key1.pem` and run every gate required by that milestone there. At minimum, run type checks, unit/integration tests, the production build, and relevant end-to-end or packaging checks.
- After the server gates pass, ask an independent agent to review the complete uncommitted diff for correctness, security, data-loss risk, migrations, tests, and unnecessary complexity. The implementation agent must resolve actionable findings and repeat affected server gates before committing.
- Commit only a reviewed, passing milestone, using a focused Conventional Commit message. Confirm the committed diff and clean working tree before starting the next milestone; push the milestone commit to the configured GitHub remote when credentials and branch policy allow.
- Do not claim a platform release from Linux-only evidence. Platform-neutral and Linux checks run on `123.207.203.208`; signed and notarized macOS release artifacts must additionally be built and verified on an approved macOS CI runner with Apple credentials.

# Firefox extension packaging

- The Firefox and Chrome extension versions are sourced from `extension/manifest.firefox.json` and `extension/manifest.chrome.json`; keep them equal for a release. The current Firefox package is `0.3.5`, with fixed AMO ID `clipper@zhiye.sarainoq.cn`.
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

# Cloudflare production deployment

- Production Worker configs are `cloud/wrangler.web.jsonc` (`zhiye-web`) and `cloud/wrangler.clip.jsonc` (`zhiye-clip`). The `.example.jsonc` files have placeholder IDs and no production routes; use them only for dry-run checks. Never substitute a production config with an example config.
- Current production domains are `zhiye.sarainoq.cn` (web) and `clip.sarainoq.cn` (clipper), protected by Cloudflare Access. The configured resources are D1 `zhiye-cloud`, R2 `zhiye-cloud-backups` and `zhiye-cloud-images`, Queue `zhiye-cloud-capture`, and a Browser Run binding.
- A production deploy is an external state change and requires explicit user authorization for that deployment. Earlier approval of design choices, bucket names, or login access is not deployment authorization.
- Before deploying, sync the reviewed commit to `/root/dev/zhiye`, then run the fixed server toolchain gates:

      cd /root/dev/zhiye
      npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js install --frozen-lockfile
      npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js check
      npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js test
      npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js build
      npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js cloud:check
      npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js cloud:bundle

  Run relevant Playwright/extension tests for the changed path. If the change adds D1 migrations, review them separately and apply each migration once to the remote `zhiye-cloud` database with the matching production Wrangler config (for example, `npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js exec wrangler d1 migrations apply zhiye-cloud --remote --config cloud/wrangler.web.jsonc`) before exposing code that requires the new schema; never edit production D1 manually or skip a failed migration.
- After gates pass and the user confirms deployment, deploy both Workers so the web and clipper bindings stay compatible:

      npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js exec wrangler deploy --config cloud/wrangler.web.jsonc
      npx -y node@24.19.0 /usr/lib/node_modules/corepack/dist/pnpm.js exec wrangler deploy --config cloud/wrangler.clip.jsonc

  Keep `DB`, `BACKUPS`, `IMAGES`, `CAPTURE_QUEUE`, and `BROWSER` bindings aligned with the reviewed config. Do not recreate existing R2 buckets or queues during a normal deploy. Afterward, verify the Access-protected production URL, authenticated web read/write, extension pairing/clip, image asset delivery, and a stable Worker response; unauthenticated requests should remain at the expected Access redirect/denial boundary. Record the deployed commit SHA and any migration/deployment IDs in the relevant release or Cloudflare evidence document.
- Never claim Cloudflare production status from a dry-run, local build, or a deploy of only one Worker. If deployment fails, leave the existing production version running and report the exact stable error; do not retry blindly after a schema or binding failure.

# GitHub development and release flow

- Verify `origin` is `git@github.com:SaraiNoQ/web-knowledge-set.git`. Start feature work from the latest `main` on a focused `codex/<topic>` branch unless the user explicitly requests another branch; never rewrite shared history or force-push `main`.
- Before code changes, read this file and `CLAUDE.md`, register product work as an unchecked acceptance item in `docs/FEATURES.md` (or the narrower relevant document), and keep one milestone focused. Do not mix unrelated fixes, generated files, local data, or credentials into the milestone.
- Before a commit, synchronize the source to the server and run the applicable type checks, unit/integration tests, production build, cloud checks, extension/Playwright tests, and packaging checks. Then ask an independent agent to review the complete uncommitted diff for correctness, security, data loss, migrations, tests, and unnecessary complexity; resolve findings and rerun affected gates.
- Use a focused Conventional Commit (`feat(...)`, `fix(...)`, `docs(...)`, `chore(...)`), confirm `git diff --check`, the staged file list, and a clean tracked worktree, then push the commit. After implementation, gates, and review pass, mark its feature-ledger item checked and struck through and update affected user/security/support/release evidence docs.
- For a desktop release, keep Node/Cargo/Tauri/Info.plist/workflow versions aligned, commit and push `main` first, then create the exact `vX.Y.Z` tag. The macOS workflow must verify that the tag points at the `main` tip, build and sign on the macOS runner, publish the DMG and `SHA256SUMS`, and only then may the release be called published. Linux/server evidence alone never proves a macOS artifact.
- For a Firefox release, keep the manifest version, AMO source package, signed XPI, release notes, and any store metadata aligned. Record the exact package version, source commit, lint result, signing channel, and distribution URL without recording credentials.
