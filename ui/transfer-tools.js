'use strict';
// X/Y/ZModem 传输面板：把 file-transfer.js 的引擎挂到当前会话的字节流上。
//
// 接线方式：
//   发送方向 —— 引擎 write(bytes) → `session.send {hex,raw}`；`raw` 让核心不追加行尾
//                （否则 CR 会插在块中间，每一帧都被 NAK）。
//   接收方向 —— 核心的 `terminal` 事件给的是 base64 原始字节，原样喂给引擎。
// 引擎状态机本身是异步的；这里只做接线和界面，不碰协议。
// transferButton/localize 的包装必须用唯一名字：ui/*.js 共享一个全局作用域。
function openTransferPanel(){return new Promise(resolve=>{
 const session=typeof active==='string'?active:'';
 const label=sessions.get(session)||session;
 const dialog=document.createElement('dialog');dialog.id='transferPanel';dialog.className='manager-dialog';
 const title=document.createElement('h3'),target=document.createElement('p'),hint=document.createElement('p'),log=document.createElement('pre');
 const row=document.createElement('div'),protocol=document.createElement('select'),blockSize=document.createElement('select'),action=document.createElement('select');
 const start=document.createElement('button'),stop=document.createElement('button'),close=document.createElement('button'),progress=document.createElement('progress');
 const note=(message)=>{log.textContent+=message+'\n';log.scrollTop=log.scrollHeight};
 title.textContent=uiText('文件传输（X/Y/ZModem）','File transfer (X/Y/ZModem)');
 target.textContent=session?uiText('会话：','Session: ')+label:uiText('没有活动会话','No active session');
 hint.textContent=uiText('通过当前会话的原始字节流传输文件；串口会话请先让设备进入接收/发送状态。接收到的文件在完成时询问保存位置。','Transfers over the current session\'s raw byte stream. For serial, put the device into receive/send mode first. Received files ask where to save when complete.');
 for(const [value,text] of [['xmodem','XMODEM'],['xmodem1k','XMODEM-1K'],['ymodem','YMODEM（批量）'],['zmodem','ZMODEM']])protocol.append(new Option(text,value));
 for(const [value,text] of [['crc','CRC-16 校验'],['sum','8 位累加和']])blockSize.append(new Option(text,value));
 for(const [value,text] of [['send','发送文件'],['receive','接收文件']])action.append(new Option(text,value));
 protocol.value='ymodem';blockSize.value='crc';action.value='send';
 start.textContent=uiText('开始','Start');stop.textContent=uiText('中止','Abort');stop.disabled=true;
 close.textContent=uiText('关闭','Close');
 progress.max=100;progress.value=0;progress.style.width='100%';
 row.append(protocol,blockSize,action);
 log.style.maxHeight='220px';log.style.overflow='auto';log.textContent='';
 const state={running:false,engine:null,link:null,detach:null,aborted:false};

 // 把「这个会话的字节流」包成一个 FTX.Link：write 走核心，feed 由 terminal 事件驱动。
 const attach=()=>{
  const link=new FTX.Link(bytes=>{
   window.core.send({type:'session.send',session,data:FTX.toHex(bytes),hex:true,raw:true,exec:true,auditBytes:bytes.length});
  });
  state.link=link;
  const listener=message=>{if(message.type!=='terminal'||message.session!==session||state.aborted)return;
   const raw=Uint8Array.from(atob(message.data||''),c=>c.charCodeAt(0));link.feed(raw)};
  onCoreEvent(listener);
  state.detach=()=>{const index=coreListeners.indexOf(listener);if(index>=0)coreListeners.splice(index,1)};
  return link;
 };

 const finish=(message)=>{state.running=false;start.disabled=false;stop.disabled=true;if(state.detach)state.detach();state.detach=null;note(message)};

 const send=async()=>{
  const file=await window.core.transferPick();if(!file)return;
  const data=Uint8Array.from(Buffer.from(file.data,'base64'));
  const link=attach();
  const options={timeout:15000,retries:8};
  let engine;
  if(protocol.value==='xmodem'||protocol.value==='xmodem1k'){
   engine=new FTX.Xmodem.Sender(link,{...options,blockSize:protocol.value==='xmodem1k'?1024:128,checksum:blockSize.value});
  }else if(protocol.value==='ymodem'){
   engine=new FTX.Ymodem.Sender(link,{...options,checksum:blockSize.value});
  }else engine=new FTX.Zmodem.Sender(link,options);
  state.engine=engine;state.running=true;start.disabled=true;stop.disabled=false;progress.value=5;
  note(uiText('发送：','Sending: ')+file.name+' ('+file.size+' B)');
  const timer=setInterval(()=>{progress.value=Math.min(95,progress.value+1)},400);
  try{
   if(protocol.value==='ymodem')await engine.sendBatch([{name:file.name,data}]);
   else await engine.send([{name:file.name,data}]);
   progress.value=100;finish(uiText('发送完成：','Sent: ')+file.name);
  }catch(error){finish(uiText('发送失败：','Send failed: ')+error.message)}
  finally{clearInterval(timer);link.close()}
 };

 const receive=async()=>{
  const link=attach();
  const options={timeout:15000,retries:8};
  let engine;
  if(protocol.value==='xmodem'||protocol.value==='xmodem1k')engine=new FTX.Xmodem.Receiver(link,{...options,checksum:blockSize.value});
  else if(protocol.value==='ymodem')engine=new FTX.Ymodem.Receiver(link,{...options,checksum:blockSize.value});
  else engine=new FTX.Zmodem.Receiver(link,options);
  state.engine=engine;state.running=true;start.disabled=true;stop.disabled=false;progress.value=5;
  note(uiText('等待对端发送…','Waiting for the sender…'));
  try{
   const result=protocol.value==='zmodem'?await engine.start():await engine.receive();
   let count=0;
   for(const file of result.files){
    const saved=await window.core.transferSave(file.name,Buffer.from(file.data).toString('base64'));
    if(saved){count++;note(uiText('已保存：','Saved: ')+saved.path+' ('+saved.bytes+' B)')}else note(uiText('已跳过：','Skipped: ')+file.name);
   }
   progress.value=100;finish(count?uiText('接收完成','Receive complete'):uiText('没有保存任何文件','Nothing was saved'));
  }catch(error){finish(uiText('接收失败：','Receive failed: ')+error.message)}
  finally{link.close()}
 };

 start.onclick=async()=>{
  if(!session){note(uiText('请先新建或选择一个会话','Create or select a session first'));return}
  if(typeof FTX==='undefined'){note(uiText('file-transfer.js 未加载','file-transfer.js is not loaded'));return}
  if(action.value==='send')await send();else await receive();
 };
 stop.onclick=()=>{
  state.aborted=true;
  // 协议层的中止是双 CAN：接收方/发送方看到它就结束，不会把残帧当成数据。
  if(state.link)try{state.link.write([0x18,0x18])}catch(e){}
  if(state.link)state.link.close();
  finish(uiText('已中止','Aborted'));
 };
 close.onclick=()=>dialog.close();
 dialog.onclose=()=>{state.aborted=true;if(state.detach)state.detach();if(state.link)state.link.close();dialog.remove();resolve()};
 dialog.append(title,target,row,hint,action,progress,log,start,stop,close);
 document.body.append(dialog);dialog.showModal();
})}

const transferButton=document.createElement('button');
transferButton.id='fileTransfer';transferButton.dataset.category='files';
bar.append(transferButton);
transferButton.onclick=openTransferPanel;
const transferLocaleBefore=localize;
localize=()=>{transferLocaleBefore();transferButton.textContent=uiText('文件传输','File transfer')};
localize();
