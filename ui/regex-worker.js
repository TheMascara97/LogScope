'use strict';
// patterns/texts 之外可选两个字段：
//   flags  —— 正则标志，缺省 'i'（历史行为：不区分大小写）；
//   ranges —— true 时 result[i] 是命中明细 {i:模式下标,s:起,e:止} 列表，而不是模式下标列表。
// 两种格式的"空数组 = 未命中"语义一致，所以用 matches[i].length 做布尔判断的旧调用方
// （filteredRowsAsync）不受影响；用 matches[i].includes(0) 的实时规则路径不传 ranges，格式不变。
function matchRegex({patterns,texts,flags,ranges}){
 const base=typeof flags==='string'?flags:'i';
 if(!ranges){
  const expressions=patterns.map(pattern=>new RegExp(pattern,base));
  return texts.map(text=>expressions.flatMap((re,i)=>re.test(text)?[i]:[]));
 }
 const expressions=patterns.map(pattern=>new RegExp(pattern,base.includes('g')?base:base+'g'));
 return texts.map(text=>{
  const out=[];
  for(let i=0;i<expressions.length&&out.length<200;i++){
   const re=expressions[i];re.lastIndex=0;
   let m;
   while((m=re.exec(text))&&out.length<200){
    if(m[0].length)out.push({i,s:m.index,e:m.index+m[0].length});
    else re.lastIndex=m.index+1; // 零宽命中必须手动前进，否则死循环
   }
  }
  return out;
 });
}
if(typeof require==='function'){const {parentPort}=require('node:worker_threads');parentPort.on('message',data=>{try{parentPort.postMessage({result:matchRegex(data)})}catch(e){parentPort.postMessage({error:e.message})}})}else self.onmessage=({data})=>{try{self.postMessage({result:matchRegex(data)})}catch(e){self.postMessage({error:e.message})}};
