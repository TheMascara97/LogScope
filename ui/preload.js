const {contextBridge,ipcRenderer,webUtils}=require('electron');
const net=require('net'),{StringDecoder}=require('string_decoder');
let socket,buf='',retry,watch,received=0,lastError='',connected=false,handshake=false,stallReported=false;const listeners=[],early=[];
// The connection is opened here, before any page script runs, so the core's handshake
// usually arrives while the document is still parsing and would otherwise be dropped:
// the status line then sits on "正在连接采集核心…" although the core is live. Hold the
// first messages until a listener appears and replay them to it.
function emit(message){if(!listeners.length){if(early.length<1000)early.push(message);return}for(const fn of listeners){try{fn(message)}catch(e){console.error(e)}}}
function subscribe(fn){listeners.push(fn);for(const message of early.splice(0)){try{fn(message)}catch(e){console.error(e)}}}
// Find the pipe this run listens on. A renderer keeps the environment Chromium was
// started with, so the variable main.js sets for the core is not visible here; the name
// is passed as a renderer argument instead. Harnesses that load this preload on their
// own (the smoke and e2e checks) set the environment variable, so keep it as fallback.
let pipeName='LogScopeCore';
try{const flag=process.argv.find(argument=>argument.startsWith('--logscope-pipe='));pipeName=(flag?flag.slice('--logscope-pipe='.length):'')||process.env.LOGSCOPE_PIPE||pipeName}catch(e){pipeName=(process.env&&process.env.LOGSCOPE_PIPE)||pipeName}
// Windows build 号（main.js 经 additionalArguments 传入）：xterm windowsPty/ConPTY 用。
// 测试挂具不带该参数 → 0 → terminal-view.js 省略 windowsPty 选项，行为与旧版一致。
let windowsBuild=0;
try{const flag=process.argv.find(argument=>argument.startsWith('--logscope-winbuild='));windowsBuild=parseInt(flag?flag.slice('--logscope-winbuild='.length):'',10)||0}catch(e){windowsBuild=0}
function connect(){
 clearTimeout(retry);buf='';handshake=false;stallReported=false;const decoder=new StringDecoder('utf8');
 socket=net.createConnection('\\\\.\\pipe\\'+pipeName);
 socket.on('data',data=>{clearTimeout(watch);connected=true;handshake=true;buf+=decoder.write(data);if(buf.length>8*1024*1024){buf='';emit({type:'error',message:'Core IPC frame too large'});return}let i;while((i=buf.indexOf('\n'))>=0){const row=buf.slice(0,i);buf=buf.slice(i+1);received++;try{emit(JSON.parse(row))}catch(e){emit({type:'error',message:'Invalid core message: '+e.message})}}});
 socket.on('error',e=>{lastError=String(e&&e.message||e)});
 socket.on('open',()=>{connected=true;watch=setTimeout(()=>{
  // Connecting but silent is not "connected": the core accepted the handle without serving
  // it (its accept path can lose the race against a burst of connects). That socket never
  // recovers on its own, so dropping it and redialling is the only way back — otherwise the
  // UI sits on a dead handle forever, which is what a stalled import looked like.
  if(handshake)return;stallReported=true;emit({type:'error',message:'采集核心无响应：连接已建立但 6 秒内没有收到握手消息，正在重连 / core accepted the connection but did not answer; reconnecting'});
  try{socket.destroy()}catch(e){}
  retry=setTimeout(connect,500);
 },6000)});
 socket.on('close',()=>{clearTimeout(watch);connected=false;if(!stallReported)emit({type:'status',message:'采集核心已断开，正在重新连接…'});retry=setTimeout(connect,1000)});
}
connect();
contextBridge.exposeInMainWorld('core',{windowsBuild,debug:()=>({pipe:pipeName,connected,received,listeners:listeners.length,buffered:early.length,waitingForRetry:!!retry,handshakeTimer:!!watch,lastError}),pathForFile:file=>{try{return webUtils.getPathForFile(file)}catch(e){return ''}},send:o=>{ipcRenderer.send('audit:action',{type:o.type,session:o.session||o.label||o.host||o.port,data:o.sensitive?'[interactive input]':o.auditBytes?'['+o.auditBytes+' transfer bytes]':o.data||o.command});socket?.writable?socket.write(JSON.stringify(o)+'\n'):emit({type:'error',message:'采集核心尚未连接，请稍后重试'})},on:subscribe,analyzeLocal:options=>ipcRenderer.invoke('ai:local',options),analyze:(model,text,options)=>ipcRenderer.invoke('ai:analyze',{model,text,...options}),aiProviders:()=>ipcRenderer.invoke('ai:providers'),aiSaveKey:(name,secret)=>ipcRenderer.invoke('ai:saveKey',{name,secret}),adbDevices:()=>ipcRenderer.invoke('device:adb'),pickKey:()=>ipcRenderer.invoke('ssh:key'),sshFiles:(cfg,action,remote,local)=>ipcRenderer.invoke('ssh:files',{cfg,action,remote,local}),pdfReport:(title,text)=>ipcRenderer.invoke('report:pdf',{title,text}),notify:text=>ipcRenderer.send('alert:log',{text}),transferPick:()=>ipcRenderer.invoke('transfer:pick'),transferSave:(name,data)=>ipcRenderer.invoke('transfer:save',{name,data}),validateDirectory:directory=>ipcRenderer.invoke('file:validateDirectory',directory),logDirectory:()=>ipcRenderer.invoke('file:directory'),vaultList:()=>ipcRenderer.invoke('vault:list'),vaultSave:(name,secret)=>ipcRenderer.invoke('vault:save',{name,secret}),vaultRemove:id=>ipcRenderer.invoke('vault:remove',id),vaultKey:id=>ipcRenderer.invoke('vault:key',id),vaultSend:(id,session)=>ipcRenderer.invoke('vault:send',{id,session}),vaultImportKey:()=>ipcRenderer.invoke('vault:importKey'),openLog:()=>ipcRenderer.invoke('file:openLog'),diskStatus:directory=>ipcRenderer.invoke('disk:status',directory),recoveryScan:directory=>ipcRenderer.invoke('recovery:scan',directory),indexCache:(action,options)=>ipcRenderer.invoke('index:cache',{action,options}),searchLog:(file,query)=>ipcRenderer.invoke('file:search',{file,query}),copyText:text=>ipcRenderer.invoke('clipboard:write',String(text)),saveLog:label=>ipcRenderer.invoke('file:saveLog',label),setLanguage:lang=>ipcRenderer.invoke('menu:language',lang),onMenu:fn=>ipcRenderer.on('menu:command',(_,c)=>fn(c))});
