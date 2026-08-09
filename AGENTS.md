# Development environment

- Keep the local workspace for source editing and synchronization only.
- Do not download or install project dependencies in the local workspace.
- Do not compile, run development servers, package the application, or execute dependency-backed tests locally.
- Synchronize the source to the corresponding project directory on `ssh root@campus-server` before installing dependencies, compiling, testing, packaging, or running the application.
- Perform all dependency installation, build, test, packaging, and development-server work on `root@campus-server`.
- Keep generated dependencies and build artifacts out of source synchronization (`node_modules`, `dist`, `dist-server`, `target`, Playwright browser caches, test reports, and local data).

