'use strict';
// 本地知识库的向量检索：不联网、不下载模型、不依赖任何二进制。
//
// 用的不是"关键词 includes"——那条路径只能命中原文里一模一样的词，日志里写
// `ERR_WDT_RESET` 而知识库写"看门狗复位"时就完全不相关。这里把每条知识（关键词 +
// 可能原因 + 排查动作 + 标签）和每条日志都映射成定长稀疏向量，再按余弦相似度排序：
//   · 拉丁字母/数字按词切分；
//   · 中日韩文字按"单字 + 相邻双字"切分（双字近似词，避免依赖分词词典）；
//   · 特征哈希（signed feature hashing）压到 512 维，TF 做 sublinear（1+log tf），
//     再乘语料 IDF 并 L2 归一化。
// 这是可复现、可测试的本地实现：同样的输入永远得到同样的分数，不需要外部服务。
// 前缀 KBV；UMD：主进程测试 require，渲染进程挂 globalThis.KBV。
(function(root){
 const DIM=512,PROTOCOL=1;
 function fnv(text){
  let h=0x811c9dc5;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0}
  return h>>>0;
 }
 // 拉丁词 + CJK 单字/双字。长度 1 的拉丁字符（a、1）区分度太低，丢弃；数字串保留，
 // 因为错误码（E1042、0x5A）恰恰靠它。
 function tokens(text){
  const source=String(text==null?'':text).toLowerCase(),out=[];
  for(const word of source.match(/[a-z0-9_@.#:/\\-]{2,}/g)||[])out.push(word);
  for(const run of source.match(/[㐀-鿿]+/g)||[]){
   for(let i=0;i<run.length;i++){out.push(run[i]);if(i+1<run.length)out.push(run.slice(i,i+2))}
  }
  return out;
 }
 function termCounts(text){
  const counts=new Map();
  for(const token of tokens(text))counts.set(token,(counts.get(token)||0)+1);
  return counts;
 }
 function hashVector(counts,idf,dim){
  const vector=new Float64Array(dim);
  for(const [token,count] of counts){
   const h=fnv(token),index=h%dim,weight=(1+Math.log(count))*(idf&&idf.has(token)?idf.get(token):1);
   vector[index]+=((h>>>31)&1)?-weight:weight;
  }
  let norm=0;for(const value of vector)norm+=value*value;
  if(norm>0){norm=Math.sqrt(norm);for(let i=0;i<dim;i++)vector[i]/=norm}
  return vector;
 }
 function entryText(entry){
  const tags=Array.isArray(entry.tags)?entry.tags.join(' '):(entry.tags||'');
  return [entry.keyword||'',entry.cause||'',entry.action||'',tags].join('\n');
 }
 // 建索引：DF 只在知识条目之间统计（日志行是查询，不参与 IDF，否则每次查询都会
 // 改变历史条目的权重，同一份知识在不同会话里给出不同排序）。
 function buildIndex(entries,dim=DIM){
  const rows=(Array.isArray(entries)?entries:[]).filter(entry=>entry&&typeof entry.keyword==='string'&&entry.keyword.trim());
  const df=new Map();
  const counts=rows.map(entry=>{const c=termCounts(entryText(entry));for(const token of c.keys())df.set(token,(df.get(token)||0)+1);return c});
  const total=Math.max(1,rows.length),idf=new Map();
  for(const [token,frequency] of df)idf.set(token,Math.log((total+1)/(frequency+0.5))+1);
  return {
   protocol:PROTOCOL,dim,total,
   idf,
   items:rows.map((entry,index)=>({entry,index,vector:hashVector(counts[index],idf,dim)}))
  };
 }
 function queryVector(index,text){
  if(!index||!index.idf)return new Float64Array(index?.dim||DIM);
  return hashVector(termCounts(text),index.idf,index.dim);
 }
 function cosine(a,b){
  let dot=0;
  for(let i=0;i<a.length;i++)dot+=a[i]*b[i];
  // 两个向量都已 L2 归一化，点积即余弦；哈希符号可能让余弦为负，这里不上截断，
  // 由调用方决定阈值——截断会掩盖"完全不相关"与"轻微相关"的区别。
  return dot;
 }
 // 检索：返回按相似度降序的前 limit 条，附带命中词（便于解释为什么排在这里）。
 // 解释性很重要：一个不说明理由的相似度分数在排障时没法核对。
 function search(index,text,options={}){
  if(!index||!index.items.length)return [];
  const limit=Math.max(1,Math.min(200,Number(options.limit)||20));
  const threshold=Number.isFinite(options.threshold)?options.threshold:0;
  const vector=queryVector(index,text);
  const queryTokens=new Set(tokens(text));
  const scored=[];
  for(const item of index.items){
   const score=cosine(vector,item.vector);
   const matched=[...new Set(tokens(entryText(item.entry)).filter(token=>queryTokens.has(token)))].slice(0,12);
   // 特征哈希会有碰撞：两个毫无共同词的条目也可能因为落进同一维而得到一个小正分。
   // 没有词面重叠就不算命中——这样阈值只管"要多少重叠"，不会把碰撞当成相关。
   if(!matched.length||!(score>threshold))continue;
   scored.push({...item.entry,score:Math.round(score*10000)/10000,matched});
  }
  scored.sort((a,b)=>b.score-a.score||String(a.keyword).localeCompare(String(b.keyword)));
  return scored.slice(0,limit);
 }
 // 日志 → 知识命中：逐行打分并保留最高分与证据行。把最近 N 行拼成一个大字符串会让
 // 每条知识都和“整段日志”比一次，长会话里无关词互相稀释，排序几乎不变；逐行比才能
 // 指出"是哪一行触发的"。
 function matchRows(index,rows,options={}){
  const list=Array.isArray(rows)?rows:[];
  const limit=Math.max(1,Math.min(100,Number(options.limit)||20));
  const threshold=Number.isFinite(options.threshold)?options.threshold:0.08;
  const best=new Map();
  for(const row of list){
   const text=typeof row==='string'?row:(row&&row.text)||'';
   if(!text)continue;
   const vector=queryVector(index,text),queryTokens=new Set(tokens(text));
   for(const item of index.items){
    const score=cosine(vector,item.vector);
    // 与 search 同一规则：没有词面重叠就不算命中，避免哈希碰撞制造假阳性。
    if(!(score>threshold))continue;
    if(!tokens(entryText(item.entry)).some(token=>queryTokens.has(token)))continue;
    const previous=best.get(item.index);
    if(!previous||score>previous.score){
     best.set(item.index,{...item.entry,score:Math.round(score*10000)/10000,row,text:String(text).slice(0,500)});
    }
   }
  }
  return [...best.values()].sort((a,b)=>b.score-a.score).slice(0,limit);
 }
 // 校验知识条目：编辑器的 JSON 直接落进 localStorage，这里做一次结构校验，
 // 免得一条 `null` 让整个索引在下次检索时抛错。
 function validate(entries){
  if(!Array.isArray(entries))throw Error('Knowledge base must be a JSON array');
  if(entries.length>2000)throw Error('Knowledge base is limited to 2000 entries');
  for(const [index,entry] of entries.entries()){
   if(!entry||typeof entry!=='object')throw Error('Entry '+index+' is not an object');
   if(typeof entry.keyword!=='string'||!entry.keyword.trim())throw Error('Entry '+index+' has no keyword');
   for(const key of ['cause','action'])if(entry[key]!=null&&typeof entry[key]!=='string')throw Error('Entry '+index+' field '+key+' must be text');
   if(entry.tags!=null&&!Array.isArray(entry.tags)&&typeof entry.tags!=='string')throw Error('Entry '+index+' tags must be text or an array');
  }
  return entries;
 }
 const api={DIM,PROTOCOL,tokens,termCounts,buildIndex,queryVector,cosine,search,matchRows,validate};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.KBV=api;
})(globalThis);
