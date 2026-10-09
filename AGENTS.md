# Project map

- `src/`: React/Vite UI and product workflows; `server/`: local Node service and SQLite.
- `shared/`: browser/service types; `extension/`: Chrome and Firefox clipper.
- `cloud/`: Cloudflare Workers, D1 migrations and deployment config; `src-tauri/`: desktop shell.
- `tests/`, `e2e/`: unit/integration and Playwright checks; `scripts/`: build, release and validation tools.
- `docs/`: product and engineering docs; `licenses/`: reviewed license overrides; `.github/`: CI and release workflows.
- Keep `AGENTS.md` and `CLAUDE.md` identical.

# Development workflow

Default: smallest complete change → one focused check → one PR when required by branch protection. Do not add specs, release notes, feature-ledger entries, or version changes to routine fixes.

1. Check `git status` and read only the files needed for the request. Continue the active task branch; start a branch from current `main` only for a new task or a conflict. Do not overwrite other work.
2. Make only the requested change. Use existing dependencies and helpers. Do not install or sync a new environment for docs or a trivial edit.
3. Run the smallest relevant check once. Keep passing results while the checked code and toolchain are unchanged; do not rerun suites for commits, PR updates, or reviews that did not change that code.
4. Request independent review for security, auth, data migration/recovery/deletion, or complex cross-layer changes. Routine copy, docs, and small reversible fixes need no extra review. Do not repeat review on unchanged code.
5. Use one PR when required. Wait once for required CI, fix actual blockers, then merge under branch protection. Never force-push or use admin bypass.
6. Report the change, the check actually run, and any remaining limitation. Do not claim unrun checks.

## Checks

| Change | Minimum check |
| --- | --- |
| Docs/rules | `git diff --check`; no app tests or build. |
| Visible UI | One relevant browser regression or focused visual check. Use a browser by default when relevant; honor an explicit request not to use one. Skip browser startup for docs, backend, or non-visual work. |
| Small UI logic | Affected TypeScript project and one relevant regression. |
| Service, cloud, extension, native | One affected module check and the build/dry-run needed to exercise it. |
| Auth, migrations, backup/restore, destructive data changes | Focused compatibility and data-preservation checks. |
| Major/formal release | Full CI only when the user explicitly requests it. |

Reuse CI for unchanged code. Do not broaden a targeted check because more tests exist or a change was merged. CI path selection remains authoritative; an intentional skip must be explicit.

## Environment and release tools

- Run local checks when the required dependencies are already available. If not, rely on relevant CI; use the developer server only when a needed build or release cannot run locally. Reuse the locked Node `24.19.0` / pnpm `11.7.0` environment and existing caches.
- Developer server access: `ssh -i /Users/sarainoq/Documents/settings/key1.pem root@123.207.203.208`. Run checks in a fresh `/root/dev/zhiye-<task>` mirror; sync with `bash scripts/sync-to-campus.sh <user@host> <isolated-directory>` (for example, `root@123.207.203.208 /root/dev/zhiye-<task>`). Exclude Git metadata, credentials, dependencies, build artifacts, and local data; never reuse another active task's mirror. Production publishing uses `zhiye-ci`, not root.
- Browser E2E: `bash scripts/run-server-e2e.sh <spec> [-g <test>]` uses the shared `/run/lock/zhiye-e2e.lock` on Linux; the script never replaces that lock. On macOS it runs Playwright directly after checking the requested browser. If the browser is absent, rely on PR CI or the Linux developer server; the script exits before launching and never downloads a browser for one edit.
- For an AMO unlisted Firefox XPI, run `bash scripts/sign-firefox-unlisted.sh` from the repository root. It prompts for the AMO credentials and creates the signed package. Use it only for an explicit extension release; do not sign in through a browser or repackage an unsigned ZIP as XPI. Keep signed artifacts and credentials out of Git and logs.
- Use a browser for relevant UI verification unless the user says not to. Do not open one for unrelated checks.

## Production delivery

- Deploy only when the user asks. Reuse passing PR CI; do not wait for a duplicate post-merge run when the source is unchanged. The full path is `bash scripts/server-release.sh <private-request.json>`; it owns install, focused policy/build, staging, dry-runs, publish, and smoke. Do not repeat those steps manually.
- Use the existing non-root deployment account and production configs. Preserve Access domains and existing database, storage, queue, and browser resources. Never recreate resources or bypass a migration/drift blocker.
- If deployment reports `fetch failed`, read that run's `evidence.json` and `/srv/zhiye-delivery/state/last-success.json` once. The error names the failing endpoint; network requests already receive a short bounded retry. `recovery: previous-pair-restored` means the prior pair is active; never claim the new release is live. After the named endpoint responds normally, recreate the private request in the same run directory and run `bash scripts/server-release.sh --publish-only <private-request.json>` once. This holds the production lock, reuses the existing build, and repeats only the release plan/staging/publish path. Do not copy the source tree or reinstall/build again. If recovery is `manual-required`, the endpoint stays unavailable, or the publish-only attempt fails, stop and report it; never force deployment or roll back data manually.
- Never expose credentials. Record the source, Worker versions, migration/recovery outcome, and smoke result. Boundary smoke checks do not prove authenticated business flows; report those separately.
- AMO and desktop releases are explicit tasks. Routine fixes do not create release tags or signed packages. Read detailed runbooks only when the task needs them.
