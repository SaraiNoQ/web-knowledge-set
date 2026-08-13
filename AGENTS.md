# Project map

| Path | Purpose |
| --- | --- |
| `src/` | React/Vite interface, editor, preview, and product workflows. |
| `server/` | Local Node service, REST API, SQLite access, capture, import/export, backup, diagnostics, and LLM calls. |
| `shared/` | Types shared by the browser interface and local service. |
| `extension/` | Shared Chrome/Firefox clipper popup, active-tab extractor, manifests, and styles. |
| `src-tauri/` | Thin Tauri desktop shell, capabilities, sidecar lifecycle, macOS integration, and icons. |
| `tests/` | Node unit/integration tests and fixed fixtures. |
| `e2e/` | Playwright user-flow and local-session tests. |
| `scripts/` | Source sync, release validation, packaging, notices, smoke checks, and benchmarks. |
| `docs/` | User, architecture, security, support, format, release, and feature-ledger documentation. |
| `licenses/` | Reviewed license-text overrides used by notice generation. |
| `.github/` | macOS smoke and release workflows. |
| `package.json` / `pnpm-lock.yaml` | Locked Node commands and dependencies. |
| `vite.config.ts` / `tsconfig*.json` | Frontend build and TypeScript project configuration. |
| `AGENTS.md` | Project map and mandatory contributor workflow; keep it as the only root Markdown document. |

# Documentation workflow

- Before implementing a product feature, add it as an unchecked item to the most relevant document in `docs/`; use `docs/FEATURES.md` when no narrower specification exists.
- Record a short acceptance boundary with the item. After implementation, campus-server gates, and independent review all pass, change it to a checked and struck-through item (`- [x] ~~...~~`).
- Update affected user, privacy, security, support, or format documents in the same milestone. Do not leave completed behavior documented only in the feature ledger.

# Development environment

- Keep the local workspace for source editing and synchronization only.
- Do not download or install project dependencies in the local workspace.
- Do not compile, run development servers, package the application, or execute dependency-backed tests locally.
- Synchronize the source to the corresponding project directory on `ssh root@campus-server` before installing dependencies, compiling, testing, packaging, or running the application.
- Perform all dependency installation, build, test, packaging, and development-server work on `root@campus-server`.
- Keep Git metadata, generated dependencies, build artifacts, and local data out of source synchronization (`.git`, `node_modules`, `dist`, `dist-server`, `target`, Playwright browser caches, test reports, and local data). The server directory is a build mirror, not a second Git worktree.

# Version control and milestone gates

- The canonical Git remote is `git@github.com:SaraiNoQ/web-knowledge-set.git`; verify `origin` before the first push and never rewrite shared history.
- Treat every milestone in `docs/DEVELOPMENT_PLAN.md` as a review and commit boundary. Keep unrelated work out of the milestone diff.
- Before committing a milestone, synchronize its source to `root@campus-server:/root/dev/zhiye` and run every gate required by that milestone there. At minimum, run type checks, unit/integration tests, the production build, and relevant end-to-end or packaging checks.
- After the server gates pass, ask an independent agent to review the complete uncommitted diff for correctness, security, data-loss risk, migrations, tests, and unnecessary complexity. The implementation agent must resolve actionable findings and repeat affected server gates before committing.
- Commit only a reviewed, passing milestone, using a focused Conventional Commit message. Confirm the committed diff and clean working tree before starting the next milestone; push the milestone commit to the configured GitHub remote when credentials and branch policy allow.
- Do not claim a platform release from Linux-only evidence. Platform-neutral and Linux checks stay on `campus-server`; signed and notarized macOS release artifacts must additionally be built and verified on an approved macOS CI runner with Apple credentials.
