import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, "desktop-resources", "runtime");
const binaries = join(root, "src-tauri", "binaries");
const extension = process.platform === "win32" ? ".exe" : "";
const requiredNode = "24.19.0";
const pnpmCli = process.env.npm_execpath;
const rustupRustc = join(homedir(), ".cargo", "bin", `rustc${extension}`);
const rustc = process.env.RUSTC || (existsSync(rustupRustc) ? rustupRustc : `rustc${extension}`);

if (process.versions.node !== requiredNode) {
  throw new Error(`Desktop preparation requires Node ${requiredNode}; received ${process.version}`);
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
const runPnpm = (args, options) =>
  pnpmCli ? run(process.execPath, [pnpmCli, ...args], options) : run("pnpm", args, options);

runPnpm(["build"]);

rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
mkdirSync(binaries, { recursive: true });

cpSync(join(root, "dist"), join(runtime, "dist"), { recursive: true });
cpSync(join(root, "dist-server"), join(runtime, "dist-server"), { recursive: true });
cpSync(join(root, "package.json"), join(runtime, "package.json"));
cpSync(join(root, "pnpm-lock.yaml"), join(runtime, "pnpm-lock.yaml"));

runPnpm(["install", "--ignore-workspace", "--prod", "--offline", "--frozen-lockfile", "--config.node-linker=hoisted"], { cwd: runtime });
run(process.execPath, ["--input-type=module", "--eval", "import { lstat } from 'node:fs/promises'; if ((await lstat('node_modules/mdast-util-from-markdown')).isSymbolicLink()) process.exit(1); await import('mdast-util-from-markdown')"], { cwd: runtime });

const browserPath = join(runtime, "browsers");
runPnpm(["exec", "playwright", "install", "chromium", "--only-shell"], {
  cwd: runtime,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserPath },
});

const target = execFileSync(rustc, ["--print", "host-tuple"], {
  cwd: root,
  encoding: "utf8",
}).trim();

cpSync(process.execPath, join(binaries, `node-${target}${extension}`));
