import { dataSafetyHealth } from "../server/data-safety.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { CURRENT_SCHEMA_VERSION, openDatabase, type KnowledgeDatabase } from "../server/db.js";
import { uploadHomeCover, localHome } from "../server/home.js";
import { createBackup, restoreBackup } from "../server/backup.js";
import { createPortableBundle, stagePortableBundle, promotePortableAssets } from "../server/portable.js";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64");
async function configure(db:KnowledgeDatabase) {
  const document=db.createArticle("封面文章");
  const {hash}=uploadHomeCover(db,{image:png.toString("base64")});
  const presentation={documentId:document.id,featured:true,position:3,coverHash:hash,color:"sage" as const,shortTitle:"封面",fit:"contain" as const};
  await localHome(db,()=>{}).save({revision:1,changes:[presentation]});
  return {document,hash,presentation};
}

test("local backup restores cover-only resources and presentation without changing article content",async()=>{
  const root=mkdtempSync(join(tmpdir(),"zhiye-home-backup-")),data=join(root,"data"),backups=join(root,"backups");
  let db=openDatabase(data);
  try {
    const {document,hash}=await configure(db);
    assert.equal(db.getDocument(document.id)!.revision,document.revision);
    assert.equal(db.getDocument(document.id)!.markdown,"");
    const backup=await createBackup({dataDir:data,backupRoot:backups,database:db.sql});
    assert.ok(backup.manifest.files.some(f=>f.path===`assets/${hash}`));
    assert.deepEqual(dataSafetyHealth(db).orphanAssets,[]);
    assert.ok(db.getDatabaseHealth().referencedAssetPaths.includes(`assets/${hash}`));
    db.sql.exec("DELETE FROM home_presentations");
    db.close();
    await restoreBackup({dataDir:data,backupRoot:backups,backupPath:backup.path,supportedSchemaVersion:CURRENT_SCHEMA_VERSION,prepareStaging:path=>{openDatabase(path).close();}});
    db=openDatabase(data);
    assert.equal(db.sql.prepare("SELECT cover_hash FROM home_presentations WHERE document_id=?").get(document.id)?.cover_hash,hash);
    assert.deepEqual(readFileSync(db.assetFilePath(hash)),png);
    db.cleanupUnreferencedAssets();
    assert.ok(existsSync(db.assetFilePath(hash)));
    rmSync(db.assetFilePath(hash));
    assert.ok(dataSafetyHealth(db).missingAssets.includes(`assets/${hash}`));
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test("portable covers round-trip, copy rebinds IDs, skip preserves settings and corrupted covers are rejected",async()=>{
  const root=mkdtempSync(join(tmpdir(),"zhiye-home-portable-"));
  const source=openDatabase(join(root,"source")),target=openDatabase(join(root,"target"));
  try {
    const {document,hash}=await configure(source);
    const bundle=await createPortableBundle(source,[document.id]);
    const files=unzipSync(bundle),manifest=JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    assert.equal(manifest.version,4);assert.ok(files[`covers/${hash}.png`]);
    const apply=async(strategy:"skip"|"copy"|"update")=>{const preview=await stagePortableBundle(target,bundle);promotePortableAssets(target,preview.id);return target.applyImportBatch(preview.id,strategy)!;};
    const first=await apply("copy");const id=first.items[0]!.documentId!;
    assert.notEqual(id,document.id);
    assert.equal(target.sql.prepare("SELECT revision FROM home_settings WHERE id=1").get()?.revision,2);
    assert.equal(target.sql.prepare("SELECT cover_hash FROM home_presentations WHERE document_id=?").get(id)?.cover_hash,hash);
    target.sql.prepare("UPDATE home_presentations SET short_title='我的标题' WHERE document_id=?").run(id);
    await apply("skip");assert.equal(target.sql.prepare("SELECT short_title FROM home_presentations WHERE document_id=?").get(id)?.short_title,"我的标题");
    await apply("update");assert.equal(target.sql.prepare("SELECT short_title FROM home_presentations WHERE document_id=?").get(id)?.short_title,"封面");
    const copied=await apply("copy");assert.notEqual(copied.items[0]!.documentId,id);
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM home_presentations").get()?.n,2);
    target.cleanupUnreferencedAssets();assert.deepEqual(readFileSync(target.assetFilePath(hash)),png);
    const invalid={...files,[`covers/${hash}.png`]:strToU8("not an image")};
    await assert.rejects(stagePortableBundle(target,zipSync(invalid)),/校验|checksum/);
    assert.equal(target.sql.prepare("SELECT COUNT(*) AS n FROM home_presentations").get()?.n,2);
  } finally {source.close();target.close();rmSync(root,{recursive:true,force:true});}
});

test("shared cover assets and pending uploads survive document deletion and queued cleanup",async()=>{
  const root=mkdtempSync(join(tmpdir(),"zhiye-home-cleanup-")),db=openDatabase(root);
  try {
    const {hash}=uploadHomeCover(db,{image:png.toString("base64")});
    assert.equal(hash,createHash("sha256").update(png).digest("hex"));
    db.cleanupUnreferencedAssets();assert.ok(existsSync(db.assetFilePath(hash)));
    db.sql.prepare("INSERT INTO file_deletions(path,created_at,updated_at) VALUES(?,?,?)").run(`assets/${hash}`,new Date().toISOString(),new Date().toISOString());
    db.processPendingFileDeletions();assert.ok(existsSync(db.assetFilePath(hash)));
    assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM file_deletions").get()?.n,0);
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});
