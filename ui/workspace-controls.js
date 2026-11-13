'use strict';
const enUI=()=>localStorage.lang==='en',uiText=(zh,en)=>enUI()?en:zh;
// Keep compatibility with existing locale consumers; configuration menu is the only visible selector.
$('#language').hidden=true;document.body.append($('#language'));
const sessionProfiles=new Map(),pendingProfiles=[],reconnectWaiters=new Map();
const connectBeforeControls=connect;
connect=async(profile,remember=true)=>{if(!profile||(['ssh','tcp','telnet'].includes(profile.kind)&&!profile.host)||(profile.kind==='serial'&&!profile.serial)){$('#status').textContent=uiText('请填写连接地址或串口','Enter the connection address or serial port');return}const request={requestId:crypto.randomUUID(),profile:{...profile}};pendingProfiles.push(request);try{return await connectBeforeControls({...profile,requestId:request.requestId},remember)}finally{setTimeout(()=>{const i=pendingProfiles.indexOf(request);if(i>=0)pendingProfiles.splice(i,1)},10000)}};
onCoreEvent(m=>{if(m.type==='session'){const i=pendingProfiles.findIndex(x=>x.requestId===m.requestId);if(i>=0)sessionProfiles.set(m.id,pendingProfiles.splice(i,1)[0].profile)}if(m.type==='session.state'&&m.state==='closed'){reconnectWaiters.get(m.id)?.();reconnectWaiters.delete(m.id)}});
function closeTab(id){if(!id)return;closedTabs.add(id);logAnchors.delete(id);visibleLogRows.delete(id);termTitles.delete(id);window.core.send({type:'session.dispose',session:id});terminals.get(id)?.term.dispose();terminals.get(id)?.node.remove();terminals.delete(id);sessions.delete(id);lines.delete(id);sessionProfiles.delete(id);importPaths.delete(id);if(active===id)active=sessions.keys().next().value||'';applySessionView(active);render(true);showTerminal()}
const closeTool=[...bar.children].find(b=>/关闭标签|Close tab/.test(b.textContent));if(closeTool)closeTool.onclick=()=>closeTab(active);
const reconnectButton=document.createElement('button');reconnectButton.id='reconnect';$('#close').after(reconnectButton);
reconnectButton.onclick=async()=>{const id=active,p=sessionProfiles.get(id);if(!p){$('#status').textContent=uiText('该标签没有连接配置，请从已保存会话重新打开','No live connection profile; reopen a saved session');return}$('#status').textContent=uiText('正在重新连接…','Reconnecting…');await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{reconnectWaiters.delete(id);reject(Error(uiText('断开超时，请稍后重试','Disconnect timed out; retry later')))},5000);reconnectWaiters.set(id,()=>{clearTimeout(timeout);resolve()});window.core.send({type:'session.close',session:id})});if(['cmd','adb','powershell','wsl'].includes(p.kind))closeTab(id);await connect(p,false)};
const logActions=document.createElement('div');logActions.className='log-actions';const levelFilter=document.createElement('select');levelFilter.id='logLevel';for(const level of ['ALL','ERROR','WARN','INFO','DEBUG','TRACE','EVENT','TX'])levelFilter.append(new Option(level,level));
const followButton=document.createElement('button'),selectButton=document.createElement('button'),copyButton=document.createElement('button');followButton.id='followLogs';selectButton.id='selectLogs';copyButton.id='copyLogs';logActions.append(levelFilter,followButton,selectButton,copyButton);$('#terminal').before(logActions);
const logPane=$('#terminal');logPane.tabIndex=0;
function selectLogs(){if(terminalMode){terminals.get(active)?.term.selectAll();return}followTail=false;const range=document.createRange();range.selectNodeContents(logPane);const s=getSelection();s.removeAllRanges();s.addRange(range);logPane.focus();localizeControls()}
async function copyLogs(){let text=terminalMode?terminals.get(active)?.term.getSelection():getSelection()?.toString();if(!text)text=logPane.innerText;await window.core.copyText(text||'');$('#status').textContent=uiText('已复制日志','Logs copied')}
selectButton.onclick=selectLogs;copyButton.onclick=copyLogs;followButton.onclick=()=>{followTail=true;paused=false;render(true);localizeControls()};levelFilter.onchange=()=>render(true);
// Follow-tail, the way a terminal does it: scrolling up pauses the view but never the capture,
// and coming back to the bottom resumes following by itself — no button hunt. `atBottom` uses a
// few pixels of slack so a fractional line height does not leave following stuck off.
function atBottom(){return logPane.scrollTop+logPane.clientHeight>=logPane.scrollHeight-4}
let followProbe=null;
function probeFollow(){clearTimeout(followProbe);followProbe=setTimeout(()=>{if(paused)return;const bottom=atBottom();if(bottom===followTail)return;followTail=bottom;localizeControls();if(bottom)render(true)},120)}
logPane.addEventListener('scroll',probeFollow,{passive:true});
// 虚拟滚动的实测行高修正可能在滚动探针的 120ms 之后才把 scrollHeight 撑大/缩小，
// "已经贴底"于是被错过，跟随恢复要等用户再滚一下。paint 收尾后再探一次消除这个竞态；
// probeFollow 自带防抖与 paused/atBottom 判断，重入是安全的（跟随后 bottom===followTail 直接返回）。
if(typeof logVirtual!=='undefined'&&logVirtual.onPaint)logVirtual.onPaint(()=>{if(!paused&&!followTail)probeFollow()});
// A wheel up is the user moving away from the newest line, so pause at once; a wheel down while
// already at the bottom must not pause anything (there is nothing to scroll, so no scroll event
// arrives to re-engage it).
logPane.addEventListener('wheel',event=>{if(event.deltaY<0){followTail=false;localizeControls()}else probeFollow()},{passive:true});
logPane.addEventListener('pointerdown',()=>{followTail=false;localizeControls();probeFollow()});
logPane.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();selectLogs()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='c'){e.preventDefault();copyLogs().catch(error=>$('#status').textContent=error.message)}
 // Enter returns to the newest line and re-attaches following, like pressing Enter in a
 // terminal that had scrolled back. Shift+Enter is left alone so it stays available.
 if(e.key==='Enter'&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey){e.preventDefault();followTail=true;render(true);logPane.scrollTop=logPane.scrollHeight;localizeControls();$('#status').textContent=uiText('已回到最新日志并恢复自动滚动','Jumped to the newest log; following resumed')}});
logPane.addEventListener('contextmenu',e=>{e.preventDefault();$('#logContext')?.remove();const menu=document.createElement('div');menu.id='logContext';menu.className='log-context';menu.style.left=Math.min(e.clientX,innerWidth-180)+'px';menu.style.top=Math.min(e.clientY,innerHeight-100)+'px';
 // 菜单项在弹出时刻取全局函数：log-selection.js 会把 selectLogs/copyLogs 换成原生自由文本
 // 选择，并补上 lselPaste（粘贴到输入框）与 lselCopyAll（整段缓存复制）——这里只按名字引用，
 // 加载顺序变化不会破坏菜单。
 const items=[[uiText('全选窗口内行','Select rendered rows'),selectLogs],[uiText('复制所选内容','Copy selection'),copyLogs]];
 if(typeof lselPaste==='function')items.push([uiText('粘贴到输入框','Paste into the input line'),lselPaste]);
 if(typeof lselCopyAll==='function')items.push([uiText('复制全部缓存行（含未渲染）','Copy all buffered rows'),lselCopyAll]);
 for(const [label,fn] of items){const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{menu.remove();await fn()};menu.append(b)}
 document.body.append(menu);setTimeout(()=>document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))menu.remove()},{once:true}),0)});
// WindTerm 的标签栏一眼能看出每条连接是什么协议，这里用一个字形徽标补上同样的信息。
// sessionKinds 由 send-box.js（后加载）在 session 消息里填充；file: 前缀是导入的日志。
function tabKindGlyph(id){
 if(String(id).startsWith('file:'))return '▤';
 const kind=typeof sessionKinds!=='undefined'?sessionKinds.get(id)||'':'';
 return {serial:'⌁',replay:'↺',cmd:'▶',ssh:'⌨',telnet:'☏',adb:'⚉'}[kind]||'⇄';
}
render=function(force=false){
 // 校验用正则跟随搜索选项（search-options.js）：字面模式下先转义，'[' 就是一个普通字符；
 // 大小写开关决定 flags。真正过滤在 worker（filteredRowsAsync），这里只做语法把关。
 const q=$('#query').value;let re;try{re=q?new RegExp(typeof wtQueryPattern==='function'?wtQueryPattern(q):q,typeof wtQueryFlags==='function'?wtQueryFlags():'i'):null}catch(e){$('#status').textContent=uiText('无效正则：','Invalid regex: ')+e.message;return}
 const rows=lines.get(active)||[],scoped=rows.filter(x=>levelFilter.value==='ALL'||x.level===levelFilter.value),filtered=typeof filteredRowsAsync==='function'?filteredRowsAsync(scoped,q):scoped;
 if(filtered===null)return;
 visibleLogRows.clear();visibleLogRows.set(active,filtered);
 if(force||logPane.dataset.session!==active||(!paused&&followTail)){const switched=logPane.dataset.session!==active;logPane.dataset.session=active;
  if(!filtered.length){logVirtual.clear();logPane.innerHTML=`<span class="muted">${uiText('暂无匹配日志','No matching logs')}</span>`}
  else logVirtual.setRows(filtered,{force:force||switched,follow:!paused&&followTail,bottom:switched,session:active})}
 const tabHTML=[...sessions].map(([id,name])=>`<div class="tab ${id===active?'active':''}" data-id="${esc(id)}"><i class="tab-kind" aria-hidden="true">${tabKindGlyph(id)}</i><span>${esc(termTitles.get(id)||name)}</span><button type="button" data-close-tab="${esc(id)}" aria-label="${uiText('关闭标签','Close tab')}">×</button></div>`).join('');
 if($('#tabs').dataset.content!==tabHTML){$('#tabs').dataset.content=tabHTML;$('#tabs').innerHTML=tabHTML;$('#tabs').querySelectorAll('[data-id]').forEach(e=>e.onclick=()=>activate(e.dataset.id));$('#tabs').querySelectorAll('[data-close-tab]').forEach(e=>e.onclick=event=>{event.stopPropagation();closeTab(e.dataset.closeTab)})}
 const side=[...sessions].map(([id,name])=>`<div class="${id===active?'session-active':''}" data-id="${esc(id)}">${esc(termTitles.get(id)||name)}</div>`).join('');if($('#sessions').innerHTML!==side){$('#sessions').innerHTML=side;$('#sessions').querySelectorAll('[data-id]').forEach(e=>e.onclick=()=>activate(e.dataset.id))}
 logMeter.textContent=uiText(`缓存 ${rows.length} 行 · 匹配 ${filtered.length} · 虚拟滚动 · ${followTail?'跟随中':'滚动已暂停（回车回到最新）'}`,`${rows.length} buffered · ${filtered.length} matches · virtualized · ${followTail?'Following':'Scroll paused (Enter for newest)'}`);
 if(splitPane)splitPane.textContent=(lines.get(splitSelect.value)||[]).slice(-300).map(x=>'['+x.time+'] '+x.text).join('\n');
};
$('#query').oninput=()=>render(true);
function localizeControls(){reconnectButton.textContent=uiText('重新连接','Reconnect');followButton.textContent=followTail?uiText('正在跟随日志','Following logs'):uiText('恢复自动滚动','Resume following');selectButton.textContent=uiText('全选','Select all');copyButton.textContent=uiText('复制','Copy');levelFilter.options[0].textContent=uiText('全部级别','All levels');for(const [i,labels] of [['异常与警告','Errors and warnings'],['异常上下文','Error context'],['当前会话','Current session'],['全部会话','All sessions']].entries())scope.options[i].textContent=uiText(...labels);$('.analysis .side-title').textContent=uiText('分析结果','ANALYSIS');if(!$('#findings').children.length)$('#findings').textContent=uiText('等待日志分析…','Waiting for analysis…');$('#sLabel').placeholder=uiText('例如：测试台 01','Example: Test station 01');$('#sKey').placeholder=uiText('可选：私钥文件路径','Optional private key path');$('#sDescription').placeholder=uiText('可选备注','Optional notes');$('#sAdbSerial').placeholder=uiText('可选；留空使用默认设备','Optional; blank uses default device');$('#sLocalCommand').placeholder=uiText('CMD 留空启动命令行；ADB 默认 logcat','CMD: blank opens shell; ADB defaults to logcat')}
const previousLocalize=localize;localize=()=>{previousLocalize();localizeControls();render(true)};
scope.value='current';
$('#ai').onclick=async()=>{
 const title=uiText('本地分析结果','Local analysis');$('#status').textContent=uiText('正在分析…','Analyzing…');
 try{await new Promise(r=>setTimeout(r,0));let selected=lines.get(active)||[];if(scope.value==='error')selected=selected.filter(x=>['ERROR','WARN'].includes(x.level));else if(scope.value==='all')selected=[...lines.values()].flatMap(x=>x.slice(-500));else if(scope.value==='context'){let i=selected.findLastIndex(x=>['ERROR','WARN'].includes(x.level));selected=i<0?[]:selected.slice(Math.max(0,i-20),i+21)}selected=selected.slice(-2000);
 if(!selected.length){const message=uiText('当前范围没有日志，请先连接设备、导入日志或修改分析范围。','No logs in this scope. Connect a session, import logs, or change the scope.');addFinding(title,message);$('#status').textContent=message;return}
 const summary=LogAnalysis.summarize(selected),diagnoses=[...new Set(selected.map(LogAnalysis.diagnose).filter(Boolean))];addFinding(title,uiText('分析行数: ','Rows analyzed: ')+summary.count+'\n'+JSON.stringify(summary.levels)+'\n'+(diagnoses.join('\n')||uiText('未命中已知异常规则；这不代表设备一定正常。','No known anomaly matched; this does not prove the device is healthy.')));

 const refs=[];for(const row of selected.filter(x=>['ERROR','WARN'].includes(x.level)).slice(-10)){for(const [session,buffer] of lines){if(buffer.includes(row)){refs.push({session,row});break}}}if(typeof appendEvidenceLinks==='function')appendEvidenceLinks($('#findings').firstElementChild,refs);
 $('.analysis').scrollTop=0;$('#status').textContent=uiText('本地分析完成，结果见右侧','Local analysis complete; see results on the right');
 await analyzeLocalModel(selected);
 if(!$('#cloud').checked)return;if(!$('#outbound').checked){$('#status').textContent=uiText('本地分析完成；未允许出网，未调用云端','Local analysis complete; outbound disabled, cloud not called');return}
 const preview=await editor(uiText('脱敏预览：确认后发送到云端','Redacted preview: apply to send to cloud'),redactAll(selected.map(x=>'['+x.time+'] '+x.text).join('\n').slice(-16000)));if(preview===null)return;
 $('#status').textContent=uiText('云端分析中…','Cloud analysis in progress…');const result=await window.core.analyze(null,redactAll(preview),{cloudEnabled:true,allowOutbound:true,...aiRequestOptions()});addFinding('AI',result);$('#status').textContent=uiText('分析完成','Analysis complete');
 }catch(e){addFinding(uiText('分析失败','Analysis failed'),e.message);$('#status').textContent=e.message}
};
localize();
function formatLogRow(row){const level=['ERROR','WARN','INFO','DEBUG','TRACE','EVENT','TX'].includes(row.level)?row.level:'INFO';const parts=String(row.text).split('\n'),module=String(row.fields?.module||row.fields?.logger||row.fields?.tag||'—');const tag=row.event?.category?`<span class="log-tag" title="${esc(row.event.category+' · '+row.event.severity)}">${esc(row.event.category)}</span>`:'';
 // 超长行只解析了首尾窗口（analysis.js ANALYSIS_WINDOW）；标记出来，完整文本仍在行内。
 const cut=row.truncated?`<span class="log-tag" title="${esc(uiText('超长行：结构分析仅覆盖首尾各 32KB，完整文本仍显示并可导出','Huge line: structure analysis covered the first and last 32KB only; the full text is still shown and exportable'))}">${esc(uiText('超长行','Huge line'))}</span>`:'';
 // 查找高亮（log-find.js）在绘制期按换行段注入 <mark>；未开查找时 fdDecorate 不存在，走原路径。
 const mk=(s,off)=>typeof fdDecorate==='function'?fdDecorate(s,row,off):timeMarkup(s);
 const body=parts.length>1?`<details><summary>${mk(parts[0],0)} <small>+${parts.length-1}</small></summary><span class="stack-body">${mk(parts.slice(1).join('\n'),parts[0].length+1)}</span></details>`:mk(row.text,0);return `<span class="log-row level-${level}" title="${esc(row.detail||'')}"><span class="log-time">${esc(row.time||'—')}</span><span class="log-level">${level}</span><span class="log-module" title="${esc(module)}">${esc(module)}</span><span class="log-message">${tag}${cut}${body}</span></span>`}
// 时间戳换算链接跟着每次虚拟绘制重新绑定（窗口滚动后 DOM 是全新的）。
logVirtual.onPaint(()=>{logPane.querySelectorAll('.time-token').forEach(e=>e.onclick=()=>$('#status').textContent=timeValue(e.dataset.time))});
