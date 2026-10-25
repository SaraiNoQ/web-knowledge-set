import type { StudyAdapter, StudyDocument } from "./study-types.js";
export function studyAdapter(sql:Omit<StudyAdapter,"document">):StudyAdapter {
  const docs=sql.documentsTable,prefix=docs==="documents"?"":"cloud_",cache=new Map<string,Promise<StudyDocument|null>>();
  const document = (id:string):Promise<StudyDocument|null> => {
    const known=cache.get(id);if(known)return known;
    const result=(async()=>{
      const r=(await sql.all(`SELECT id,title,source_url,kind,revision,deleted_at,folder_id,markdown${docs==="documents"?",markdown_edited":""} FROM ${docs} WHERE id=?`,[id]))[0];if(!r)return null;
      const rows=await sql.all(`SELECT tag FROM study_document_tags WHERE document_id=?${docs==="documents"?" UNION SELECT t.name AS tag FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=?":""}`,[id,...(docs==="documents"?[id]:[])]);
      const d:StudyDocument={id,title:String(r.title),sourceUrl:String(r.source_url),kind:r.kind as StudyDocument["kind"],revision:Number(r.revision),deletedAt:r.deleted_at==null?null:String(r.deleted_at),folderId:r.folder_id==null?null:String(r.folder_id),markdown:String(r.markdown),tags:rows.map(t=>String(t.tag))};
      if(docs==="documents")d.markdownEdited=r.markdown_edited===1;
      if(d.kind==="paper") {
        const pages=await sql.all(`SELECT pp.page_number,pp.original_json FROM ${prefix}paper_pages pp JOIN ${prefix}papers p ON p.id=pp.paper_id AND p.extraction_id=pp.extraction_id WHERE p.id=? ORDER BY pp.page_number`,[id]);
        d.sections=pages.map(p=>({source:"paper-original" as const,pageNumber:Number(p.page_number),text:(JSON.parse(String(p.original_json)) as Array<{original?:string}>).map(b=>b.original??"").filter(Boolean).join("\n")}));
      }
      return d;
    })();cache.set(id,result);if(cache.size>8)cache.delete(cache.keys().next().value!);return result;
  };
  return {...sql,document,run:async(q,v)=>{try{return await sql.run(q,v);}finally{cache.clear();}},batch:async(s)=>{try{await sql.batch(s);}finally{cache.clear();}}};
}
