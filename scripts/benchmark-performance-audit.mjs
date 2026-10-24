// Run after pnpm build: node scripts/benchmark-performance-audit.mjs [repository-root]
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const repo = resolve(process.argv[2] || process.cwd());
const {openDatabase} = await import(pathToFileURL(join(repo,'dist-server/server/db.js')));
const {createBackup} = await import(pathToFileURL(join(repo,'dist-server/server/backup.js')));
const {reconcileBackupRecords} = await import(pathToFileURL(join(repo,'dist-server/server/data-safety.js')));
const root=mkdtempSync(join(tmpdir(),'zhiye-audit-'));
const db=openDatabase(join(root,'data'));
const out={node:process.version,cpu:cpus()[0].model,scenarios:[]};
const measure=async(fn,n=15)=>{const a=[];let result;for(let i=0;i<n;i++){const t=performance.now();result=await fn();a.push(performance.now()-t);}a.sort((a,b)=>a-b);return {medianMs:+a[Math.floor(n/2)].toFixed(2),p95Ms:+a[Math.ceil(.95*n)-1].toFixed(2),samples:n};};
try{
 const insert=db.sql.prepare("INSERT INTO documents(id,source_url,title,markdown,status,capture_mode,favorite,created_at,updated_at) VALUES(?,?,?,?,'ready','http',0,?,?)");
 const body='Local knowledge 中文知识 content with punctuation. '.repeat(180);
 let previous=0;
 for(const count of [1000,10000]){
  db.sql.exec('BEGIN IMMEDIATE');
  for(let i=previous;i<count;i++)insert.run('audit-'+i,'https://example.com/'+i,'Article '+i,body+' '+i,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  db.sql.exec('COMMIT');previous=count;
  const scenario={documents:count,bodyChars:body.length,bodyUtf8Bytes:Buffer.byteLength(body),queries:{}};
  for(const [name,query] of Object.entries({recent:{},title:{q:'Article',scope:'title'},bodyHit:{q:'knowledge',scope:'body'},bodyMiss:{q:'unfindable_token_xyz',scope:'body'},literalCjk:{q:'中文知识',scope:'body'},deepPage:{page:Math.ceil(count/30)}})){
   db.listDocuments(query); scenario.queries[name]=await measure(()=>db.listDocuments(query));
  }
  const scheduled=performance.now();const timer=new Promise(r=>setTimeout(()=>r(performance.now()-scheduled),0));
  for(let i=0;i<5;i++)db.listDocuments({q:'unfindable_token_xyz',scope:'body'});
  scenario.timerDelayAcrossFiveSyncQueriesMs=+(await timer).toFixed(2);
  out.scenarios.push(scenario);
 }
 out.backup={databaseBytes:statSync(join(root,'data/zhiye.sqlite3')).size,history:[]};
 for(let i=1;i<=3;i++){
  await createBackup({dataDir:join(root,'data'),backupRoot:join(root,'backups'),database:db.sql,reason:'manual'});
  out.backup.history.push({backups:i,...await measure(()=>reconcileBackupRecords(db,join(root,'backups')),3)});
 }
 console.log(JSON.stringify(out,null,2));
}finally{db.close();rmSync(root,{recursive:true,force:true});}
