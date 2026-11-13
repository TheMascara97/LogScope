'use strict';
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads'),path=require('node:path'),fs=require('node:fs'),readline=require('node:readline'),crypto=require('node:crypto');
let busy=false;
if(isMainThread){
 module.exports.manage=async(cache,action,options)=>{if(busy)throw Error('Wait for the current index search to finish');busy=true;try{return await require('./index-cache.cjs').manage(cache,action,options)}finally{busy=false}};
 module.exports.search=async(file,query,cache)=>{
  if(busy)throw Error('Another file search is running');
  if(typeof query!=='string'||!query.trim())throw Error('Search text is required');
  busy=true;
  try{return await new Promise((resolve,reject)=>{const w=new Worker(__filename,{workerData:{file,query,cache}});let settled=false;w.once('message',m=>{settled=true;m.error?reject(Error(m.error)):resolve(m.result)});w.once('error',reject);w.once('exit',code=>{if(!settled)reject(Error('Index worker exit '+code))})})}finally{busy=false}
 };
}else{
 (async()=>{
  const {DatabaseSync}=require('node:sqlite');const {file,query,cache}=workerData;
  const stat=await fs.promises.stat(file);await fs.promises.mkdir(cache,{recursive:true});
  const cacheTools=require('./index-cache.cjs'),policy=await cacheTools.settings(cache);await cacheTools.prune(cache,policy);
  const fingerprint=crypto.createHash('sha256').update(file+':'+stat.size+':'+stat.mtimeMs).digest('hex');
  const dbPath=path.join(cache,fingerprint+'.sqlite'),db=new DatabaseSync(dbPath);let rows=0,built=false,complete=false;
  const checkQuota=async()=>{if((await fs.promises.stat(dbPath)).size>policy.maxBytes)throw Error('Index exceeds configured cache quota; increase quota or split the source file');await cacheTools.prune(cache,policy,dbPath)};
  try{
   db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(total INTEGER); CREATE VIRTUAL TABLE IF NOT EXISTS logs USING fts5(text, tokenize='trigram');");
   const existing=db.prepare('SELECT total FROM meta').get();
   if(!existing){
    db.exec('DELETE FROM logs; BEGIN');const insert=db.prepare('INSERT INTO logs(rowid,text) VALUES(?,?)');
    const reader=require('./log-stream.cjs').boundedLines(file);
    try{for await(const line of reader){insert.run(++rows,line);if(rows%1000===0){db.exec('COMMIT; BEGIN');await checkQuota()}}}finally{await reader.return()}
    const end=await fs.promises.stat(file);if(end.size!==stat.size||end.mtimeMs!==stat.mtimeMs)throw Error('File changed while indexing; retry after capture finishes');
    db.prepare('INSERT INTO meta(total) VALUES(?)').run(rows);db.exec('COMMIT');built=true;
   }else rows=existing.total;
   let matches,count;
   if([...query].length>=3){const term='"'+query.replace(/"/g,'""')+'"';matches=db.prepare('SELECT rowid AS line,text FROM logs WHERE logs MATCH ? LIMIT 2000').all(term);count=db.prepare('SELECT count(*) AS n FROM logs WHERE logs MATCH ?').get(term).n;}
   else {const pattern='%'+query.replace(/[\\%_]/g,'\\$&')+'%';matches=db.prepare("SELECT rowid AS line,text FROM logs WHERE text LIKE ? ESCAPE '\\' LIMIT 2000").all(pattern);count=db.prepare("SELECT count(*) AS n FROM logs WHERE text LIKE ? ESCAPE '\\'").get(pattern).n;}
   await checkQuota();complete=true;
   parentPort.postMessage({result:{matches,count,scanned:rows,indexed:true,built}});
  }finally{db.close();if(!complete){await fs.promises.unlink(dbPath).catch(()=>{});}else{const now=new Date();await fs.promises.utimes(dbPath,now,now);await cacheTools.prune(cache,policy)}}
 })().catch(e=>parentPort.postMessage({error:e.message}));
}
