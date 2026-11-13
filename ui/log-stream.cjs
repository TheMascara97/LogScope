'use strict';
const fs=require('node:fs');
// A missing newline must not let readline retain an arbitrarily large file in RAM.
async function* boundedLines(file,{maxLineChars=1024*1024}={}){
 const source=fs.createReadStream(file,{encoding:'utf8',highWaterMark:65536});let pending='';
 const check=text=>{if(text.length>maxLineChars)throw Error('Log line exceeds safety limit / 单行日志超过安全限制 ('+maxLineChars+' characters)')};
 try{for await(const chunk of source){pending+=chunk;let at=0,match;const newline=/\r\n|\r|\n/g;while((match=newline.exec(pending))){if(match[0]==='\r'&&newline.lastIndex===pending.length)break;const line=pending.slice(at,match.index);check(line);yield line;at=newline.lastIndex;}pending=pending.slice(at);check(pending);}if(pending){check(pending);yield pending.endsWith('\r')?pending.slice(0,-1):pending;}}
 finally{source.destroy()}
}
module.exports={boundedLines};
