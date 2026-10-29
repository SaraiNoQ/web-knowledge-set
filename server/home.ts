import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeDatabase } from "./db.js";
import { createHomeRepository, HomeError, validateCover, HOME_MAX_IMAGE_BYTES } from "../shared/home.js";

export function localHome(database: KnowledgeDatabase, assertCurrent:()=>void) {
  return createHomeRepository({documents:"documents",folders:"folders",
    all:async(sql,values)=>{ assertCurrent(); return database.sql.prepare(sql).all(...values as never[]); },
    batch:async(statements)=>{
      assertCurrent();database.sql.exec("BEGIN IMMEDIATE");
      try { for(const s of statements)database.sql.prepare(s.sql).all(...s.values as never[]);database.sql.exec("COMMIT"); }
      catch(error){database.sql.exec("ROLLBACK");throw error;}
    }
  });
}
export function uploadHomeCover(database:KnowledgeDatabase,body:Record<string,unknown>) {
  if(Object.keys(body).some(k=>k!=="image") || typeof body.image!=="string" || body.image.length%4!==0 || body.image.length>Math.ceil(HOME_MAX_IMAGE_BYTES/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image))throw new HomeError(400,"封面数据无效。");
  const bytes=Buffer.from(body.image,"base64");validateCover(bytes);
  const hash=createHash("sha256").update(bytes).digest("hex"),temporary=join(database.assetsDir,`.asset-${randomUUID()}.tmp`);
  try {writeFileSync(temporary,bytes,{mode:0o600,flag:"wx",flush:true});renameSync(temporary,database.assetFilePath(hash));}
  finally{rmSync(temporary,{force:true});}
  database.sql.prepare("INSERT OR IGNORE INTO home_covers(hash,mime,bytes) VALUES(?,'image/png',?)").run(hash,bytes.length);
  return {hash};
}
export function localHomeCover(database:KnowledgeDatabase,hash:string) {
  if(!/^[a-f0-9]{64}$/.test(hash)||!database.sql.prepare("SELECT 1 FROM home_covers WHERE hash=?").get(hash))throw new HomeError(404,"封面不存在。");
  try{return readFileSync(database.assetFilePath(hash));}catch{throw new HomeError(404,"封面文件不存在。");}
}
