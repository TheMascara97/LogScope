'use strict';
const {boundedLines}=require('./log-stream.cjs');
// 上限与 regex-runner 的 REGEX_MAX_TEXTS/REGEX_MAX_TOTAL_CHARS 联动：导入多少行，查询过滤
// 就要能一次性扫多少行，否则大文件导入后一搜索就被 worker 以 "safety limit" 拒绝。
async function preview(file,{maxLines=300000,maxBytes=48*1024*1024}={}){
 const reader=boundedLines(file);
 let lines=[],bytes=0,total=0,truncated=false;
 try{for await(const line of reader){total++;if(lines.length<maxLines&&bytes+Buffer.byteLength(line)<maxBytes){lines.push(line);bytes+=Buffer.byteLength(line)+1}else{truncated=true;break;}}}
 finally{await reader.return();}
 return {path:file,text:lines.join('\n'),previewLines:lines.length,truncated};
}
async function search(file,query){
 if(typeof query!=='string'||!query.trim())throw Error('Search text is required');
 const reader=boundedLines(file);
 const matches=[];let lineNumber=0,count=0;
 try{for await(const line of reader){lineNumber++;if(line.toLowerCase().includes(query.toLowerCase())){count++;if(matches.length<2000)matches.push({line:lineNumber,text:line.slice(0,65536)})}}}finally{await reader.return()}
 return {matches,count,scanned:lineNumber};
}
module.exports={preview,search};
