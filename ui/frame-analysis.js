'use strict';
// 二进制协议帧分析器：离线、无依赖，只做字节到结构化值的确定性换算。
//
// 三层能力：
//   · analyze(text, template) —— 按模板切字段、取校验、逐项核对
//   · build(template, values) —— 反向组帧，用来做往返验证和构造测试帧
//   · scan(text, options)     —— 从一段流里按边界符/转义切出完整帧
// 字段类型覆盖排障里常见的几种：无符号/有符号整数、浮点、ASCII、BCD、位域。
// 所有上限都是显式的（帧 ≤64 KiB、位域 ≤64 位、字段 ≤256 个），越界一律抛错而不是截断：
// 分析器静默给出错误值时比报错更危险。
(function(root){
 function bytes(text){
  const normalized=String(text).replace(/0x/gi,'').replace(/[\s,:-]/g,'');
  if(!normalized||normalized.length%2||!/^[0-9a-f]+$/i.test(normalized))throw Error('Expected complete hexadecimal bytes');
  if(normalized.length>131072)throw Error('Frame exceeds 64 KiB');
  return Uint8Array.from(normalized.match(/../g),x=>parseInt(x,16));
 }
 function integer(value,label,min,max){const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw Error(label+' is out of range');return n}

 // ---- 校验算法 ----
 // 每个算法都对着公开测试向量验证过（见 frame-analysis.test.cjs）：这类实现最容易
 // 在初值/反射/异或输出三处出错，而错误结果看起来又是一个"合法"的 16 位数。
 const CRC8_TABLE=(()=>{const table=new Uint8Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&0x80?((c<<1)^0x07)&0xff:(c<<1)&0xff;table[n]=c}return table})();
 function checksum(data,algorithm){
  const list=Array.from(data,n=>n&0xff);
  if(algorithm==='sum8'){let v=0;for(const b of list)v=(v+b)&0xff;return v}
  if(algorithm==='lrc'){let v=0;for(const b of list)v=(v+b)&0xff;return (0x100-v)&0xff}
  if(algorithm==='xor8'){let v=0;for(const b of list)v^=b;return v}
  if(algorithm==='crc8'){let v=0;for(const b of list)v=CRC8_TABLE[v^b];return v}
  if(algorithm==='fletcher16'){let a=0,b=0;for(const byte of list){a=(a+byte)%255;b=(b+a)%255}return (b<<8)|a}
  if(algorithm==='adler32'){let a=1,b=0;for(const byte of list){a=(a+byte)%65521;b=(b+a)%65521}return ((b<<16)|a)>>>0}
  if(algorithm==='crc16-modbus'||algorithm==='crc16-ccitt'||algorithm==='crc16-xmodem'||algorithm==='crc32'){
   // 两种移位方向不能混：MODBUS 与 CRC-32 是反射多项式（0xA001 / 0xEDB88320，右移），
   // CCITT-FALSE 与 XMODEM 是非反射的 0x1021（左移）。用错方向得到的仍是一个"看起来
   // 合法"的 16 位数，所以这里分开算，测试也分开对向量。
   if(algorithm==='crc16-ccitt'||algorithm==='crc16-xmodem'){
    // 非反射 0x1021，初值区分两者：CCITT-FALSE 用 0xFFFF，XMODEM 用 0x0000。
    // 校验向量分别是 "123456789" → 0x29B1 / 0x31C3。
    let value=algorithm==='crc16-ccitt'?0xffff:0;
    for(const byte of list){
     value^=byte<<8;
     for(let i=0;i<8;i++)value=value&0x8000?((value<<1)^0x1021)&0xffff:(value<<1)&0xffff;
    }
    return value;
   }
   let value=algorithm==='crc32'?0xffffffff:0xffff;
   for(const byte of list){
    value^=byte;
    for(let i=0;i<8;i++)value=value&1?(value>>>1)^(algorithm==='crc32'?0xedb88320:0xa001):value>>>1;
    value=algorithm==='crc32'?value>>>0:value&0xffff;
   }
   return algorithm==='crc32'?(value^0xffffffff)>>>0:value;
  }
  throw Error('Unsupported checksum');
 }
 const ALGORITHM_BYTES={sum8:1,lrc:1,xor8:1,crc8:1,'crc16-modbus':2,'crc16-ccitt':2,'crc16-xmodem':2,fletcher16:2,adler32:4,crc32:4};

 // 大小端读整数（≤64 位用 BigInt，避免 2^53 之后悄悄失真）
 function readUnsigned(raw,endian){let value=0n;for(const b of endian==='little'?[...raw].reverse():raw)value=(value<<8n)|BigInt(b);return value}
 function readSigned(raw,endian){const bits=BigInt(raw.length*8),unsigned=readUnsigned(raw,endian),half=1n<<(bits-1n);return unsigned>=half?unsigned-(1n<<bits):unsigned}
 function readFloat(raw,endian){const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);return raw.length===4?view.getFloat32(0,endian==='little'):view.getFloat64(0,endian==='little')}

 // 位域：按「帧内 MSB-first 位流」解释，start = offset*8 + bitOffset。
 // 选这个方向是因为设备手册里的位图几乎都按 MSB-first 画；给小端帧用位域时，
 // 手册里的位号本身就是从高位数起的那一套。
 function readBits(data,offset,bitOffset,total){
  let value=0n;
  for(let i=0;i<total;i++){
   const position=offset*8+bitOffset+i,byte=data[position>>3];
   if(byte===undefined)throw Error('Bit field exceeds frame');
   value=(value<<1n)|BigInt((byte>>(7-(position&7)))&1);
  }
  return value;
 }

 function analyze(text,template={}){
  const data=bytes(text);
  if(template.length!==undefined&&template.length!==''){const n=integer(template.length,'Length',1,65536);if(data.length!==n)throw Error('Length mismatch: expected '+n+', received '+data.length)}
  const templateFields=Array.isArray(template.fields)?template.fields:[];
  if(templateFields.length>256)throw Error('Too many fields (max 256)');
  const fields=templateFields.map(field=>{
   const name=String(field.name||'field'),type=field.type||'uint',endian=field.endian||'big';
   if(!['uint','int','float','ascii','bcd','bits'].includes(type))throw Error('Unsupported field type: '+type);
   if(!['little','big'].includes(endian))throw Error('Invalid byte order');
   const offset=integer(field.offset,'Offset',0,Math.max(0,data.length-1));
   if(type==='bits'){
    const bitOffset=integer(field.bitOffset??0,'Bit offset',0,7),bits=integer(field.size,'Bit count',1,64);
    const value=readBits(data,offset,bitOffset,bits);
    const position=offset*8+bitOffset;
    return {name,type,offset,bitOffset,bits,hex:[...data.slice(position>>3,Math.ceil((position+bits)/8))].map(x=>x.toString(16).padStart(2,'0')).join(' '),value:value.toString()};
   }
   const size=integer(field.size,'Size',1,64);
   if(offset+size>data.length)throw Error('Field exceeds frame: '+name);
   const raw=data.slice(offset,offset+size);
   const hex=[...raw].map(x=>x.toString(16).padStart(2,'0')).join(' ');
   let value;
   if(type==='ascii')value=new TextDecoder('ascii').decode(raw).replace(/\0+$/,'');
   else if(type==='bcd'){
    if(size>16)throw Error('BCD field too long');
    // 半字节 >9 不是 BCD。先转换成两位十六进制再查，避免 "1A" 被拼成 "1a" 后
    // 只在文本层面判断而漏掉大小写差异。
    const nibbles=[...raw].map(x=>(x>>4).toString(16)+(x&15).toString(16)).join('');
    if(/[a-f]/i.test(nibbles))throw Error('Field is not valid BCD: '+name);
    value=nibbles;
   }
   else if(type==='float'){if(size!==4&&size!==8)throw Error('Float fields must be 4 or 8 bytes');value=readFloat(raw,endian)}
   else if(type==='int')value=readSigned(raw,endian).toString();
   else value=readUnsigned(raw,endian).toString();
   return {name,type,offset,size,endian,hex,value};
  });
  let check=null;
  if(template.checksum&&template.checksum.algorithm!=='none'){
   const c=template.checksum,algorithm=c.algorithm,size=ALGORITHM_BYTES[algorithm];
   if(!size)throw Error('Unsupported checksum');
   const start=integer(c.start,'Checksum start',0,data.length-1),end=integer(c.end,'Checksum end (exclusive)',start+1,data.length),offset=integer(c.offset,'Checksum offset',0,data.length-1);
   if(offset+size>data.length||(offset<end&&offset+size>start))throw Error('Invalid checksum location or covered range');
   const endian=c.endian||'little';
   if(!['little','big'].includes(endian))throw Error('Invalid checksum byte order');
   const stored=Number(readUnsigned(data.slice(offset,offset+size),endian));
   const calculated=checksum(data.slice(start,end),algorithm);
   check={algorithm,offset,size,endian,stored,calculated,valid:stored===calculated};
  }
  return {length:data.length,fields,checksum:check};
 }

 // 反向组帧：analyze 的逆运算（校验位自动回填）。给测试构造帧，也给用户验证模板。
 // 只支持整数/ASCII/BCD/位域——浮点和带符号数的组帧在排障里几乎用不到，
 // 少一条没人验证的路径比多一条好。
 function build(template={},values={}){
  const length=integer(template.length||0,'Length',0,65536);
  if(!length)throw Error('Build requires template.length');
  const data=new Uint8Array(length);
  for(const field of template.fields||[]){
   const name=String(field.name||'field');
   if(!(name in values))continue;
   const type=field.type||'uint',endian=field.endian||'big',offset=integer(field.offset,'Offset',0,length-1);
   if(type==='bits'){
    const bitOffset=integer(field.bitOffset??0,'Bit offset',0,7),bits=integer(field.size,'Bit count',1,64);
    const value=BigInt(values[name]);
    if(value<0n||value>=(1n<<BigInt(bits)))throw Error('Value out of range for '+name);
    for(let i=0;i<bits;i++){
     const position=offset*8+bitOffset+i,bit=Number((value>>BigInt(bits-1-i))&1n);
     if(position>>3>=length)throw Error('Bit field exceeds frame: '+name);
     data[position>>3]=bit?data[position>>3]|(1<<(7-(position&7))):data[position>>3]&~(1<<(7-(position&7)));
    }
    continue;
   }
   const size=integer(field.size,'Size',1,64);
   if(offset+size>length)throw Error('Field exceeds frame: '+name);
   if(type==='ascii'){
    const encoded=new TextEncoder().encode(String(values[name])).slice(0,size);
    data.set(encoded,offset);
   }else if(type==='bcd'){
    const text=String(values[name]).padStart(size*2,'0');
    if(!/^\d+$/.test(text)||text.length>size*2)throw Error('Invalid BCD value for '+name);
    for(let i=0;i<size;i++)data[offset+i]=parseInt(text.slice(i*2,i*2+2),16);
   }else{
    const value=BigInt(values[name]);
    const bits=BigInt(size*8),limit=1n<<bits;
    if(value<0n||value>=limit)throw Error('Value out of range for '+name);
    for(let i=0;i<size;i++){
     const byte=Number((value>>BigInt(8*i))&0xffn);
     // i 是数值里的字节序（第 0 个 = 最低位），落到帧里要按 endian 摆：
     // 小端 low-byte 在前 → offset+i；大端 high-byte 在前 → offset+size-1-i。
     data[endian==='little'?offset+i:offset+size-1-i]=byte;
    }
   }
  }
  if(template.checksum&&template.checksum.algorithm!=='none'){
   const c=template.checksum,size=ALGORITHM_BYTES[c.algorithm];
   if(!size)throw Error('Unsupported checksum');
   const start=integer(c.start,'Checksum start',0,length-1),end=integer(c.end,'Checksum end (exclusive)',start+1,length),offset=integer(c.offset,'Checksum offset',0,length-1);
   if(offset+size>length||(offset<end&&offset+size>start))throw Error('Invalid checksum location or covered range');
   const endian=c.endian||'little',value=checksum(data.slice(start,end),c.algorithm);
   var checkValue=value;
   for(let i=0;i<size;i++)data[endian==='little'?offset+i:offset+size-1-i]=Math.floor(checkValue/Math.pow(256,i))&0xff;
  }
  return data;
 }

 // 从流里切帧。两种边界：固定 SOF + 可选长度字段，或成对的分隔符（如 7E ... 7E）。
 // 转义按「转义字节后一位异或 0x20」处理（HDLC/PPP 那套）；不做比特填充。
 function scan(text,options={}){
  const source=bytes(text);
  const frames=[];
  const delimiter=options.delimiter===undefined?null:(typeof options.delimiter==='string'?parseInt(options.delimiter.replace(/^0x/i,''),16):Number(options.delimiter));
  const escape=options.escape===undefined?null:(typeof options.escape==='string'?parseInt(options.escape.replace(/^0x/i,''),16):Number(options.escape));
  const xor=options.xor===undefined?0x20:Number(options.xor);
  const max=integer(options.maxFrames??256,'Max frames',1,4096);
  const unescape=slice=>{
   if(escape===null)return Uint8Array.from(slice);
   const out=[];
   for(let i=0;i<slice.length;i++){
    if(slice[i]!==escape){out.push(slice[i]);continue}
    const next=slice[i+1];
    if(next===undefined)break;
    out.push((next^xor)&0xff);i++;
   }
   return Uint8Array.from(out);
  };
  if(delimiter!==null&&!Number.isInteger(delimiter))throw Error('Invalid delimiter');
  if(delimiter!==null){
   let start=-1;
   for(let i=0;i<source.length;i++){
    if(source[i]!==delimiter)continue;
    if(start<0){start=i;continue}
    const payload=source.slice(start+1,i);
    // 共享分隔符时（...7E 7E...）中间会切出一个空帧；那是帧间噪声，不是帧。
    if(payload.length)frames.push({start,length:payload.length,data:unescape(payload)});
    if(frames.length>=max)break;
    // 一个分隔符同时是上一帧的结束和下一帧的开始（常见的 7E 共享写法）。
    start=i;
   }
   return frames;
  }
  // SOF + 长度字段：lengthOffset 指向长度字节，lengthAdjust 是「长度值 → 需要向后读的
  // 字节数」的差值（有的协议长度不含头，有的含）。
  const sof=options.sof===undefined?null:(typeof options.sof==='string'?parseInt(options.sof.replace(/^0x/i,''),16):Number(options.sof));
  if(sof===null)throw Error('scan requires a delimiter or a SOF byte');
  const lengthOffset=integer(options.lengthOffset??-1,'Length offset',-1,4096);
  if(lengthOffset<0)throw Error('scan requires lengthOffset when using SOF');
  for(let i=0;i<source.length;i++){
   if(source[i]!==sof)continue;
   if(i+lengthOffset>=source.length)break;
   const declared=source[i+lengthOffset]+(options.lengthBytes===2?(source[i+lengthOffset+1]<<8):0);
   const total=declared+(options.lengthAdjust??0);
   if(total<=0)continue;
   if(i+total>source.length)break;
   frames.push({start:i,length:total,data:unescape(source.slice(i,i+total))});
   if(frames.length>=max)break;
   i+=total-1;
  }
  return frames;
 }

 // 把分析结果转成便于展示/复制的文本（UI 用；主进程也可以直接调）
 function report(result){
  const lines=[];
  for(const field of result.fields)lines.push(field.name.padEnd(16)+' @'+String(field.offset).padStart(3)+(field.size?(' +'+field.size):'')+'  '+field.value+(field.hex?'   ['+field.hex+']':''));
  if(result.checksum)lines.push('checksum'.padEnd(16)+' '+result.checksum.algorithm+'  stored='+result.checksum.stored+'  calculated='+result.checksum.calculated+'  '+(result.checksum.valid?'OK':'MISMATCH'));
  return lines.join('\n');
 }

 const api={bytes,checksum,analyze,build,scan,report,ALGORITHM_BYTES};
 if(typeof module!=='undefined')module.exports=api;else root.FrameAnalysis=api;
})(globalThis);
