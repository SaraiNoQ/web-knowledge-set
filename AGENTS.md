# Development environment

- Keep the local workspace for source editing and synchronization only.
- Do not download or install project dependencies in the local workspace.
- Do not compile, run development servers, package the application, or execute dependency-backed tests locally.
- Synchronize the source to the corresponding project directory on `ssh root@campus-server` before installing dependencies, compiling, testing, packaging, or running the application.
- Perform all dependency installation, build, test, packaging, and development-server work on `root@campus-server`.
- Keep Git metadata, generated dependencies, build artifacts, and local data out of source synchronization (`.git`, `node_modules`, `dist`, `dist-server`, `target`, Playwright browser caches, test reports, and local data). The server directory is a build mirror, not a second Git worktree.

# Version control and milestone gates

- The canonical Git remote is `git@github.com:SaraiNoQ/web-knowledge-set.git`; verify `origin` before the first push and never rewrite shared history.
- Treat every milestone in `DEVELOPMENT_PLAN.md` as a review and commit boundary. Keep unrelated work out of the milestone diff.
- Before committing a milestone, synchronize its source to `root@campus-server:/root/dev/zhiye` and run every gate required by that milestone there. At minimum, run type checks, unit/integration tests, the production build, and relevant end-to-end or packaging checks.
- After the server gates pass, ask an independent agent to review the complete uncommitted diff for correctness, security, data-loss risk, migrations, tests, and unnecessary complexity. The implementation agent must resolve actionable findings and repeat affected server gates before committing.
- Commit only a reviewed, passing milestone, using a focused Conventional Commit message. Confirm the committed diff and clean working tree before starting the next milestone; push the milestone commit to the configured GitHub remote when credentials and branch policy allow.
- Do not claim a platform release from Linux-only evidence. Platform-neutral and Linux checks stay on `campus-server`; signed and notarized macOS release artifacts must additionally be built and verified on an approved macOS CI runner with Apple credentials.
