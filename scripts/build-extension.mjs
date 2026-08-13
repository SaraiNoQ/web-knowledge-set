import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { zipSync } from "fflate";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "dist", "extensions");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

function archiveFiles(directory, prefix = "") {
  return Object.fromEntries(readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    return statSync(path).isDirectory() ? Object.entries(archiveFiles(path, archivePath)) : [[archivePath, readFileSync(path)]];
  }));
}

for (const browser of ["chrome", "firefox"]) {
  const directory = join(output, `zhiye-clipper-${browser}`);
  mkdirSync(directory, { recursive: true });
  for (const [entry, filename, name] of [
    ["extension/content.ts", "content.js", "ZhiyeClipContent"],
    ["extension/popup.ts", "popup.js", "ZhiyeClipPopup"],
  ]) {
    await build({
      configFile: false,
      build: {
        emptyOutDir: false,
        minify: true,
        outDir: directory,
        sourcemap: false,
        lib: { entry: join(root, entry), formats: ["iife"], name, fileName: () => filename },
      },
    });
  }
  for (const name of ["popup.html", "popup.css"]) {
    writeFileSync(join(directory, name), readFileSync(join(root, "extension", name)));
  }
  writeFileSync(join(directory, "icon.png"), readFileSync(join(root, "src-tauri", "icons", "128x128.png")));
  writeFileSync(join(directory, "manifest.json"), readFileSync(join(root, "extension", `manifest.${browser}.json`)));
  writeFileSync(join(output, `zhiye-clipper-${browser}.zip`), zipSync(archiveFiles(directory), { level: 0 }));
}

console.log(`Built ${basename(output)}/zhiye-clipper-{chrome,firefox}.zip`);
