export const HOME_SCHEMA = `
CREATE TABLE home_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE home_covers (hash TEXT PRIMARY KEY CHECK(length(hash)=64), mime TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>0));
CREATE TABLE home_presentations (
 document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 featured INTEGER NOT NULL CHECK(featured IN(0,1)), position INTEGER NOT NULL,
 cover_hash TEXT REFERENCES home_covers(hash), color TEXT NOT NULL, short_title TEXT NOT NULL,
 fit TEXT NOT NULL CHECK(fit IN('contain','cover'))
);
CREATE INDEX home_presentations_order ON home_presentations(featured,position,document_id);
`;
export const HOME_COLORS = ["ochre", "rust", "sage", "sky", "paper"] as const;
export interface HomePresentation { documentId: string; featured: boolean; position: number; coverHash: string | null; color: typeof HOME_COLORS[number]; shortTitle: string; fit: "contain" | "cover" }
export interface HomeCard extends HomePresentation { title: string; folderId: string | null; folderName: string | null; createdAt: string }
export interface HomePage { revision: number; items: HomeCard[]; total: number; page: number; folders: Array<{ id: string; name: string }>; libraryTotal: number }
export interface HomeSnapshot { presentations: HomePresentation[]; covers: Array<{ hash: string; mime: string; bytes: number }> }
export const emptyHomeSnapshot = (): HomeSnapshot => ({ presentations: [], covers: [] });
export const HOME_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export class HomeError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function homePresentation(value: unknown): HomePresentation {
  const v = value as HomePresentation;
  if (!v || typeof v !== "object" || Object.keys(v).some(k => !["documentId","featured","position","coverHash","color","shortTitle","fit"].includes(k)) || typeof v.documentId !== "string" || !v.documentId || v.documentId.length > 200 || typeof v.featured !== "boolean" || !Number.isSafeInteger(v.position) || Math.abs(v.position) > 1_000_000 || !(v.coverHash === null || typeof v.coverHash === "string" && /^[a-f0-9]{64}$/.test(v.coverHash)) || !HOME_COLORS.includes(v.color) || typeof v.shortTitle !== "string" || v.shortTitle.length > 100 || /\p{Cc}/u.test(v.shortTitle) || !["contain","cover"].includes(v.fit)) throw new HomeError(400,"首页配置无效，请检查输入。");
  return { documentId:v.documentId, featured:v.featured, position:v.position, coverHash:v.coverHash, color:v.color, shortTitle:v.shortTitle.trim(), fit:v.fit };
}
export const homeColumns = "document_id AS documentId, featured, position, cover_hash AS coverHash, color, short_title AS shortTitle, fit";
export function homeFromRow(row: Record<string, unknown>) { return homePresentation({...row, featured: Boolean(row.featured)}); }
export const homeInsert = "INSERT INTO home_presentations(document_id,featured,position,cover_hash,color,short_title,fit) VALUES(?,?,?,?,?,?,?)";
export const homeValues = (v: HomePresentation) => [v.documentId,Number(v.featured),v.position,v.coverHash,v.color,v.shortTitle,v.fit];
export function parseHomeSnapshot(value: unknown, documents: Set<string>): HomeSnapshot {
  const v = value as HomeSnapshot;
  if (!v || !Array.isArray(v.presentations) || !Array.isArray(v.covers) || v.presentations.length > 10000 || v.covers.length > 10000 || Object.keys(v).some(k => k!=="presentations"&&k!=="covers")) throw new HomeError(400,"首页备份格式无效。");
  const presentations = v.presentations.map(homePresentation), ids = new Set<string>(), hashes = new Set<string>();
  for (const c of v.covers) {
    if (!c || Object.keys(c).some(k=>!["hash","mime","bytes"].includes(k)) || !/^[a-f0-9]{64}$/.test(c.hash) || c.mime!=="image/png" || !Number.isSafeInteger(c.bytes) || c.bytes<1 || c.bytes>HOME_MAX_IMAGE_BYTES || hashes.has(c.hash)) throw new HomeError(400,"封面备份格式无效。");
    hashes.add(c.hash);
  }
  for (const p of presentations) {
    if (!documents.has(p.documentId) || ids.has(p.documentId) || p.coverHash && !hashes.has(p.coverHash)) throw new HomeError(400,"首页备份缺少文章或封面。");
    ids.add(p.documentId);
  }
  return {presentations,covers:v.covers};
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function validateCover(bytes: Uint8Array) {
  const invalid = () => { throw new HomeError(400, "封面文件无效，请重新选择图片。"); };
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || bytes.length > HOME_MAX_IMAGE_BYTES || signature.some((n, i) => bytes[i] !== n)) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, hasHeader = false, hasData = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end - 4; i++) crc = crcTable[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) invalid();
    if (!hasHeader && type !== "IHDR") invalid();
    if (type === "IHDR") {
      if (hasHeader || length !== 13) invalid();
      hasHeader = true;
      const width = view.getUint32(offset + 8), height = view.getUint32(offset + 12);
      if (!width || !height || width > 1600 || height > 1600) throw new HomeError(400, "封面尺寸不能超过 1600 像素。");
    }
    if (type === "IDAT" && length > 0) hasData = true;
    if (type === "IEND") { if (length !== 0 || end !== bytes.length || !hasData) invalid(); ended = true; }
    offset = end;
  }
  if (!ended || offset !== bytes.length) invalid();
}
export interface HomeAdapter {
  documents: "documents"|"cloud_documents";
  folders: "folders"|"cloud_folders";
  all(sql:string,values:unknown[]):Promise<Record<string,unknown>[]>;
  readBatch?(statements:Array<{sql:string;values:unknown[]}>):Promise<Record<string,unknown>[][]>;
  batch(statements:Array<{sql:string;values:unknown[]}>):Promise<void>;
}
export function createHomeRepository(db:HomeAdapter) {
  const revision=async()=>Number((await db.all("SELECT revision FROM home_settings WHERE id=1",[]))[0]?.revision ?? 1);
  return {
    async list(url:URL):Promise<HomePage> {
      const page=Number(url.searchParams.get("page")||1), q=(url.searchParams.get("q")||"").trim(), folder=url.searchParams.get("folder"), manage=url.searchParams.get("manage")==="true";
      if(!Number.isSafeInteger(page)||page<1||page>100000||q.length>200)throw new HomeError(400,"首页查询无效。");
      const where=["d.kind='article'","d.deleted_at IS NULL","d.status='ready'"];
      const values:unknown[]=[];
      if(!manage)where.push("h.featured=1");
      if(q){where.push("instr(lower(d.title),lower(?))>0");values.push(q);}
      if(folder){where.push(folder==="unfiled"?"d.folder_id IS NULL":"d.folder_id=?");if(folder!=="unfiled")values.push(folder);}
      const from=`FROM ${db.documents} d LEFT JOIN home_presentations h ON h.document_id=d.id LEFT JOIN ${db.folders} f ON f.id=d.folder_id WHERE ${where.join(" AND ")}`;
      const revisionQuery={sql:"SELECT revision FROM home_settings WHERE id=1",values:[]};
      const queries=[
        revisionQuery,
        {sql:`SELECT d.id AS documentId,d.title,d.folder_id AS folderId,f.name AS folderName,d.created_at AS createdAt,h.featured,h.position,h.cover_hash AS coverHash,h.color,h.short_title AS shortTitle,h.fit ${from} ORDER BY COALESCE(h.featured,0) DESC,COALESCE(h.position,1000000),d.created_at DESC,d.id LIMIT 24 OFFSET ?`,values:[...values,(page-1)*24]},
        {sql:`SELECT COUNT(*) AS total ${from}`,values},
        {sql:`SELECT DISTINCT f.id,f.name FROM ${db.folders} f JOIN ${db.documents} d ON d.folder_id=f.id JOIN home_presentations h ON h.document_id=d.id WHERE h.featured=1 AND d.kind='article' AND d.deleted_at IS NULL AND d.status='ready' ORDER BY f.name`,values:[]},
        {sql:`SELECT 1 FROM home_presentations h JOIN ${db.documents} d ON d.id=h.document_id WHERE h.featured=1 AND d.kind='article' AND d.deleted_at IS NULL AND d.status='ready' AND d.folder_id IS NULL LIMIT 1`,values:[]},
        {sql:`SELECT COUNT(*) AS total FROM ${db.documents} WHERE kind='article' AND deleted_at IS NULL`,values:[]},
        revisionQuery,
      ];
      // One D1 batch avoids seven network round trips and reads one transaction snapshot.
      const results:Record<string,unknown>[][]=[];
      if(db.readBatch)results.push(...await db.readBatch(queries));
      else for(const query of queries)results.push(await db.all(query.sql,query.values));
      const [before,rows,totals,folders,unfiled,library,after]=results;
      const sourceRevision=Number(before[0]?.revision??1);
      if (Number(after[0]?.revision??1) !== sourceRevision) throw new HomeError(409,"首页已在其他页面更新，请重新加载。");
      return {revision:sourceRevision,page,total:Number(totals[0]?.total??0),libraryTotal:Number(library[0]?.total??0),folders:[...folders.map(f=>({id:String(f.id),name:String(f.name)})),...(unfiled.length?[{id:"unfiled",name:"未分组"}]:[])],items:rows.map((r,i)=>({documentId:String(r.documentId),title:String(r.title),folderId:r.folderId as string|null,folderName:r.folderName as string|null,createdAt:String(r.createdAt),featured:Boolean(r.featured),position:Number(r.position??100000+(page-1)*24+i),coverHash:r.coverHash as string|null,color:(r.color??HOME_COLORS[Array.from(String(r.documentId)).reduce((sum,c)=>(sum+c.charCodeAt(0))%HOME_COLORS.length,0)]) as HomePresentation["color"],shortTitle:String(r.shortTitle??""),fit:(r.fit??"contain") as "contain"|"cover"}))};
    },
    async save(value:unknown) {
      const input=value as {revision:number;changes:unknown[]};
      if(!input||!Number.isSafeInteger(input.revision)||input.revision<1||!Array.isArray(input.changes)||input.changes.length>500||Object.keys(input).some(k=>k!=="revision"&&k!=="changes"))throw new HomeError(400,"首页配置无效。");
      const entries=input.changes.map(homePresentation);
      if(new Set(entries.map(p=>p.documentId)).size!==entries.length)throw new HomeError(400,"首页文章重复。");
      if(await revision()!==input.revision)throw new HomeError(409,"首页已在其他页面更新，请重新加载。");
      const statements=[{sql:"INSERT OR IGNORE INTO home_settings(id,revision) VALUES(1,1)",values:[] as unknown[]},{sql:"SELECT CASE WHEN (SELECT revision FROM home_settings WHERE id=1)=? THEN 1 ELSE json('HOME_CONFLICT') END",values:[input.revision] as unknown[]}];
      for(const p of entries){
        statements.push({sql:`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${db.documents} WHERE id=? AND deleted_at IS NULL AND kind='article') THEN 1 ELSE json('HOME_CONFLICT') END`,values:[p.documentId]});
        statements.push({sql:homeInsert+" ON CONFLICT(document_id) DO UPDATE SET featured=excluded.featured,position=excluded.position,cover_hash=excluded.cover_hash,color=excluded.color,short_title=excluded.short_title,fit=excluded.fit",values:homeValues(p)});
      }
      statements.push({sql:"UPDATE home_settings SET revision=revision+1 WHERE id=1",values:[]});
      await db.batch(statements);return {revision:input.revision+1};
    }
  };
}

export async function captureHomeSnapshot(all:HomeAdapter["all"], ids?:string[]):Promise<HomeSnapshot> {
  const rows=await all(`SELECT ${homeColumns} FROM home_presentations${ids?" WHERE document_id IN (SELECT value FROM json_each(?))":""} ORDER BY document_id`,ids?[JSON.stringify(ids)]:[]);
  const presentations=rows.map(homeFromRow);
  const covers=await all("SELECT hash,mime,bytes FROM home_covers WHERE hash IN (SELECT value FROM json_each(?)) ORDER BY hash",[JSON.stringify(presentations.map(p=>p.coverHash).filter(Boolean))]);
  return {presentations,covers:covers.map(c=>({hash:String(c.hash),mime:String(c.mime),bytes:Number(c.bytes)}))};
}
export function homeRestoreStatements(home:HomeSnapshot) {
  return [...home.covers.map(c=>({sql:"INSERT OR IGNORE INTO home_covers(hash,mime,bytes) VALUES(?,?,?)",values:[c.hash,c.mime,c.bytes] as unknown[]})),...home.presentations.map(p=>({sql:homeInsert,values:homeValues(p)}))];
}
