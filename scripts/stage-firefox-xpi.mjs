import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { strFromU8, unzipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const source = process.argv[2];
const expectedHash = process.argv[3];
const destination = join(root, "dist/extensions/zhiye-clipper-firefox.xpi");
rmSync(destination, { force: true });
if (!source || !/^[a-f0-9]{64}$/u.test(expectedHash ?? "")) throw new Error("Pass the AMO-signed XPI path and recorded SHA-256");
const bytes = readFileSync(source);
if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("XPI differs from the AMO-signed release digest");
const files = unzipSync(bytes);
const manifest = files["manifest.json"] && JSON.parse(strFromU8(files["manifest.json"]));
const expected = JSON.parse(readFileSync(join(root, "extension/manifest.firefox.json"), "utf8"));
if (!isDeepStrictEqual(manifest, expected) || !files["META-INF/mozilla.rsa"]?.length || !files["META-INF/cose.sig"]?.length) {
  throw new Error("XPI version, manifest, or AMO signature is missing or mismatched");
}
for (const name of ["content.js", "popup.js", "popup.html", "popup.css", "icon.png"]) {
  const built = readFileSync(join(root, "dist/extensions/zhiye-clipper-firefox", name));
  if (!files[name] || !Buffer.from(files[name]).equals(built)) throw new Error(`XPI differs from this build: ${name}`);
}
copyFileSync(source, destination);
