'use strict';
// Two views over the same session: the structured log view (time / level / module / message — the
// reason this workspace exists) and the raw terminal. A session is opened to be typed into, so the
// terminal is the view you land on and the log view is what you switch to. Imported files are the
// exception: there is no session behind them to type into.
//
// The host div carries an id because the multipane stylesheet hides panes by id, and this host used
// to be anonymous — `.multipane-on #terminalHost` matched nothing, so the xterm stayed on top of the
// split layout and the split appeared not to work.
// One xterm per session, keyed by session id. It is a shared global rather than a private map here
// because three other files reach into it: `interface.js` and `workspace-controls.js` dispose a
// terminal when its tab closes, and `appearance.js` repaints the theme and the font size across
// every open one. `renderer.js` owns `sessions` / `lines` the same way.
const terminals=new Map();
// OSC 终端标题（id→标题）：workspace-controls 的 render 用 termTitles.get(id)||name 覆盖显示名。
// closeTab / 关闭标签工具必须同步 delete，否则同 id 的下一个会话会继承旧标题。
const termTitles=new Map();
const termHost=document.createElement('div');termHost.id='terminalHost';termHost.style.cssText='display:none;flex:1;min-height:100px;background:#101418;overflow:hidden';$('#terminal').after(termHost);
// Local, not `uiText` from workspace-controls.js: this file loads before that one, and a view can be
// switched by an early core message before that script has evaluated its own helper.
const viewText=(zh,en)=>localStorage.lang==='en'?en:zh;
// OSC 8 / URL 点击的统一出口：只放行 http(s)，且先向用户确认。window.open 会被 main.js 的
// setWindowOpenHandler 接住（一律 deny，白名单转发系统浏览器），渲染进程内不会开出新 Electron 窗口。
function termOpenLink(uri){
 const url=String(uri==null?'':uri);
 if(!/^https?:\/\//i.test(url)){$('#status').textContent=viewText('已拦截非 http(s) 终端链接：','Blocked non-http(s) terminal link: ')+url.slice(0,200);return false}
 if(!window.confirm(viewText('在系统浏览器中打开该链接？','Open this link in your system browser?')+'\n\n'+url))return false;
 window.open(url);return true;
}
let terminalMode=false,modeBeforeViewlessTab=null;
function terminalSession(id){
 if(terminals.has(id))return terminals.get(id);
 const node=document.createElement('div');node.style.cssText='height:100%;display:none';termHost.append(node);
 // allowProposedApi:true 是 unicode11 与 search 装饰两个 addon 的前提。放开面的风险已受控：
 // 窗口打开被 main.js setWindowOpenHandler 全量拦截，链接经 termOpenLink 白名单+确认。
 // 其余逐字段选项来自 terminal-options.js（用户可调），这里只补不能序列化的部分：
 // allowProposedApi（安全开关，不暴露给用户）与 linkHandler（函数）。
 const termOpts={...(typeof TT!=='undefined'?TT.options():{}),allowProposedApi:true,linkHandler:{activate:(event,uri)=>termOpenLink(uri)}};
 // ConPTY 后端提示只在主进程拿到 Windows build 号时传入；e2e/smoke 无该参数 → windowsBuild 为 0 →
 // 选项整体省略，测试下终端构造与旧版逐位一致。
 const winBuild=Number(window.core&&window.core.windowsBuild)||0;
 if(winBuild>0)termOpts.windowsPty={backend:'conpty',buildNumber:winBuild};
 const term=new Terminal(termOpts);
 const fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open(node);
 // 四个官方 addon，逐个 typeof 守卫：缺任何一个只退化对应能力，不影响会话打开。
 let termSearchAddon=null,termSerializeAddon=null;
 if(typeof Unicode11Addon!=='undefined'){term.loadAddon(new Unicode11Addon.Unicode11Addon());term.unicode.activeVersion='11'}
 if(typeof SearchAddon!=='undefined'){termSearchAddon=new SearchAddon.SearchAddon();term.loadAddon(termSearchAddon)}
 if(typeof WebLinksAddon!=='undefined')term.loadAddon(new WebLinksAddon.WebLinksAddon((event,uri)=>termOpenLink(uri)));
 if(typeof SerializeAddon!=='undefined'){termSerializeAddon=new SerializeAddon.SerializeAddon();term.loadAddon(termSerializeAddon)}
 term.onData(data=>window.core.send({type:'session.send',session:id,data,newline:false,sensitive:true}));
 // 高负载终端流：洪水期每收到一块就 term.write 一次，会让 xterm 逐块解析+重排，
 // 主线程被切成碎纸。这里把 12ms 内到达的块合并成一次 write（超大合并块再切 64KB 片），
 // 解析次数从"包数"降到"帧数"量级；2MB 积压上限保留，过载丢弃按 2s 节流汇报而不是每包刷状态。
 let pending=0,dropped=0,lastOverloadNote=0,needResync=false;const buf=[];let flushTimer=null;
 function flushWrites(){
  flushTimer=null;
  if(!buf.length)return;
  const chunks=buf.splice(0,buf.length);
  let merged=chunks[0];
  if(chunks.length>1){let total=0;for(const c of chunks)total+=c.length;merged=new Uint8Array(total);let off=0;for(const c of chunks){merged.set(c,off);off+=c.length}}
  for(let at=0;at<merged.length;at+=65536){
   const slice=merged.length>65536?merged.subarray(at,Math.min(merged.length,at+65536)):merged;
   const size=slice.length;
   term.write(slice,()=>{pending-=size});
  }
 }
 const item={term,node,fit,search:termSearchAddon,serialize:termSerializeAddon,
  write(bytes){
   if(pending+bytes.length>2*1024*1024){dropped+=bytes.length;needResync=true;const now=Date.now();if(now-lastOverloadNote>2000){lastOverloadNote=now;$('#status').textContent=viewText('终端显示队列过载，跳过字节：','Terminal queue overloaded, dropped bytes: ')+dropped+viewText('；下一次写入将重置终端以恢复同步','; the next accepted write resets the terminal to resync')}return}
   // 丢弃可能把转义序列截半，后续输出会花屏。在下一次被接受的写入前前置 RIS（\x1bc）：
   // 清屏+回初始状态，用一屏内容换回解析同步（原始文件与日志面板不受影响，好过持续花屏）。
   // RIS 的 2 字节计入 pending，水位计算不漂移。
   if(needResync){needResync=false;const ris=new Uint8Array(bytes.length+2);ris[0]=0x1b;ris[1]=0x63;ris.set(bytes,2);bytes=ris}
   pending+=bytes.length;buf.push(bytes);
   if(flushTimer===null)flushTimer=setTimeout(flushWrites,12);
  },
  pendingBytes(){return pending},
  droppedBytes(){return dropped},
  resyncPending(){return needResync},
  flush:flushWrites};
 // OSC 标题（\x1b]0;…\x07）：只写 termTitles + DOM 点补，不动 sessions Map——render 全量重建时
 // workspace-controls 用同一张表重画，两条路径显示一致。document.title 只在当前活动标签时跟随。
 term.onTitleChange(title=>{
  const t=String(title==null?'':title).slice(0,120);
  if(t)termTitles.set(id,t);else termTitles.delete(id);
  const display=t||sessions.get(id)||id;
  document.querySelectorAll(`#tabs .tab[data-id="${CSS.escape(id)}"] span`).forEach(e=>{e.textContent=display});
  document.querySelectorAll(`#sessions [data-id="${CSS.escape(id)}"]`).forEach(e=>{e.textContent=display});
  if(id===active&&t)document.title=t;
 });
 // Bell：可视闪烁总是给；系统通知仅在用户开了 alerts 且该标签不在眼前（或窗口隐藏）时发，
 // 不与既有规则通知/告警通知（workbench.js）抢注意力。
 term.onBell(()=>{
  item.node.classList.add('term-bell');setTimeout(()=>item.node.classList.remove('term-bell'),400);
  if(localStorage.alerts==='true'&&(document.hidden||id!==active))window.core.notify(viewText('终端响铃：','Terminal bell: ')+(termTitles.get(id)||sessions.get(id)||id));
 });
 terminals.set(id,item);return item;
}
function showTerminal(){for(const [id,item] of terminals)item.node.style.display=id===active?'block':'none';if(active&&terminalMode){const item=terminalSession(active);item.node.style.display='block';requestAnimationFrame(()=>{item.fit.fit();window.core.send({type:'session.resize',session:active,cols:item.term.cols,rows:item.term.rows});item.term.focus()})}}
// Switching views is three statements plus a focus decision, and it has to be reachable from the
// button, from startup, and from the moment a tab is picked. Doing it inline in the click handler left
// startup and tab activation unable to change the view at all, and a view you land in without the
// keyboard lands nowhere.
const terminalButton=document.createElement('button');terminalButton.type='button';terminalButton.textContent='终端 / 日志';terminalButton.onclick=()=>setTerminalView(!terminalMode);bar.append(terminalButton);
function paintTerminalButton(){
 const viewless=!!active&&String(active).startsWith('file:');
 terminalButton.disabled=viewless;
 terminalButton.textContent=viewText('终端 / 日志','Terminal / Logs');
 terminalButton.setAttribute('aria-pressed',String(terminalMode));
 terminalButton.dataset.view=terminalMode?'terminal':'logs';
 terminalButton.title=viewless?viewText('导入的日志文件只有日志视图：没有可输入的会话','An imported log file has only the log view: there is no session to type into'):(terminalMode?viewText('当前：终端视图（逐键直通）。点击切到日志视图','Now: terminal view (raw keystrokes). Click for the log view'):viewText('当前：日志视图（在输出下方输入，回车载行尾发送）。点击切到终端视图','Now: log view (type below the output; Enter sends with the line ending). Click for the terminal view'));
}
function setTerminalView(on,options={}){
 const previous=terminalMode;terminalMode=!!on;
 termHost.style.display=terminalMode?'block':'none';
 $('#terminal').style.display=terminalMode?'none':'block';
 if(options.persist!==false)localStorage.terminalView=terminalMode?'terminal':'logs';
 paintTerminalButton();
 // 离开终端视图时收起终端查找栏：Ctrl+F 的所有权跟着视图走，残留的栏会挡住日志面板的查找。
 if(!terminalMode&&typeof termSearchBar!=='undefined'&&!termSearchBar.hidden)termSearchClose();
 showTerminal();
 if(previous!==terminalMode&&typeof focusInputSurface==='function')focusInputSurface();
}
// A live session can be typed into; an imported file cannot. The view follows that, and the user's own
// choice comes back when they return to a real session instead of being silently overwritten by it.
function applySessionView(id){
 const viewless=!!id&&String(id).startsWith('file:');
 if(viewless){
  if(modeBeforeViewlessTab===null)modeBeforeViewlessTab=terminalMode;
  if(terminalMode)setTerminalView(false,{persist:false});
 }else if(modeBeforeViewlessTab!==null){
  const restore=modeBeforeViewlessTab;modeBeforeViewlessTab=null;
  if(terminalMode!==restore)setTerminalView(restore,{persist:false});
 }
 paintTerminalButton();
}
const oldActivate=activate;activate=id=>{oldActivate(id);applySessionView(id);showTerminal()};
onCoreEvent(m=>{if(m.type==='terminal'){const bytes=Uint8Array.from(atob(m.data),c=>c.charCodeAt(0));terminalSession(m.session).write(bytes)}if(m.type==='session'){showTerminal();paintTerminalButton();if(typeof focusInputSurface==='function')focusInputSurface()}});
new ResizeObserver(()=>{if(terminalMode)showTerminal()}).observe(termHost);
// Deferred to load: this file runs before the workspace controls, the localisation pass and the saved
// split layout, and choosing a view before those exist would be undone by them.
window.addEventListener('load',()=>{setTerminalView(localStorage.terminalView!=='logs',{persist:false});applySessionView(active)});
// ===== 终端内查找（SearchAddon）=====
// terminalMode 下 Ctrl+F 归终端。本 capture 监听注册得比 log-find.js 的早（index.html 里
// terminal-view.js 先加载），同相位同目标按注册序分发，命中时 stopImmediatePropagation，
// 日志面板的 #findBar 不会同时弹出；日志视图下本监听直接 return，两套查找互不知晓。
const termSearchBar=document.createElement('div');termSearchBar.id='termSearchBar';termSearchBar.className='find-bar';termSearchBar.hidden=true;
termSearchBar.innerHTML='<input id="termSearchInput" type="text" aria-label="Find in terminal"><button type="button" id="termSearchCase" aria-pressed="false">Aa</button><span class="fd-count" id="termSearchCount">0/0</span><button type="button" id="termSearchPrev">▲</button><button type="button" id="termSearchNext">▼</button><button type="button" id="termSearchClose">×</button>';
termHost.before(termSearchBar);
const termSearchInput=$('#termSearchInput');
function termSearchCount(text){$('#termSearchCount').textContent=text==null?'0/0':text}
function termSearchRun(direction){
 const item=terminalMode&&active?terminals.get(active):null;
 if(!item||!item.search)return;
 const q=termSearchInput.value;
 if(!q){if(item.search.clearDecorations)item.search.clearDecorations();termSearchCount('');return}
 const opts={caseSensitive:$('#termSearchCase').getAttribute('aria-pressed')==='true',decorations:{matchBackground:'#4a3b00',activeMatchBackground:'#8a6d00',matchOverviewRuler:'#8a6d00'}};
 const found=direction<0?item.search.findPrevious(q,opts):item.search.findNext(q,opts);
 // 新版 SearchAddon 暴露 resultCount/resultIndex 时给 Notepad++ 式计数，否则退化为命中/未命中。
 const s=item.search;
 if(typeof s.resultCount==='number'&&s.resultCount>0)termSearchCount((s.resultIndex+1)+'/'+s.resultCount);
 else termSearchCount(found?viewText('1/1+','1/1+'):viewText('无匹配','No match'));
}
function termSearchClose(){
 termSearchBar.hidden=true;
 const item=active?terminals.get(active):null;
 if(item&&item.search&&item.search.clearDecorations)item.search.clearDecorations();
 termSearchCount('');
 if(item)item.term.focus();
}
function termSearchOpen(){termSearchBar.hidden=false;termSearchInput.focus();termSearchInput.select()}
let termSearchTimer=0;
termSearchInput.addEventListener('input',()=>{clearTimeout(termSearchTimer);termSearchTimer=setTimeout(()=>termSearchRun(1),120)});
$('#termSearchCase').onclick=e=>{const on=e.currentTarget.getAttribute('aria-pressed')!=='true';e.currentTarget.setAttribute('aria-pressed',String(on));termSearchRun(1)};
$('#termSearchPrev').onclick=()=>termSearchRun(-1);
$('#termSearchNext').onclick=()=>termSearchRun(1);
$('#termSearchClose').onclick=termSearchClose;
document.addEventListener('keydown',e=>{
 if(!terminalMode)return;
 const k=e.key;
 if((e.ctrlKey||e.metaKey)&&k.toLowerCase()==='f'&&!e.shiftKey&&!e.altKey){e.preventDefault();e.stopImmediatePropagation();termSearchOpen();return}
 if(termSearchBar.hidden)return;
 if(k==='Escape'){e.preventDefault();e.stopImmediatePropagation();termSearchClose();return}
 if(k==='F3'){e.preventDefault();e.stopImmediatePropagation();termSearchRun(e.shiftKey?-1:1);return}
 if(k==='Enter'&&document.activeElement===termSearchInput){e.preventDefault();e.stopImmediatePropagation();termSearchRun(e.shiftKey?-1:1)}
},true);
function termSearchLocalize(){
 termSearchInput.placeholder=viewText('在终端中查找…（Enter 下一个）','Find in terminal… (Enter = next)');
 $('#termSearchCase').title=viewText('区分大小写','Match case');
 $('#termSearchPrev').title=viewText('上一个（Shift+F3）','Previous (Shift+F3)');
 $('#termSearchNext').title=viewText('下一个（F3）','Next (F3)');
 $('#termSearchClose').title=viewText('关闭（Esc）','Close (Esc)');
}
const termSearchLocalizeBase=localize;localize=(...args)=>{termSearchLocalizeBase(...args);termSearchLocalize()};
termSearchLocalize();
