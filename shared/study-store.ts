import { parseSourceAnchor, ReaderInputError, readerRevision, readerText } from "./reader-tools.js";
import { annotationColumns, annotationFromRow, ReadingDataError } from "./reading-data.js";
import type { StudyAdapter, StudyTopic, StudyTopicDetail, ReadingProgress, ReviewItem, ReviewGrade, MergeRecord, StudyDocument } from "./study-types.js";

export const STUDY_SCHEMA = `
CREATE TABLE study_topics(id TEXT PRIMARY KEY,name TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE study_topic_documents(topic_id TEXT NOT NULL REFERENCES study_topics(id) ON DELETE CASCADE,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,PRIMARY KEY(topic_id,document_id));
CREATE INDEX study_topic_documents_document ON study_topic_documents(document_id);
CREATE TABLE study_topic_annotations(topic_id TEXT NOT NULL REFERENCES study_topics(id) ON DELETE CASCADE,annotation_id TEXT NOT NULL REFERENCES reading_annotations(id) ON DELETE CASCADE,PRIMARY KEY(topic_id,annotation_id));
CREATE TABLE study_progress(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,document_revision INTEGER NOT NULL,revision INTEGER NOT NULL,fraction REAL NOT NULL CHECK(fraction>=0 AND fraction<=1),anchor_json TEXT CHECK(anchor_json IS NULL OR json_valid(anchor_json)),is_read INTEGER NOT NULL CHECK(is_read IN (0,1)),updated_at TEXT NOT NULL);
CREATE TABLE study_reviews(annotation_id TEXT PRIMARY KEY REFERENCES reading_annotations(id) ON DELETE CASCADE,due_at TEXT NOT NULL,interval_days INTEGER NOT NULL DEFAULT 0,repetitions INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE study_document_tags(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,tag TEXT NOT NULL,PRIMARY KEY(document_id,tag));
CREATE TABLE study_source_checks(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,source_revision INTEGER NOT NULL,url TEXT NOT NULL,state TEXT NOT NULL,status INTEGER,checked_at TEXT NOT NULL,message TEXT NOT NULL);
CREATE TABLE study_merge_history(id TEXT PRIMARY KEY,keep_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,source_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,before_keep_json TEXT NOT NULL CHECK(json_valid(before_keep_json)),before_source_json TEXT NOT NULL CHECK(json_valid(before_source_json)),after_keep_revision INTEGER NOT NULL,after_source_revision INTEGER NOT NULL,undone INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE study_fingerprints(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,source_revision INTEGER NOT NULL,fingerprint_json TEXT NOT NULL CHECK(json_valid(fingerprint_json)));
`;
export const STUDY_TABLES = [
  { name: "study_topics", columns: ["id","name","note","revision","created_at","updated_at"] },
  { name: "study_topic_documents", columns: ["topic_id","document_id"] },
  { name: "study_topic_annotations", columns: ["topic_id","annotation_id"] },
  { name: "study_progress", columns: ["document_id","document_revision","revision","fraction","anchor_json","is_read","updated_at"] },
  { name: "study_reviews", columns: ["annotation_id","due_at","interval_days","repetitions","revision"] },
  { name: "study_document_tags", columns: ["document_id","tag"] },
  { name: "study_source_checks", columns: ["document_id","source_revision","url","state","status","checked_at","message"] },
  { name: "study_merge_history", columns: ["id","keep_id","source_id","before_keep_json","before_source_json","after_keep_revision","after_source_revision","undone","created_at"] },
] as const;
type Row = Record<string, unknown>;
const topicColumns = "id,name,note,revision,created_at AS createdAt,updated_at AS updatedAt";
const rowTopic = (r: Row): StudyTopic => ({ id:String(r.id),name:String(r.name),note:String(r.note),revision:Number(r.revision),createdAt:String(r.createdAt),updatedAt:String(r.updatedAt),documentIds:[],annotationIds:[] });
const object = (v: unknown, allowed: string[]) => { if (!v || typeof v!=="object" || Array.isArray(v) || Object.keys(v).some(k=>!allowed.includes(k))) throw new ReaderInputError("请求字段无效。"); return v as Row; };
const statement = (sql: string, values: unknown[] = []) => ({ sql, values });
const guard = (condition: string, values: unknown[]) => statement(`SELECT CASE WHEN ${condition} THEN 1 ELSE json('STUDY_CONFLICT') END`, values);
export function createStudyStore(db: StudyAdapter) {
  const docs = db.documentsTable;
  const indexTable = docs === "documents" ? "semantic_indexes" : "cloud_semantic_indexes";
  const tagSource = `SELECT tag FROM study_document_tags st WHERE st.document_id=d.id${docs==="documents"?" UNION SELECT t.name AS tag FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=d.id":""}`;
  const metadata = (where:string,values:unknown[]) => db.all(`SELECT d.id,d.title,d.source_url AS sourceUrl,d.kind,d.revision,d.deleted_at AS deletedAt,d.folder_id AS folderId,'' AS markdown,COALESCE((SELECT json_group_array(tag) FROM (${tagSource})),'[]') AS tagsJson FROM ${docs} d ${where}`,values).then(rows=>rows.map(r=>({id:String(r.id),title:String(r.title),sourceUrl:String(r.sourceUrl),kind:r.kind as StudyDocument["kind"],revision:Number(r.revision),deletedAt:r.deletedAt==null?null:String(r.deletedAt),folderId:r.folderId==null?null:String(r.folderId),markdown:"",tags:JSON.parse(String(r.tagsJson)) as string[]})));
  const document = async (id: string, revision?: number) => { const d=await db.document(id); if(!d || d.deletedAt) throw new ReadingDataError(404,"DOCUMENT_NOT_FOUND"); if(revision!==undefined&&d.revision!==revision) throw new ReadingDataError(409,"REVISION_CONFLICT"); return d; };
  const batch = async (s: Array<{sql:string;values:unknown[]}>) => { try { await db.batch(s); } catch(e) { if (/malformed JSON|STUDY_CONFLICT/iu.test(String((e as Error).message))) throw new ReadingDataError(409,"REVISION_CONFLICT"); throw e; } };
  const docGuard = (id:string,rev:number) => guard(`EXISTS(SELECT 1 FROM ${docs} WHERE id=? AND revision=? AND deleted_at IS NULL)`,[id,rev]);
  const readyGuard = (id:string) => guard(`EXISTS(SELECT 1 FROM ${docs} d WHERE d.id=? AND d.status='ready' AND (d.kind<>'paper' OR EXISTS(SELECT 1 FROM ${docs==="documents"?"papers":"cloud_papers"} p WHERE p.id=d.id AND p.status='ready')))`,[id]);
  const topicGuard = (id:string,rev:number) => guard("EXISTS(SELECT 1 FROM study_topics WHERE id=? AND revision=?)",[id,rev]);
  const topic = async (id:string):Promise<StudyTopicDetail> => {
    const rows=await db.all(`SELECT ${topicColumns} FROM study_topics WHERE id=?`,[id]); if(!rows[0]) throw new ReadingDataError(404,"TOPIC_NOT_FOUND");
    const members=await db.all(`SELECT d.id FROM study_topic_documents t JOIN ${docs} d ON d.id=t.document_id WHERE t.topic_id=? AND d.deleted_at IS NULL ORDER BY d.title,d.id`,[id]);
    const annotations=(await db.all(`SELECT ${annotationColumns.split(", ").map(c=>"a."+c).join(", ")} FROM reading_annotations a JOIN study_topic_annotations t ON t.annotation_id=a.id JOIN ${docs} d ON d.id=a.document_id WHERE t.topic_id=? AND d.deleted_at IS NULL ORDER BY a.created_at,a.id`,[id])).map(annotationFromRow);
    const documents=await metadata("WHERE d.id IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NULL ORDER BY d.title,d.id",[JSON.stringify(members.map(r=>r.id))]);
    return {...rowTopic(rows[0]),documentIds:documents.map(d=>d.id),annotationIds:annotations.map(a=>a.id),documents,annotations};
  };
  const progress = async (id:string):Promise<ReadingProgress|null> => {
    await document(id); const r=(await db.all("SELECT * FROM study_progress WHERE document_id=?",[id]))[0];
    return r?{documentId:id,documentRevision:Number(r.document_revision),revision:Number(r.revision),fraction:Number(r.fraction),anchor:r.anchor_json?parseSourceAnchor(JSON.parse(String(r.anchor_json))):null,read:r.is_read===1,updatedAt:String(r.updated_at)}:null;
  };
  const reviewItem = (r:Row):ReviewItem => ({annotation:annotationFromRow(r),documentTitle:String(r.documentTitle),documentRevision:Number(r.documentRevision),dueAt:r.due_at?String(r.due_at):null,intervalDays:Number(r.interval_days??0),repetitions:Number(r.repetitions??0),revision:Number(r.reviewRevision??0)});
  return {
    topic,progress,
    async sourceCollections() {
      if(docs!=="documents")return [];
      const rows=await db.all("SELECT id,name,updated_at AS updatedAt FROM collections ORDER BY name,id LIMIT 1000",[]);
      const members=await db.all("SELECT c.collection_id AS collectionId,d.id,d.title,d.revision FROM document_collections c JOIN documents d ON d.id=c.document_id WHERE d.deleted_at IS NULL ORDER BY c.collection_id,d.id",[]);
      return rows.map(r=>({id:String(r.id),name:String(r.name),updatedAt:String(r.updatedAt),documents:members.filter(m=>m.collectionId===r.id).map(m=>({id:String(m.id),title:String(m.title),revision:Number(m.revision)}))}));
    },
    async fromCollection(value:unknown) {
      if(docs!=="documents")throw new ReaderInputError("云端请直接创建研究专题。");
      const v=object(value,["collectionId","updatedAt","documents","name"]),collectionId=readerText(v.collectionId,200,true),updatedAt=readerText(v.updatedAt,50,true);
      if(!Array.isArray(v.documents)||v.documents.length>100)throw new ReaderInputError("一次最多复制100篇资料，请选择更小的集合。");
      const scope=v.documents.map(item=>{const d=object(item,["id","revision"]);return {id:readerText(d.id,200,true),revision:readerRevision(d.revision)};});if(new Set(scope.map(d=>d.id)).size!==scope.length)throw new ReaderInputError("资料范围重复。");
      const source=(await db.all("SELECT name FROM collections WHERE id=? AND updated_at=?",[collectionId,updatedAt]))[0];if(!source)throw new ReadingDataError(409,"REVISION_CONFLICT");
      const id=crypto.randomUUID(),now=new Date().toISOString(),serialized=JSON.stringify(scope),name=readerText(v.name??String(source.name),100,true).trim();
      await batch([guard("EXISTS(SELECT 1 FROM collections WHERE id=? AND updated_at=?) AND (SELECT COUNT(*) FROM document_collections c JOIN documents d ON d.id=c.document_id WHERE c.collection_id=? AND d.deleted_at IS NULL)=? AND NOT EXISTS(SELECT 1 FROM document_collections c JOIN documents d ON d.id=c.document_id WHERE c.collection_id=? AND d.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE json_extract(e.value,'$.id')=d.id AND json_extract(e.value,'$.revision')=d.revision))",[collectionId,updatedAt,collectionId,scope.length,collectionId,serialized]),statement("INSERT INTO study_topics(id,name,note,revision,created_at,updated_at) VALUES (?,?,?,1,?,?)",[id,name,`从集合「${source.name}」复制的研究资料清单。`,now,now]),statement("INSERT INTO study_topic_documents(topic_id,document_id) SELECT ?,json_extract(value,'$.id') FROM json_each(?)",[id,serialized])]);return topic(id);
    },
    async listTopics() {
      const rows=await db.all("SELECT id,name,'' AS note,revision,created_at AS createdAt,updated_at AS updatedAt FROM study_topics ORDER BY updated_at DESC,id LIMIT 1000",[]);
      const [ds,as]=await Promise.all([db.all(`SELECT t.topic_id,t.document_id FROM study_topic_documents t JOIN ${docs} d ON d.id=t.document_id WHERE d.deleted_at IS NULL`,[]),db.all(`SELECT t.topic_id,t.annotation_id FROM study_topic_annotations t JOIN reading_annotations a ON a.id=t.annotation_id JOIN ${docs} d ON d.id=a.document_id WHERE d.deleted_at IS NULL`,[])]);
      return rows.map(r=>({...rowTopic(r),documentIds:ds.filter(d=>d.topic_id===r.id).map(d=>String(d.document_id)),annotationIds:as.filter(a=>a.topic_id===r.id).map(a=>String(a.annotation_id))}));
    },
    async createTopic(value:unknown) { const v=object(value,["name"]),id=crypto.randomUUID(),now=new Date().toISOString(); await db.run("INSERT INTO study_topics(id,name,note,revision,created_at,updated_at) VALUES (?,?,'',1,?,?)",[id,readerText(v.name,100,true).trim(),now,now]); return topic(id); },
    async updateTopic(id:string,value:unknown) {
      const v=object(value,["revision","name","note","documentId","annotationId","removeDocumentId","removeAnnotationId"]), rev=readerRevision(v.revision),current=await topic(id);
      const s=[topicGuard(id,rev)];
      if(v.documentId!==undefined) { const d=await document(readerText(v.documentId,200,true)); if(current.documentIds.length>=100&&!current.documentIds.includes(d.id))throw new ReaderInputError("每个专题最多100篇资料。");s.push(docGuard(d.id,d.revision),guard("(SELECT COUNT(*) FROM study_topic_documents WHERE topic_id=?)<100 OR EXISTS(SELECT 1 FROM study_topic_documents WHERE topic_id=? AND document_id=?)",[id,id,d.id]),statement("INSERT OR IGNORE INTO study_topic_documents VALUES (?,?)",[id,d.id])); }
      if(v.annotationId!==undefined) {
        const aid=readerText(v.annotationId,200,true),r=(await db.all("SELECT document_id FROM reading_annotations WHERE id=?",[aid]))[0]; if(!r) throw new ReadingDataError(404,"ANNOTATION_NOT_FOUND");
        if(current.annotationIds.length>=200&&!current.annotationIds.includes(aid)) throw new ReaderInputError("每个专题最多200条摘录。");
        s.push(guard("(SELECT COUNT(*) FROM study_topic_annotations WHERE topic_id=?)<200 OR EXISTS(SELECT 1 FROM study_topic_annotations WHERE topic_id=? AND annotation_id=?)",[id,id,aid]),guard("(SELECT COUNT(*) FROM study_topic_documents WHERE topic_id=?)<100 OR EXISTS(SELECT 1 FROM study_topic_documents WHERE topic_id=? AND document_id=?)",[id,id,String(r.document_id)]));
        const d=await document(String(r.document_id)); s.push(docGuard(d.id,d.revision),guard("EXISTS(SELECT 1 FROM reading_annotations WHERE id=? AND document_id=?)",[aid,d.id]),statement("INSERT OR IGNORE INTO study_topic_documents VALUES (?,?)",[id,d.id]),statement("INSERT OR IGNORE INTO study_topic_annotations VALUES (?,?)",[id,aid]));
      }
      if(v.removeDocumentId!==undefined) { const did=readerText(v.removeDocumentId,200,true); s.push(statement("DELETE FROM study_topic_annotations WHERE topic_id=? AND annotation_id IN (SELECT id FROM reading_annotations WHERE document_id=?)",[id,did]),statement("DELETE FROM study_topic_documents WHERE topic_id=? AND document_id=?",[id,did])); }
      if(v.removeAnnotationId!==undefined) s.push(statement("DELETE FROM study_topic_annotations WHERE topic_id=? AND annotation_id=?",[id,readerText(v.removeAnnotationId,200,true)]));
      s.push(statement("UPDATE study_topics SET name=?,note=?,revision=revision+1,updated_at=? WHERE id=?",[v.name===undefined?current.name:readerText(v.name,100,true).trim(),v.note===undefined?current.note:readerText(v.note,40_000),new Date().toISOString(),id]));
      await batch(s); return topic(id);
    },
    async deleteTopic(id:string,value:unknown) { const v=object(value,["revision"]); await batch([topicGuard(id,readerRevision(v.revision)),statement("DELETE FROM study_topics WHERE id=?",[id])]); return {deleted:true}; },
    async documents(options:{q?:string;unread?:boolean;page?:number}={}) {
      const page=options.page??1; if(!Number.isSafeInteger(page)||page<1||page>100000) throw new ReaderInputError("页码无效。");
      const q=readerText(options.q??"",200).trim().replaceAll("\\","\\\\").replaceAll("%","\\%").replaceAll("_","\\_");
      const where=`d.deleted_at IS NULL AND d.status='ready'${q?" AND d.title LIKE ? ESCAPE '\\'":""}${options.unread?" AND NOT EXISTS(SELECT 1 FROM study_progress p WHERE p.document_id=d.id AND p.is_read=1)":""}`;
      const args=q?[`%${q}%`]:[],rows=await db.all(`SELECT d.id FROM ${docs} d WHERE ${where} ORDER BY d.updated_at DESC,d.id LIMIT 20 OFFSET ?`,[...args,(page-1)*20]);
      const total=Number((await db.all(`SELECT COUNT(*) AS n FROM ${docs} d WHERE ${where}`,args))[0]?.n??0);
      return {page,total,items:await metadata("WHERE d.id IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NULL ORDER BY d.updated_at DESC,d.id",[JSON.stringify(rows.map(r=>r.id))])};
    },
    async annotations(page=1) { if(!Number.isSafeInteger(page)||page<1||page>100000) throw new ReaderInputError("页码无效。"); const where=`FROM reading_annotations a JOIN ${docs} d ON d.id=a.document_id WHERE d.deleted_at IS NULL`; return {page,total:Number((await db.all(`SELECT COUNT(*) AS n ${where}`,[]))[0]?.n??0),items:(await db.all(`SELECT ${annotationColumns.split(", ").map(c=>"a."+c).join(", ")} ${where} ORDER BY a.created_at DESC,a.id LIMIT 20 OFFSET ?`,[(page-1)*20])).map(annotationFromRow)}; },
    async saveProgress(id:string,value:unknown) {
      const v=object(value,["documentRevision","revision","fraction","anchor","read"]),doc=await document(id,readerRevision(v.documentRevision));
      if(!Number.isSafeInteger(v.revision)||Number(v.revision)<0||typeof v.fraction!=="number"||!Number.isFinite(v.fraction)||v.fraction<0||v.fraction>1||typeof v.read!=="boolean") throw new ReaderInputError("阅读进度无效。");
      const anchor=v.anchor==null?null:parseSourceAnchor(v.anchor);
      await batch([docGuard(id,doc.revision),guard("COALESCE((SELECT revision FROM study_progress WHERE document_id=?),0)=?",[id,v.revision]),statement("INSERT INTO study_progress VALUES (?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET document_revision=excluded.document_revision,revision=excluded.revision,fraction=excluded.fraction,anchor_json=excluded.anchor_json,is_read=excluded.is_read,updated_at=excluded.updated_at",[id,doc.revision,Number(v.revision)+1,v.fraction,anchor?JSON.stringify(anchor):null,Number(v.read),new Date().toISOString()])]);
      return progress(id);
    },
    async reviews(all=false) { const rows=await db.all(`SELECT ${annotationColumns.split(", ").map(c=>"a."+c).join(", ")},d.title AS documentTitle,d.revision AS documentRevision,r.due_at,r.interval_days,r.repetitions,r.revision AS reviewRevision FROM reading_annotations a ${all?"LEFT":"INNER"} JOIN study_reviews r ON a.id=r.annotation_id JOIN ${docs} d ON d.id=a.document_id WHERE d.deleted_at IS NULL${all?"":" AND r.due_at<=?"} ORDER BY r.due_at,a.id LIMIT 200`,all?[]:[new Date().toISOString()]);return rows.map(reviewItem); },
    async scheduleReview(aid:string) { const r=(await db.all("SELECT document_id FROM reading_annotations WHERE id=?",[aid]))[0];if(!r)throw new ReadingDataError(404,"ANNOTATION_NOT_FOUND"); const d=await document(String(r.document_id)); await batch([docGuard(d.id,d.revision),statement("INSERT OR IGNORE INTO study_reviews(annotation_id,due_at) SELECT id,? FROM reading_annotations WHERE id=?",[new Date().toISOString(),aid])]); return {scheduled:true}; },
    async gradeReview(aid:string,value:unknown) {
      const v=object(value,["revision","grade"]); if(!["again","hard","good","easy"].includes(String(v.grade))) throw new ReaderInputError("复习评价无效。");
      const r=(await db.all(`SELECT r.*,a.document_id FROM study_reviews r JOIN reading_annotations a ON a.id=r.annotation_id WHERE r.annotation_id=?`,[aid]))[0];if(!r)throw new ReadingDataError(404,"REVIEW_NOT_FOUND");const d=await document(String(r.document_id)),grade=v.grade as ReviewGrade;
      const interval=grade==="again"?0:Math.min(365,Math.max(1,Math.round(Number(r.interval_days||1)*(grade==="easy"?3:grade==="good"?2:1.2))));
      const due=new Date(Date.now()+(interval?interval*86400000:600000)).toISOString();
      await batch([docGuard(d.id,d.revision),guard("EXISTS(SELECT 1 FROM study_reviews WHERE annotation_id=? AND revision=?)",[aid,readerRevision(v.revision)]),statement("UPDATE study_reviews SET due_at=?,interval_days=?,repetitions=repetitions+1,revision=revision+1 WHERE annotation_id=?",[due,interval,aid])]);return {dueAt:due,intervalDays:interval};
    },
    async tags(id:string,value:unknown) {
      const v=object(value,["revision","tags"]),d=await document(id,readerRevision(v.revision));if(!Array.isArray(v.tags)||v.tags.length>30)throw new ReaderInputError("标签最多30个。");
      const unique=new Map<string,string>();for(const item of v.tags){const tag=readerText(item,60,true).normalize("NFKC").trim();unique.set(tag.toLocaleLowerCase(),tag);}const tags=[...unique.values()];
      const commands=[docGuard(id,d.revision),statement("DELETE FROM study_document_tags WHERE document_id=?",[id])];
      if(docs==="documents"){
        commands.push(statement("DELETE FROM document_tags WHERE document_id=?",[id]));
        for(const tag of tags)commands.push(statement("INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING",[tag]),statement("INSERT OR IGNORE INTO document_tags SELECT ?,id FROM tags WHERE name=?",[id,tag]));
      }else for(const tag of tags)commands.push(statement("INSERT INTO study_document_tags VALUES (?,?)",[id,tag]));
      commands.push(statement(`UPDATE ${docs} SET revision=revision+1,updated_at=? WHERE id=?`,[new Date().toISOString(),id]));
      await batch(commands);return {tags,documentRevision:d.revision+1};
    },
    async merge(value:unknown) {
      const v=object(value,["keepId","sourceId","keepRevision","sourceRevision"]),keep=await document(readerText(v.keepId,200,true),readerRevision(v.keepRevision)),source=await document(readerText(v.sourceId,200,true),readerRevision(v.sourceRevision));
      if(keep.id===source.id||keep.kind!==source.kind)throw new ReaderInputError("请选择两篇不同且同类型的资料。");
      const markdown=keep.kind==="article"?`${keep.markdown}\n\n---\n\n## 合并来源：${source.title.replace(/[\r\n]/gu," ")}\n\n来源：${source.sourceUrl}\n\n${source.markdown}`:keep.markdown;
      if(new TextEncoder().encode(markdown).length>1_500_000)throw new ReaderInputError("合并后正文过大，请手工整理。");
      const now=new Date().toISOString(),id=crypto.randomUUID();
      const beforeKeep=JSON.stringify(keep),beforeSource=JSON.stringify(source);
      // Keep new merge records restorable by the backup format.
      if(new TextEncoder().encode(JSON.stringify({id,keep_id:keep.id,source_id:source.id,before_keep_json:beforeKeep,before_source_json:beforeSource,after_keep_revision:keep.revision+1,after_source_revision:source.revision+1,undone:0,created_at:now})).length>1_800_000)throw new ReaderInputError("原记录超过可完整备份的合并上限，请改用人工关联或先拆分资料。");
      const s=[docGuard(keep.id,keep.revision),docGuard(source.id,source.revision),readyGuard(keep.id),readyGuard(source.id),statement(`INSERT INTO study_merge_history VALUES (?,?,?,?,?,?,?,0,?)`,[id,keep.id,source.id,beforeKeep,beforeSource,keep.revision+1,source.revision+1,now]),statement(`UPDATE ${docs} SET markdown=?${docs==="documents"?",markdown_edited=1":""},revision=revision+1,updated_at=? WHERE id=?`,[markdown,now,keep.id]),statement(`UPDATE ${docs} SET deleted_at=?,revision=revision+1,updated_at=? WHERE id=?`,[now,now,source.id])];
      s.push(statement(`DELETE FROM ${indexTable} WHERE document_id IN (?,?)`,[keep.id,source.id]));
      await batch(s);return {id,keepId:keep.id,sourceId:source.id,keepTitle:keep.title,sourceTitle:source.title,createdAt:now,undone:false};
    },
    async mergeHistory():Promise<MergeRecord[]> { return (await db.all("SELECT * FROM study_merge_history ORDER BY created_at DESC,id LIMIT 100",[])).map(r=>({id:String(r.id),keepId:String(r.keep_id),sourceId:String(r.source_id),keepTitle:String(JSON.parse(String(r.before_keep_json)).title),sourceTitle:String(JSON.parse(String(r.before_source_json)).title),createdAt:String(r.created_at),undone:r.undone===1})); },
    async undoMerge(id:string) {
      const r=(await db.all("SELECT * FROM study_merge_history WHERE id=?",[id]))[0];if(!r||r.undone===1)throw new ReadingDataError(409,"REVISION_CONFLICT");
      const keep=JSON.parse(String(r.before_keep_json)) as StudyDocument,source=JSON.parse(String(r.before_source_json)) as StudyDocument,now=new Date().toISOString();
      await batch([docGuard(keep.id,Number(r.after_keep_revision)),guard(`EXISTS(SELECT 1 FROM ${docs} WHERE id=? AND revision=? AND deleted_at IS NOT NULL)`,[source.id,r.after_source_revision]),statement(`UPDATE ${docs} SET markdown=?${docs==="documents"?",markdown_edited="+(keep.markdownEdited===false?0:1):""},revision=revision+1,updated_at=? WHERE id=?`,[keep.markdown,now,keep.id]),statement(`UPDATE ${docs} SET deleted_at=NULL,revision=revision+1,updated_at=? WHERE id=?`,[now,source.id]),statement(`DELETE FROM ${indexTable} WHERE document_id IN (?,?)`,[keep.id,source.id]),statement("UPDATE study_merge_history SET undone=1 WHERE id=?",[id])]);return {restored:true};
    },
  };
}
