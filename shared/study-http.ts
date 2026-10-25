import { readerRevision, readerText, ReaderInputError } from "./reader-tools.js";
import { createStudyStore } from "./study-store.js";
import { ReadingDataError } from "./reading-data.js";
import { getRelated, getConnectionEvidence, setConnectionEvidence, type RelationType } from "./related.js";
import { duplicateCandidates } from "./study-analysis.js";
import type { StudyAdapter, StudyAnswer, LinkHealth } from "./study-types.js";
export interface StudyServices {
  question(topicId:string,question:string,topicRevision:number,settingsRevision:number,signal:AbortSignal,scope:unknown):Promise<StudyAnswer>;
  source(url:string,signal:AbortSignal):Promise<{status:number|null;state:LinkHealth["state"];message:string}>;
}
export async function handleStudyApi(method:string,url:URL,body:unknown,db:StudyAdapter,services:StudyServices,signal:AbortSignal) {
  const store=createStudyStore(db),parts=url.pathname.slice("/api/study/".length).split("/").map(part=>{try{return decodeURIComponent(part);}catch{throw new ReaderInputError("路径无效。");}});
  const value = (keys:string[]) => { if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))throw new ReaderInputError("请求无效。");return body as Record<string,unknown>; };
  if(parts[0]==="topics") {
    if(!parts[1]&&method==="GET")return store.listTopics();
    if(!parts[1]&&method==="POST")return store.createTopic(body);
    if(parts.length===2&&method==="GET")return store.topic(parts[1]!);
    if(parts.length===2&&method==="PATCH")return store.updateTopic(parts[1]!,body);
    if(parts.length===2&&method==="DELETE")return store.deleteTopic(parts[1]!,body);
    if(parts[2]==="ask"&&method==="POST") {const v=value(["question","topicRevision","settingsRevision","scope"]);if(!Number.isSafeInteger(v.settingsRevision)||Number(v.settingsRevision)<0)throw new ReaderInputError("模型设置版本无效。");return services.question(parts[1]!,readerText(v.question,2000,true),readerRevision(v.topicRevision),Number(v.settingsRevision),signal,v.scope);}
  }
  if(parts[0]==="source-collections"&&method==="GET")return store.sourceCollections();
  if(parts[0]==="from-collection"&&method==="POST")return store.fromCollection(body);
  if(parts[0]==="documents") {
    if(!parts[1]&&method==="GET")return store.documents({q:url.searchParams.get("q")??"",unread:url.searchParams.get("unread")==="true",page:Number(url.searchParams.get("page")??1)});
    if(parts[2]==="progress"&&method==="GET")return store.progress(parts[1]!);
    if(parts[2]==="progress"&&method==="PUT")return store.saveProgress(parts[1]!,body);
    if(parts[2]==="tags"&&method==="PUT")return store.tags(parts[1]!,body);
    if(parts[2]==="check-source"&&method==="POST") {
      const v=value(["revision"]),doc=await db.document(parts[1]!);if(!doc||doc.deletedAt)throw new ReadingDataError(404,"DOCUMENT_NOT_FOUND");if(doc.revision!==readerRevision(v.revision))throw new ReadingDataError(409,"REVISION_CONFLICT");
      const checked=await services.source(doc.sourceUrl,signal);signal.throwIfAborted();const checkedAt=new Date().toISOString();
      await db.batch([{sql:`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${db.documentsTable} WHERE id=? AND revision=? AND deleted_at IS NULL) THEN 1 ELSE json('STUDY_CONFLICT') END`,values:[doc.id,doc.revision]},{sql:"INSERT INTO study_source_checks VALUES (?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET source_revision=excluded.source_revision,url=excluded.url,state=excluded.state,status=excluded.status,checked_at=excluded.checked_at,message=excluded.message",values:[doc.id,doc.revision,doc.sourceUrl,checked.state,checked.status,checkedAt,checked.message]}]);
      return {documentId:doc.id,url:doc.sourceUrl,checkedAt,...checked};
    }
  }
  if(parts[0]==="related"&&parts[1]&&method==="GET")return getRelated(db,parts[1],{limit:Number(url.searchParams.get("limit")??10),...(url.searchParams.get("cursor")?{cursor:url.searchParams.get("cursor")!}:{}),...(url.searchParams.has("types")?{types:(url.searchParams.get("types")?url.searchParams.get("types")!.split(","):[]) as RelationType[]}:{} )});
  if(parts[0]==="connections"&&parts[2]==="evidence") {
    if(method==="GET")return getConnectionEvidence(db,parts[1]!);
    if(method==="PUT"){const v=value(["documentId","revision","sourceAnnotationId","targetAnnotationId","relationType"]); const {documentId,...input}=v;return setConnectionEvidence(db,readerText(documentId,200,true),parts[1]!,input);}
  }
  if(parts[0]==="annotations"&&method==="GET")return store.annotations(Number(url.searchParams.get("page")??1));
  if(parts[0]==="duplicates"&&method==="GET")return duplicateCandidates(db,url.searchParams.get("cursor")??"");
  if(parts[0]==="merges") {
    if(!parts[1]&&method==="GET")return store.mergeHistory();
    if(!parts[1]&&method==="POST")return store.merge(body);
    if(parts[2]==="undo"&&method==="POST"){value([]);return store.undoMerge(parts[1]!);}
  }
  if(parts[0]==="reviews") {
    if(!parts[1]&&method==="GET")return store.reviews(url.searchParams.get("all")==="true");
    if(!parts[1]&&method==="POST"){const v=value(["annotationId"]);return store.scheduleReview(readerText(v.annotationId,200,true));}
    if(parts[1]&&method==="PATCH")return store.gradeReview(parts[1],body);
  }
  throw new ReadingDataError(404,"STUDY_ACTION_NOT_FOUND");
}
