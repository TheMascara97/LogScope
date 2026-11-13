const {app,BrowserWindow,ipcMain,dialog,Menu,Notification,shell}=require('electron');const {spawn}=require('child_process');const path=require('path'),fs=require('fs');const openedLogs=new Set();let core,win,uiReady=false;const pendingUi=[];
// One pipe name per UI run. A fixed name couples every launch to whatever stale core
// still holds it (a crashed core can sit suspended under Windows Error Reporting for
// minutes, answering nothing), which shows up as a window that never connects.
// process.env is handed to the core through spawn(), but a renderer inherits the
// environment Chromium started with, not this later mutation, so the preload asks for
// the name over IPC instead of reading the variable.
const PIPE=process.env.LOGSCOPE_PIPE||('LogScopeCore-'+process.pid+'-'+Date.now().toString(36));process.env.LOGSCOPE_PIPE=PIPE;
// 终端 OSC 8 链接与渲染进程 window.open 共用的白名单：只有 http(s) 允许进系统浏览器。
// 顶层函数声明，main.test.cjs 用 vm 直接断言。
function linkAllowed(url){return/^https?:\/\//i.test(String(url))}
// Windows build 号传给渲染进程：xterm 的 windowsPty(ConPTY) 依此调整换行/尺寸行为。
// 非 Windows 或解析失败 → 0 → terminal-view.js 整体省略该选项（e2e/smoke 即此路径）。
const WINBUILD=process.platform==='win32'?parseInt(String(require('os').release().split('.')[2]||'0'),10)||0:0;
// Anything the UI must be told about the core can happen before the page is listening,
// and a dropped message leaves a window that looks connected but never receives data.
function toUi(channel,payload){if(uiReady&&win&&!win.isDestroyed())win.webContents.send(channel,payload);else pendingUi.push([channel,payload])}
function flushUi(){uiReady=true;if(!win||win.isDestroyed())return;for(const [channel,payload] of pendingUi.splice(0))win.webContents.send(channel,payload)}
let coreNote='';const ownsLock=app.requestSingleInstanceLock();if(!ownsLock){app.quit()}app.on('second-instance',()=>{if(win){win.restore();win.focus()}});
function menu(lang='zh'){const zh=lang==='zh',send=c=>win?.webContents.send('menu:command',c);Menu.setApplicationMenu(Menu.buildFromTemplate([{label:zh?'配置':'Settings',submenu:[{label:zh?'全局设置':'Global settings',click:()=>send('settings')},{label:zh?'语言':'Language',submenu:[{label:'中文',type:'radio',checked:zh,click:()=>send('language:zh')},{label:'English',type:'radio',checked:!zh,click:()=>send('language:en')}]},{label:zh?'保存地址':'Save location',click:()=>send('save')},{label:zh?'导入日志':'Import log',click:()=>send('import')},{type:'separator'},{label:zh?'退出':'Quit',role:'quit'}]},{label:zh?'编辑':'Edit',submenu:[{label:zh?'撤销':'undo',role:'undo'},{label:zh?'重做':'redo',role:'redo'},{type:'separator'},{label:zh?'剪切':'cut',role:'cut'},{label:zh?'复制':'copy',role:'copy'},{label:zh?'粘贴':'paste',role:'paste'},{label:zh?'全选':'selectAll',role:'selectAll'}]},{label:zh?'查看':'View',submenu:[{label:zh?'重新加载':'reload',role:'reload'},{label:zh?'开发者工具':'toggleDevTools',role:'toggleDevTools'},{type:'separator'},{label:zh?'实际大小':'resetZoom',role:'resetZoom'},{label:zh?'放大':'zoomIn',role:'zoomIn'},{label:zh?'缩小':'zoomOut',role:'zoomOut'},{label:zh?'全屏':'togglefullscreen',role:'togglefullscreen'}]},{label:zh?'窗口':'Window',submenu:[{label:zh?'最小化':'minimize',role:'minimize'},{label:zh?'最大化':'zoom',role:'zoom'},{label:zh?'关闭窗口':'close',role:'close'}]},{label:zh?'帮助':'Help',submenu:[{label:zh?'LogScope 日志工作台':'LogScope Log Workspace',enabled:false}]}]))}
function create(){win=new BrowserWindow({width:1440,height:900,minWidth:1050,minHeight:650,backgroundColor:'#101418',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,sandbox:false,additionalArguments:['--logscope-pipe='+PIPE,'--logscope-winbuild='+WINBUILD]}});
// window.open / target=_blank / OSC 8 链接行为统一接管：绝不在应用内新开 Electron 窗口；
// http(s) 白名单转系统浏览器，其余协议静默丢弃（渲染侧 termOpenLink 还有一道确认）。
win.webContents.setWindowOpenHandler(({url})=>{if(linkAllowed(url))shell.openExternal(url);return{action:'deny'}});
win.loadFile(path.join(__dirname,'index.html'))}
ipcMain.handle('menu:language',(_,lang)=>menu(lang));
// Cloud analysis is provider-selectable (DeepSeek, Kimi, GLM, Qwen, SiliconFlow, OpenAI or a
// custom OpenAI-compatible base). The key never reaches the renderer: the renderer stores it
// through the encrypted vault and passes only its id here.
ipcMain.handle('ai:providers',()=>{const ai=require('./ai-providers.cjs'),keys=require('./vault.cjs').list().filter(x=>x.type==='aikey');return {presets:ai.presets(),keys:keys.map(({id,name})=>({id,name})),env:Object.fromEntries(Object.values(ai.PRESETS).map(p=>[p.env,!!(p.env&&process.env[p.env])]))}});
ipcMain.handle('ai:saveKey',(_,{name,secret})=>require('./vault.cjs').save(String(name||'AI key').slice(0,128),String(secret||''),'aikey'));
ipcMain.handle('ai:analyze',async(_,{model,text,cloudEnabled,allowOutbound,provider,base,keyId,envKey})=>{
 if(!cloudEnabled||!allowOutbound)throw Error('Cloud analysis is disabled');
 const ai=require('./ai-providers.cjs'),cfg=ai.config({provider,base,model,keyId,envKey});
 // A saved key wins over the environment: an install that has both must not silently use
 // the machine-wide variable instead of the one the user picked in the dialog.
 let key='';
 if(cfg.keyId)key=require('./vault.cjs').secret(cfg.keyId,'aikey');
 else if(cfg.envKey&&process.env[cfg.envKey])key=process.env[cfg.envKey];
 if(!key)throw Error(cfg.keyId?'AI key not found in the credential store':'Set an API key for '+cfg.label+' in the AI provider settings (or '+cfg.envKey+')');
 const payload=ai.requestBody(cfg,require('./analysis.js').redact(String(text)).slice(-16000));
 const res=await fetch(cfg.base+ai.path(cfg),{method:'POST',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify(payload.body)});
 const body=await res.json().catch(()=>({}));
 if(!res.ok)throw Error(body.error?.message||body.message||`请求失败 ${res.status}`);
 return ai.replyText(body);
});ipcMain.handle('file:openLog',async()=>{const r=await dialog.showOpenDialog({title:'导入日志文件',properties:['openFile'],filters:[{name:'Log files',extensions:['log','txt','out','trace','csv']},{name:'All files',extensions:['*']}]});if(r.canceled)return null;openedLogs.add(r.filePaths[0]);return await require('./log-files.cjs').preview(r.filePaths[0])});ipcMain.handle('file:saveLog',async(_,label)=>{const safe=String(label||'logscope').replace(/[<>:"/\\|?*]/g,'_'),r=await dialog.showSaveDialog({title:'选择自动保存位置',defaultPath:`${safe}.log`,filters:[{name:'Log files',extensions:['log','txt']}]});return r.canceled?null:r.filePath});app.whenReady().then(()=>{if(!ownsLock)return;require('./vault.cjs').cleanupStale();menu();const exe=app.isPackaged?path.join(process.resourcesPath,'core','LogScopeCore.exe'):path.join(__dirname,'..','core','build','Release','LogScopeCore.exe');core=spawn(exe,[],{windowsHide:true,env:process.env});core.on('error',e=>{coreNote='spawn: '+e.message;console.error('Core unavailable',e);toUi('core:exit',{message:'采集核心无法启动：'+e.message})});core.on('exit',(code,signal)=>{if(shutdownStarted)return;coreNote='exit '+(signal||code);console.error('Core exited',code,signal);toUi('core:exit',{message:'采集核心已退出（'+(signal||code)+'），本窗口无法再采集日志'})});create();if(process.env.LOGSCOPE_SELF_TEST){const output=process.env.LOGSCOPE_SELF_TEST;const timeout=setTimeout(()=>{fs.writeFileSync(output,JSON.stringify({error:'Window load timeout'}));app.quit()},25000);win.webContents.once('did-finish-load',async()=>{flushUi();try{const result=await win.webContents.executeJavaScript("(async()=>{const status=()=>document.querySelector('#status')?.textContent||'';const deadline=Date.now()+8000;while(Date.now()<deadline&&!status().includes('核心已连接'))await new Promise(r=>setTimeout(r,200));let ipc=null;try{ipc=JSON.parse(JSON.stringify(window.core&&window.core.debug?window.core.debug():null))}catch(e){ipc='debug failed: '+e.message}return {title:document.title,preload:typeof window.core,analysis:typeof LogAnalysis,terminal:typeof Terminal,tools:document.querySelectorAll('.toolbox button').length,coreStatus:status(),ipc,statusElement:!!document.querySelector('#status')}})()");fs.writeFileSync(output,JSON.stringify({...result,core:{isPackaged:app.isPackaged,path:exe,pid:core.pid,alive:core.exitCode===null,pipe:PIPE,note:coreNote,undelivered:pendingUi.length}},null,2))}catch(e){fs.writeFileSync(output,JSON.stringify({error:e.message}))}finally{clearTimeout(timeout);win.close()}})}});app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
ipcMain.handle('file:search',async(_,{file,query})=>{if(!openedLogs.has(file))throw Error('Import the file first');return require('./log-index.cjs').search(file,query,path.join(app.getPath('userData'),'indexes'))});
ipcMain.handle('device:adb',()=>require('./device-services.cjs').adbDevices());
ipcMain.handle('ssh:key',async()=>{const r=await dialog.showOpenDialog({title:'SSH private key',properties:['openFile']});return r.canceled?null:r.filePaths[0]});
ipcMain.handle('ssh:files',async(_,{cfg,action,remote,local})=>{
 let target='';
 // A dropped file arrives with its own path, so no picker; the path still has to be a
 // real absolute file before it is handed to sftp.
 if(action==='upload'){const r=await dialog.showOpenDialog({properties:['openFile']});if(r.canceled)return null;target=r.filePaths[0];}
 if(action==='upload-file'||action==='download-file'){
   if(typeof local!=='string'||!path.isAbsolute(local))throw Error('拖入的文件没有本机路径，请改用“选择本地文件” / Dropped item has no local path');
   const info=await fs.promises.stat(local).catch(()=>null);if(!info||!info.isFile())throw Error('不是有效的本机文件 / Not a readable local file');
   if(action==='upload-file')target=local;
 }
 if(action==='download'){const r=await dialog.showSaveDialog({defaultPath:path.basename(remote)});if(r.canceled)return null;target=r.filePath;}
 if(cfg.keyRef)cfg={...cfg,key:await require('./vault.cjs').keyFile(cfg.keyRef)};
 // upload-file/download-file are batch-mode actions too; the executor understands them
 // directly, so the action is passed through instead of being translated (translating
 // meant download-file fell through to the executor's 'Unsupported file operation').
 return require('./device-services.cjs').sftp(cfg,action,remote,action==='download-file'?local:target);
});
// X/Y/ZMODEM：本地文件读出/写入不经过渲染进程的 <input type=file>，因为传输需要真实
// 路径（也要能落盘到用户指定的位置）。64 MiB 上限和 vault/PDF 的取值一致——串口传输的
// 时间尺度下再大就不该走这条路了。
const TRANSFER_LIMIT=64*1024*1024;
ipcMain.handle('transfer:pick',async()=>{const r=await dialog.showOpenDialog({title:'选择要发送的文件',properties:['openFile'],filters:[{name:'All files',extensions:['*']}]});if(r.canceled)return null;const file=r.filePaths[0],stat=await fs.promises.stat(file);if(stat.size>TRANSFER_LIMIT)throw Error('文件超过 64 MiB 上限 / File exceeds the 64 MiB limit');const data=await fs.promises.readFile(file);return {name:path.basename(file),size:stat.size,path:file,data:data.toString('base64')}});
ipcMain.handle('transfer:save',async(_,{name,data})=>{if(typeof data!=='string')throw Error('缺少文件内容 / Missing file content');const buffer=Buffer.from(data,'base64');if(buffer.length>TRANSFER_LIMIT)throw Error('文件超过 64 MiB 上限 / File exceeds the 64 MiB limit');const safe=[...String(name||'received.bin')].map(c=>c<' '||'<>:"/\|?*'.includes(c)?'_':c).join('').replace(/^\.+/,'')||'received.bin';const r=await dialog.showSaveDialog({title:'保存接收到的文件',defaultPath:safe});if(r.canceled)return null;await fs.promises.writeFile(r.filePath,buffer);return {path:r.filePath,bytes:buffer.length}});
ipcMain.handle('report:pdf',async(_,{title,text})=>{
 const choice=await dialog.showSaveDialog({title:'PDF report',defaultPath:'LogScope-report.pdf',filters:[{name:'PDF',extensions:['pdf']}]});if(choice.canceled)return null;
 const report=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,javascript:false}});
 const escape=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
 try{await report.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<meta charset="utf-8"><style>body{font:12px sans-serif}pre{white-space:pre-wrap;word-break:break-word}</style><h1>'+escape(title)+'</h1><pre>'+escape(require('./analysis.js').redact(String(text).slice(0,2000000)))+'</pre>'));const data=await report.webContents.printToPDF({printBackground:true});await fs.promises.writeFile(choice.filePath,data);return choice.filePath;}finally{report.destroy();}
});
ipcMain.on('alert:log',(_,{text})=>{if(Notification.isSupported())new Notification({title:'LogScope',body:require('./analysis.js').redact(String(text).slice(0,200))}).show()});
let auditQueue=[],auditBusy=false;
ipcMain.on('audit:action',(_,entry)=>{if(auditQueue.length<1000)auditQueue.push(JSON.stringify({time:new Date().toISOString(),type:String(entry.type||''),session:String(entry.session||''),data:require('./analysis.js').redact(String(entry.data||''))})+'\n')});
setInterval(async()=>{if(auditBusy||!auditQueue.length)return;auditBusy=true;const batch=auditQueue.splice(0).join('');try{const file=path.join(app.getPath('userData'),'audit.jsonl');const stat=await fs.promises.stat(file).catch(()=>null);if(stat&&stat.size>10*1024*1024){await fs.promises.rm(file+'.1',{force:true});await fs.promises.rename(file,file+'.1')}await fs.promises.appendFile(file,batch)}catch(e){console.error('Audit write failed',e.message)}finally{auditBusy=false}},500).unref();
ipcMain.handle('file:directory',async()=>{const r=await dialog.showOpenDialog({title:'Automatic log directory',properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0]});
ipcMain.handle('vault:list',()=>require('./vault.cjs').list());
ipcMain.handle('clipboard:write',(_,text)=>{if(typeof text!=='string'||text.length>16*1024*1024)throw Error('Clipboard text too large');require('electron').clipboard.writeText(text);return true});
ipcMain.handle('file:validateDirectory',async(_,directory)=>{if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('请输入完整目录路径 / Enter an absolute folder path');const info=await fs.promises.stat(directory);if(!info.isDirectory())throw Error('不是文件夹 / Not a folder');await fs.promises.access(directory,fs.constants.W_OK);return true});
ipcMain.handle('vault:save',(_,{name,secret})=>require('./vault.cjs').save(name,secret));
ipcMain.handle('vault:remove',(_,id)=>require('./vault.cjs').remove(id));
ipcMain.handle('vault:key',(_,id)=>require('./vault.cjs').keyFile(id));
ipcMain.handle('vault:send',(_,{id,session})=>require('./vault.cjs').sendPassword(id,session));
ipcMain.handle('vault:importKey',async()=>{const r=await dialog.showOpenDialog({title:'Import private key into encrypted vault',properties:['openFile']});if(r.canceled)return null;const stat=await fs.promises.stat(r.filePaths[0]);if(stat.size>1024*1024)throw Error('Key file too large');return require('./vault.cjs').save(path.basename(r.filePaths[0]),await fs.promises.readFile(r.filePaths[0],'utf8'),'key')});
app.on('will-quit',()=>require('./vault.cjs').cleanup());
ipcMain.handle('index:cache',async(_,{action,options})=>require('./log-index.cjs').manage(path.join(app.getPath('userData'),'indexes'),action,options));
ipcMain.handle('ai:local',async(_,options)=>require('./local-model.cjs').analyze(options));
let shutdownStarted=false,shutdownComplete=false;app.on('before-quit',event=>{if(shutdownComplete||!ownsLock||!core)return;event.preventDefault();if(shutdownStarted)return;shutdownStarted=true;require('./core-shutdown.cjs').shutdown(core).then(result=>{if(!result.graceful)fs.writeFileSync(path.join(app.getPath('userData'),'shutdown-warning.json'),JSON.stringify({time:new Date().toISOString(),message:'Core did not acknowledge disk flush before shutdown timeout. Check .active log markers.'}));}).catch(console.error).finally(()=>{shutdownComplete=true;app.quit()})});
ipcMain.handle('disk:status',async(_,directory)=>{const s=await fs.promises.statfs(directory);return s.bavail*s.bsize});ipcMain.handle('recovery:scan',async(_,directory)=>require('./recovery.cjs').scan(directory));
