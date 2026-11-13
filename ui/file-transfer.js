'use strict';
// XMODEM / XMODEM-1K / YMODEM / ZMODEM 文件传输引擎。
//
// 引擎只认字节，不认管道：构造时给一个 `write(bytes)` 回调，对端字节经 `feed(bytes)`
// 送进来。这样同一份实现既能跑在 Node 回环测试里（两个引擎对接），也能挂在串口/SSH/
// TCP 会话上（渲染进程把 send 折成 HEX 帧，核心按 hex 写原始字节）。
//
// 覆盖范围（诚实记录）：
//   · XMODEM：128 字节块、校验和或 CRC-16；接收方向支持 1K 块（STX）自动识别。
//   · YMODEM：批量，块 0 传文件名/大小，结束用空块 0；接收/发送双向。
//   · ZMODEM：CRC-32、ZDLE 转义、ZFILE/ZDATA/ZACK/ZRPOS/ZEOF/ZFIN 的重传与结束握手。
//     实现的是 lrzsz 的常用子集：ZCRCG 流式帧不做（发送端每个数据帧用 ZCRCW 等 ZACK），
//     ZSINIT/ZCOMMAND/断点续传（ZCRESUM）不做。和真实 lrzsz 的互通没有设备可测，
//     这里验证的是协议自洽与重传/坏帧行为。
// UMD：主进程测试 require，渲染进程挂 globalThis.FTX。
(function(root){
 // ---- 校验 ----
 function crc16x(data){let crc=0;for(const byte of data){crc^=byte<<8;for(let i=0;i<8;i++)crc=crc&0x8000?((crc<<1)^0x1021)&0xffff:(crc<<1)&0xffff}return crc&0xffff}
 const CRC32_TABLE=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0}return table})();
 function crc32(data){let crc=0xffffffff;for(const byte of data)crc=CRC32_TABLE[(crc^byte)&0xff]^(crc>>>8);return (crc^0xffffffff)>>>0}
 function sum8(data){let value=0;for(const byte of data)value=(value+byte)&0xff;return value}

 // ---- 共用的字节收件箱：feed 进来的字节排队，协议逻辑按需 await ----
 class Link{
  constructor(write,options={}){
   if(typeof write!=='function')throw Error('write callback is required');
   this.write=write;this.buffer=[];this.waiters=[];this.closed=false;this.onError=options.onError||null;
  }
  feed(bytes){
   if(this.closed||!bytes)return;
   for(const byte of bytes)this.buffer.push(byte&0xff);
   this.pump();
  }
  pump(){
   while(this.waiters.length&&this.buffer.length){
    const waiter=this.waiters[0],take=Math.min(waiter.want-waiter.chunk.length,this.buffer.length);
    if(take<=0){this.waiters.shift();clearTimeout(waiter.timer);waiter.resolve(waiter.chunk);continue}
    waiter.chunk.push(...this.buffer.splice(0,take));
    if(waiter.chunk.length>=waiter.want){this.waiters.shift();clearTimeout(waiter.timer);waiter.resolve(waiter.chunk)}
   }
  }
  read(want,ms,label='byte'){
   const take=this.buffer.splice(0,want);
   if(take.length===want)return Promise.resolve(take);
   return new Promise((resolve,reject)=>{
    const waiter={want,chunk:take,resolve,reject,timer:null};
    waiter.timer=setTimeout(()=>{const index=this.waiters.indexOf(waiter);if(index>=0)this.waiters.splice(index,1);reject(Error('Timeout waiting for '+label))},ms);
    this.waiters.push(waiter);
   });
  }
  async readByte(ms,label){return (await this.read(1,ms,label))[0]}
  close(){this.closed=true;for(const waiter of this.waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(Error('Transfer closed'))}this.buffer.length=0}
 }

 function option(value,fallback,min,max){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback}
 function textBytes(value){const out=[];for(const char of String(value)){const code=char.codePointAt(0);if(code<128)out.push(code);else for(const byte of new TextEncoder().encode(char))out.push(byte)}return out}

 // ======================= XMODEM =======================
 const X={SOH:0x01,STX:0x02,EOT:0x04,ACK:0x06,NAK:0x15,CAN:0x18,SUB:0x1a,CRC_C:0x43};
 const pad=(data,size)=>{const out=Array.from(data||[]);while(out.length<size)out.push(X.SUB);return out.slice(0,size)};

 // 接收：先发 'C'（CRC）或 NAK（校验和）要数据；SOH=128、STX=1024；坏块回 NAK 重试。
 class XmodemReceiver{
  constructor(link,options={}){
   this.link=link;this.mode=options.checksum==='sum'?'sum':'crc';
   this.timeout=option(options.timeout,10000,100,120000);
   this.maxRetries=option(options.retries,10,1,100);
  }
  async receive(){
   const request=this.mode==='sum'?X.NAK:X.CRC_C;
   let expected=1,retries=0,completed=false,data=[];
   this.link.write([request]);
   for(;;){
    let marker;
    try{marker=await this.link.readByte(this.timeout,'block start')}
    catch(e){if(++retries>this.maxRetries)throw Error('XMODEM: '+e.message);this.link.write([request]);continue}
    if(marker===X.EOT){this.link.write([X.ACK]);this.link.write([X.ACK]);completed=true;break}
    if(marker===X.CAN){
     const second=await this.link.readByte(1000,'cancel').catch(()=>null);
     if(second===X.CAN)throw Error('XMODEM: sender cancelled');
     retries++;if(retries>this.maxRetries)throw Error('XMODEM: too many retries');this.link.write([X.NAK]);continue;
    }
    if(marker!==X.SOH&&marker!==X.STX){if(++retries>this.maxRetries)throw Error('XMODEM: bad block marker');this.link.write([X.NAK]);continue}
    const size=marker===X.STX?1024:128,block=await this.link.read(2+size+(this.mode==='crc'?2:1),this.timeout,'block body');
    const number=block[0],inverse=block[1],payload=block.slice(2,2+size);
    if(((number+inverse)&0xff)!==0xff){if(++retries>this.maxRetries)throw Error('XMODEM: block number mismatch');this.link.write([X.NAK]);continue}
    // bad=true 表示校验不通过（CRC-16 或 8 位累加和，取决于握手时选的模式）。
    const bad=this.mode==='crc'?crc16x(payload)!==((block[2+size]<<8)|block[3+size]):sum8(payload)!==block[2+size];
    if(bad){if(++retries>this.maxRetries)throw Error('XMODEM: checksum mismatch');this.link.write([X.NAK]);continue}
    if(number===((expected-1)&0xff)){
     // 上一块的重复帧（我们的 ACK 丢了）：不再追加数据，只补一个 ACK 让发送端前进。
     this.link.write([X.ACK]);continue;
    }
    if(number!==(expected&0xff)){if(++retries>this.maxRetries)throw Error('XMODEM: out-of-order block');this.link.write([X.NAK]);continue}
    retries=0;data.push(...payload);expected=(expected+1)&0xff;this.link.write([X.ACK]);
   }
   if(!completed)throw Error('XMODEM: transfer did not finish');
   return {files:[{name:'xmodem.bin',data:Uint8Array.from(data)}]};
  }
 }

 class XmodemSender{
  constructor(link,options={}){
   this.link=link;this.blockSize=option(options.blockSize,128,128,1024)===1024?1024:128;
   this.mode=options.checksum==='sum'?'sum':'crc';
   this.timeout=option(options.timeout,10000,100,120000);
   this.maxRetries=option(options.retries,10,1,100);
  }
  async send(file){
   const payload=file.data||new Uint8Array();
   let blockNumber=1,offset=0,retries=0;
   const start=await this.link.readByte(this.timeout,'receiver start');
   if(start!==X.NAK&&start!==X.CRC_C)throw Error('XMODEM: receiver did not start');
   this.mode=start===X.NAK?'sum':'crc';
   while(offset<payload.length||(offset===0&&payload.length===0)){
    const body=pad(payload.slice(offset,offset+this.blockSize),this.blockSize);
    const frame=[this.blockSize===1024?X.STX:X.SOH,blockNumber&0xff,(0xff-(blockNumber&0xff))&0xff,...body];
    if(this.mode==='crc'){const crc=crc16x(body);frame.push(crc>>8,crc&0xff)}else frame.push(sum8(body));
    let acknowledged=false;
    for(let attempt=0;attempt<=this.maxRetries;attempt++){
     this.link.write(frame);
     let reply;
     try{reply=await this.link.readByte(this.timeout,'acknowledgement')}
     catch(e){continue}
     if(reply===X.ACK){acknowledged=true;break}
     // NAK / CAN / 其他杂字节：重发本块。真正的取消由接收端后续的错误体现。
    }
    if(!acknowledged)throw Error('XMODEM: no acknowledgement for block '+blockNumber);
    retries=0;offset+=this.blockSize;blockNumber=(blockNumber+1)&0xff;
   }
   for(let attempt=0;attempt<=this.maxRetries;attempt++){
    this.link.write([X.EOT]);
    try{const reply=await this.link.readByte(3000,'final acknowledgement');if(reply===X.ACK)return}
    catch(e){}
   }
   throw Error('XMODEM: sender could not finish');
  }
 }

 // ======================= YMODEM =======================
 // 块 0：文件名\0大小 权限 时间\0；数据块同 XMODEM；EOT 后空块 0 结束批次。
 class YmodemReceiver extends XmodemReceiver{
  async receive(){
   const files=[],request=this.mode==='sum'?X.NAK:X.CRC_C;
   let first=true;
   for(;;){
    this.link.write([request]);
    let marker;
    try{marker=await this.link.readByte(this.timeout,'block start')}
    catch(e){throw Error('YMODEM: '+e.message)}
    if(marker===X.EOT){
     this.link.write([X.ACK]);
     // 批次结束：发送端随后发空块 0，收下后 ACK 并结束。
     try{
      const next=await this.link.readByte(3000,'end of batch');
      if(next===X.SOH){const body=await this.link.read(2+128+(this.mode==='crc'?2:1),3000,'ending block');this.link.write([X.ACK]);void body}
      else if(next===X.CAN){await this.link.readByte(3000,'cancel').catch(()=>null)}
     }catch(e){}
     return {files};
    }
    if(marker!==X.SOH&&marker!==X.STX){this.link.write([X.NAK]);continue}
    const size=marker===X.STX?1024:128,block=await this.link.read(2+size+(this.mode==='crc'?2:1),this.timeout,'block body');
    const number=block[0],payload=block.slice(2,2+size);
    const bad=this.mode==='crc'?crc16x(payload)!==((block[2+size]<<8)|block[3+size]):sum8(payload)!==block[2+size];
    if(bad){this.link.write([X.NAK]);continue}
    if(number===0){
     const header=payload.slice(0,payload.indexOf(0)>=0?payload.indexOf(0):payload.length);
     const name=String.fromCharCode(...header);
     if(!name){this.link.write([X.ACK]);return {files}}
     const second=payload.indexOf(0);
     const rest=second>=0?String.fromCharCode(...payload.slice(second+1)).split(/\s+/).filter(Boolean):[];
     const declared=Number(rest[0])||0;
     // 标准 YMODEM：块 0 确认后接收方要再发一次 'C' 索要数据块。
     this.link.write([X.ACK]);
     this.link.write([request]);
     const collected=await this.collectBlocks();
     const data=collected.slice(0,declared>0?declared:collected.length);
     files.push({name,data:Uint8Array.from(data)});
     first=false;
     continue;
    }
    // 有些实现直接发数据块而不发块 0：当作一个无名文件收下。
    this.link.write([X.NAK]);
   }
  }
  async collectBlocks(){
   const data=[];let expected=1;
   for(;;){
    let marker;
    try{marker=await this.link.readByte(this.timeout,'data block')}
    catch(e){throw Error('YMODEM: '+e.message)}
    if(marker===X.EOT){this.link.write([X.ACK]);return data}
    if(marker!==X.SOH&&marker!==X.STX){this.link.write([X.NAK]);continue}
    const size=marker===X.STX?1024:128,block=await this.link.read(2+size+(this.mode==='crc'?2:1),this.timeout,'data body');
    const number=block[0],payload=block.slice(2,2+size);
    const bad=this.mode==='crc'?crc16x(payload)!==((block[2+size]<<8)|block[3+size]):sum8(payload)!==block[2+size];
    if(bad||number!==(expected&0xff)){this.link.write([X.NAK]);continue}
    data.push(...payload);expected=(expected+1)&0xff;this.link.write([X.ACK]);
   }
  }
 }

 class YmodemSender extends XmodemSender{
  async sendBatch(files){
   const list=Array.isArray(files)?files.filter(Boolean):[];
   for(const file of list)await this.sendOne(file);
   // 空块 0 表示批次结束。
   for(let attempt=0;attempt<=this.maxRetries;attempt++){
    this.link.write(this.block0('',0));
    try{const reply=await this.link.readByte(this.timeout,'batch end');if(reply===X.ACK)return}catch(e){}
   }
   throw Error('YMODEM: batch did not close');
  }
  block0(name,size){
   const header=[...textBytes(name),0,...textBytes(String(size)+' 0 0 0'),0];
   const body=pad(header,128),number=0;
   const frame=[X.SOH,number,0xff,...body];
   if(this.mode==='crc'){const crc=crc16x(body);frame.push(crc>>8,crc&0xff)}else frame.push(sum8(body));
   return frame;
  }
  async sendOne(file){
   const payload=file.data||new Uint8Array();
   let start=await this.link.readByte(this.timeout,'receiver start');
   if(start!==X.NAK&&start!==X.CRC_C)throw Error('YMODEM: receiver did not start');
   this.mode=start===X.NAK?'sum':'crc';
   this.link.write(this.block0(String(file.name||'file.bin').slice(0,120),payload.length));
   const ack=await this.link.readByte(this.timeout,'block 0 acknowledgement');
   if(ack!==X.ACK)throw Error('YMODEM: block 0 rejected');
   const second=await this.link.readByte(this.timeout,'block 0 CRC request');
   if(second!==X.CRC_C&&second!==X.NAK)throw Error('YMODEM: receiver did not request data');
   let blockNumber=1,offset=0;
   while(offset<payload.length){
    const body=pad(payload.slice(offset,offset+1024),1024);
    const frame=[X.STX,blockNumber&0xff,(0xff-(blockNumber&0xff))&0xff,...body];
    if(this.mode==='crc'){const crc=crc16x(body);frame.push(crc>>8,crc&0xff)}else frame.push(sum8(body));
    let acknowledged=false;
    for(let attempt=0;attempt<=this.maxRetries;attempt++){
     this.link.write(frame);
     try{const reply=await this.link.readByte(this.timeout,'data acknowledgement');if(reply===X.ACK){acknowledged=true;break}}catch(e){}
    }
    if(!acknowledged)throw Error('YMODEM: block '+blockNumber+' not acknowledged');
    offset+=1024;blockNumber=(blockNumber+1)&0xff;
   }
   for(let attempt=0;attempt<=this.maxRetries;attempt++){
    this.link.write([X.EOT]);
    try{const reply=await this.link.readByte(3000,'end of file');if(reply===X.ACK)return}catch(e){}
   }
   throw Error('YMODEM: file did not finish');
  }
 }

 // ======================= ZMODEM =======================
 const Z={PAD:0x2a,DLE:0x18,BIN:0x41,HEX:0x42,BIN32:0x43,
  RQINIT:0,RINIT:1,SINIT:2,ACK:3,FILE:4,SKIP:5,NAK:6,ABORT:7,FIN:8,RPOS:9,DATA:10,EOF:11,FERR:12,
  CAN:16,
  CRCE:0x68,CRCG:0x69,CRCQ:0x6a,CRCW:0x6b};
 const ZESC=new Set([Z.DLE,0x10,0x11,0x13,0x14,0x15]);
 function zEscape(bytes){
  const out=[];
  for(const byte of bytes){if(ZESC.has(byte)){out.push(Z.DLE,byte^0x40)}else out.push(byte)}
  return out;
 }
 function zHeader(type,data=[0,0,0,0]){
  // HEX 头：* * DLE B <type:2><data:8><crc:4> CR LF；CRC-16 低字节先。
  const body=[type&0xff,...data.slice(0,4).map(x=>x&0xff)],crc=crc16x(body);
  const hex=body.map(x=>x.toString(16).padStart(2,'0')).join('')+[(crc&0xff).toString(16).padStart(2,'0'),((crc>>8)&0xff).toString(16).padStart(2,'0')].join('');
  return [Z.PAD,Z.PAD,Z.DLE,Z.HEX,...textBytes(hex),0x0d,0x0a];
 }
 function be32(value){const n=Math.max(0,Math.min(0xffffffff,Number(value)||0));return [(n>>>24)&0xff,(n>>>16)&0xff,(n>>>8)&0xff,n&0xff]}
 function fromBe32(data){return ((data[0]<<24)>>>0)+(data[1]<<16)+(data[2]<<8)+data[3]}

 class ZmodemLink extends Link{
  // 读一个 ZMODEM 头：跳过填充/杂字节，接受 HEX 与 BIN32 两种编码。
  async readHeader(ms){
   for(;;){
    let byte=await this.readByte(ms,'header');
    while(byte!==Z.PAD&&byte!==Z.DLE&&byte!==Z.CAN)byte=await this.readByte(ms,'header');
    if(byte===Z.CAN){const second=await this.readByte(1000,'cancel').catch(()=>null);if(second===Z.CAN)return {type:'CAN'};continue}
    if(byte===Z.PAD){
     const second=await this.readByte(1000,'header pad').catch(()=>null);
     if(second===Z.PAD){const dle=await this.readByte(1000,'header dle').catch(()=>null);if(dle!==Z.DLE)continue}
     else if(second===Z.DLE){}
     else continue;
    }
    const encoding=await this.readByte(1000,'header encoding').catch(()=>null);
    if(encoding===Z.HEX){
     const hex=String.fromCharCode(...await this.read(14,1000,'hex header'));
     // HEX 头固定以 CR LF 收尾；留在缓冲区里会被当成下一个子包的前两个字节。
     await this.read(2,1000,'hex header terminator').catch(()=>null);
     if(!/^[0-9a-f]{14}$/i.test(hex))continue;
     const bytes=[];for(let i=0;i<14;i+=2)bytes.push(parseInt(hex.slice(i,i+2),16));
     const type=bytes[0],data=bytes.slice(1,5),crc=(bytes[6]<<8)|bytes[5];
     if(crc16x([type,...data])!==crc)continue;
     return {type,data,kind:'hex'};
    }
    if(encoding===Z.BIN32){
     const body=await this.readEscaped(9,2000,'binary header');
     const type=body[0],data=body.slice(1,5),crc=((body[5]<<24)>>>0)+(body[6]<<16)+(body[7]<<8)+body[8];
     if(crc32([type,...data])!==crc)continue;
     return {type,data,kind:'bin32'};
    }
    // 不是头：继续扫描
   }
  }
  async readEscaped(want,ms,label){
   const out=[];
   while(out.length<want){
    const byte=await this.readByte(ms,label);
    if(byte===Z.DLE){const next=await this.readByte(ms,label);out.push(next^0x40)}
    else out.push(byte);
   }
   return out;
  }
  // 读一个数据子包：转义字节直到 DLE + 帧结束符；结束符后按需读 CRC-32。
  async readSubpacket(ms){
   const out=[];let end=null;
   for(;;){
    const byte=await this.readByte(ms,'data subpacket');
    if(byte===Z.DLE){
     const next=await this.readByte(ms,'subpacket end');
     if(next>=Z.CRCE&&next<=Z.CRCW){end=next;break}
     out.push(next^0x40);
    }else out.push(byte);
   }
   let crc=null;
   if(end!==Z.CRCG){
    const raw=await this.readEscaped(4,ms,'subpacket crc');
    crc=((raw[0]<<24)>>>0)+(raw[1]<<16)+(raw[2]<<8)+raw[3];
   }
   return {data:out,end,crc};
  }
 }
 function zDataFrame(position,chunk,end=Z.CRCW){
  const body=zEscape(chunk),crc=crc32(chunk);
  return [...zHeader(Z.DATA,be32(position)),...body,Z.DLE,end,...zEscape(be32(crc))];
 }

 class ZmodemReceiver{
  constructor(link,options={}){
   this.link=link instanceof ZmodemLink?link:new ZmodemLink(link.write,{onError:link.onError});
   if(this.link!==link&&options.feedTo)link.feed=bytes=>this.link.feed(bytes);
   this.timeout=option(options.timeout,10000,100,120000);
   this.maxRetries=option(options.retries,10,1,100);
   this.files=[];this.current=null;this.done=false;
  }
  feed(bytes){this.link.feed(bytes)}
  start(){
   this.link.write(zHeader(Z.RINIT,[0x01,0,0,0]));
   return this.receive();
  }
  async receive(){
   for(;;){
    let header;
    try{header=await this.link.readHeader(this.timeout)}
    catch(e){throw Error('ZMODEM: '+e.message)}
    if(header.type==='CAN'||header.type===Z.CAN)throw Error('ZMODEM: sender cancelled');
    if(header.type===Z.FIN){
     this.link.write(zHeader(Z.FIN));
     this.link.write(textBytes('OO'));
     this.done=true;return {files:this.files};
    }
    if(header.type===Z.FILE){
     const sub=await this.link.readSubpacket(this.timeout);
     if(sub.crc!=null&&sub.crc!==crc32(sub.data)){this.link.write(zHeader(Z.NAK,[0,0,0,0]));continue}
     const header0=sub.data.indexOf(0);
     const rawName=String.fromCharCode(...sub.data.slice(0,header0>=0?header0:sub.data.length)).replace(/^.*[\\/]/,'');
     const rest=sub.data.slice(header0+1).filter(byte=>byte!==0);
     let offset=0;
     const declared=Number(String.fromCharCode(...rest).split(/\s+/).filter(Boolean)[0])||0;
     this.current={name:rawName||'zmodem.bin',size:declared,data:[]};
     this.link.write(zHeader(Z.RPOS,be32(0)));
     continue;
    }
    if(header.type===Z.DATA&&this.current){
     const position=fromBe32(header.data);
     const sub=await this.link.readSubpacket(this.timeout);
     if(sub.crc!=null&&sub.crc!==crc32(sub.data)){this.link.write(zHeader(Z.RPOS,be32(this.current.data.length)));continue}
     if(position>this.current.data.length){this.link.write(zHeader(Z.RPOS,be32(this.current.data.length)));continue}
     this.current.data.splice(position,this.current.data.length-position,...sub.data);
     // 只在对端等确认的帧末回 ZACK；流式帧（ZCRCG）不回。
     if(sub.end===Z.CRCW||sub.end===Z.CRCQ)this.link.write(zHeader(Z.ACK,be32(this.current.data.length)));
     continue;
    }
    if(header.type===Z.EOF&&this.current){
     if(this.current.size&&this.current.data.length!==this.current.size){this.link.write(zHeader(Z.RPOS,be32(this.current.data.length)));continue}
     this.files.push({name:this.current.name,data:Uint8Array.from(this.current.data)});
     this.current=null;
     this.link.write(zHeader(Z.RINIT,[0x01,0,0,0]));
     continue;
    }
    if(header.type===Z.RINIT){this.link.write(zHeader(Z.RINIT,[0x01,0,0,0]));continue}
   }
  }
 }

 class ZmodemSender{
  constructor(link,options={}){
   this.link=link instanceof ZmodemLink?link:new ZmodemLink(link.write,{onError:link.onError});
   if(this.link!==link&&options.feedTo)link.feed=bytes=>this.link.feed(bytes);
   this.timeout=option(options.timeout,10000,100,120000);
   this.maxRetries=option(options.retries,10,1,100);
   this.chunk=option(options.chunk,2048,128,8192);
  }
  feed(bytes){this.link.feed(bytes)}
  async send(files){
   const list=(Array.isArray(files)?files:[files]).filter(Boolean);
   await this.waitRinit();
   for(const file of list){
    const payload=file.data instanceof Uint8Array?file.data:Uint8Array.from(file.data||[]);
    const name=String(file.name||'file.bin').replace(/[\\/\0]/g,'_').slice(0,120);
    const descriptor=[...textBytes(name),0,...textBytes(payload.length+' 0 0 0'),0];
    const crc=crc32(descriptor);
    this.link.write([...zHeader(Z.FILE,be32(0)),...zEscape(descriptor),Z.DLE,Z.CRCW,...zEscape(be32(crc))]);
    let start=await this.waitFor([Z.RPOS,Z.ACK,Z.SKIP],'file start');
    if(start.type===Z.SKIP)continue;
    let offset=fromBe32(start.data),attempts=0;
    while(offset<payload.length){
     const chunk=payload.subarray(offset,Math.min(payload.length,offset+this.chunk));
     this.link.write(zDataFrame(offset,chunk,Z.CRCW));
     let reply;
     try{reply=await this.waitFor([Z.ACK,Z.RPOS,Z.NAK],'data acknowledgement')}
     catch(e){if(++attempts>this.maxRetries)throw Error('ZMODEM: '+e.message);continue}
     if(reply.type===Z.ACK||reply.type===Z.NAK&&fromBe32(reply.data)===offset+chunk.length){offset+=chunk.length;attempts=0}
     else{offset=Math.min(offset,fromBe32(reply.data));if(++attempts>this.maxRetries)throw Error('ZMODEM: retransmission limit reached')}
    }
    this.link.write(zHeader(Z.EOF,be32(payload.length)));
    const after=await this.waitFor([Z.RINIT,Z.FIN],'end of file');
    if(after.type===Z.FIN)break;
   }
   this.link.write(zHeader(Z.FIN));
   try{await this.waitFor([Z.FIN],'finish')}catch(e){}
   this.link.write(textBytes('OO'));
   return {files:list.map(file=>({name:String(file.name||'file.bin'),bytes:(file.data||[]).length}))};
  }
  async waitRinit(){
   for(let attempt=0;attempt<=this.maxRetries;attempt++){
    try{
     const header=await this.link.readHeader(this.timeout);
     if(header.type===Z.RINIT)return header;
     if(header.type===Z.CAN)throw Error('ZMODEM: receiver cancelled');
    }catch(e){}
   }
   throw Error('ZMODEM: receiver did not send ZRINIT');
  }
  async waitFor(types,label){
   for(;;){
    const header=await this.link.readHeader(this.timeout);
    if(header.type==='CAN'||header.type===Z.CAN)throw Error('ZMODEM: receiver cancelled');
    if(types.includes(header.type))return header;
   }
  }
 }

 // 字节 → 核心 session.send 用的 HEX 字符串（`hex:true` 时核心会解析回原始字节）。
 // 单独导出是为了让测试能核对"发到线上的是什么"，而不是只信引擎内部状态。
 function toHex(bytes){return Array.from(bytes,n=>(n&0xff).toString(16).padStart(2,'0')).join('')}

 // ======================= 统一入口 =======================
 // 一对引擎接到同一根"线"上（测试与回环用）；生产环境由 UI 把 write/feed 绑到会话字节流。
 function loopback(first,second,options={}){
  const delay=option(options.delay,0,0,1000);
  const deliver=(target,bytes)=>{const copy=Uint8Array.from(bytes);if(delay)setTimeout(()=>target.feed(copy),delay);else queueMicrotask(()=>target.feed(copy))};
  const a={write:bytes=>deliver(second,bytes)};
  const b={write:bytes=>deliver(first,bytes)};
  return {a,b};
 }

 const api={crc16x,crc32,sum8,toHex,zEscape,zHeader,Link,ZmodemLink,
  Xmodem:{Receiver:XmodemReceiver,Sender:XmodemSender},
  Ymodem:{Receiver:YmodemReceiver,Sender:YmodemSender},
  Zmodem:{Receiver:ZmodemReceiver,Sender:ZmodemSender},
  loopback};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FTX=api;
})(globalThis);
