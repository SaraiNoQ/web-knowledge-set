import { createHomeRepository, HomeError, validateCover, HOME_MAX_IMAGE_BYTES } from "../shared/home";
import { CloudHttpError, jsonObject, type D1Database } from "./extension";
import type { R2Bucket } from "./backup";

export async function handleHome(request:Request,url:URL,db:D1Database,images:R2Bucket) {
  try {
    const repo=createHomeRepository({documents:"cloud_documents",folders:"cloud_folders",
      all:async(sql,values)=>(await db.prepare(sql).bind(...values).all<Record<string,unknown>>()).results,
      batch:async(statements)=>{if(!db.batch)throw new HomeError(503,"数据库暂不可用。");await db.batch(statements.map(s=>db.prepare(s.sql).bind(...s.values)));}
    });
    if(url.pathname==="/api/home"&&request.method==="GET")return await repo.list(url);
    if(url.pathname==="/api/home"&&request.method==="PUT")return await repo.save(await jsonObject(request,256*1024));
    if(url.pathname==="/api/home/covers"&&request.method==="POST"){
      const body=await jsonObject(request,3*1024*1024);
      if(Object.keys(body).some(k=>k!=="image")||typeof body.image!=="string"||body.image.length%4!==0 || body.image.length>Math.ceil(HOME_MAX_IMAGE_BYTES/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.image))throw new HomeError(400,"封面数据无效。");
      const binary=atob(body.image),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));validateCover(bytes);
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
      await images.put(hash,bytes,{httpMetadata:{contentType:"image/png"}});
      await db.prepare("INSERT OR IGNORE INTO home_covers(hash,mime,bytes) VALUES(?,'image/png',?)").bind(hash,bytes.length).run();
      return {hash};
    }
    const match=/^\/api\/home\/covers\/([a-f0-9]{64})$/.exec(url.pathname);
    if(match&&request.method==="GET"){
      if(!await db.prepare("SELECT hash FROM home_covers WHERE hash=?").bind(match[1]).first())throw new HomeError(404,"封面不存在。");
      const object=await images.get(match[1]);if(!object)throw new HomeError(404,"封面文件不存在。");
      return new Response(await object.arrayBuffer(),{headers:{"Content-Type":"image/png","Cache-Control":"private, max-age=3600","X-Content-Type-Options":"nosniff"}});
    }
    throw new HomeError(405,"不支持的首页操作。");
  }catch(error){
    if(error instanceof HomeError)throw new CloudHttpError(error.status,"HOME_ERROR",error.message);
    if(/HOME_CONFLICT|malformed JSON|FOREIGN KEY/iu.test(String((error as Error).message)))throw new CloudHttpError(409,"REVISION_CONFLICT","首页或文章已变化，请重新加载。");
    throw error;
  }
}
