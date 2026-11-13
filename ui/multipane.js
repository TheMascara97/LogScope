'use strict';
const paneLayout=document.createElement('select');paneLayout.id='paneLayout';logActions.append(paneLayout);const multiHost=document.createElement('div');multiHost.id='multiPane';logPane.after(multiHost);termHost.id='terminalHost';let multiConfig={layout:'single',names:[]};try{Object.assign(multiConfig,JSON.parse(localStorage.multiPaneLayout||'{}'))}catch{}const multiPanes=[];
function saveMultiLayout(){localStorage.multiPaneLayout=JSON.stringify({layout:paneLayout.value,names:multiPanes.map(p=>sessions.get(p.session.value)||p.savedName||'')})}
// A split exists to watch *different* sessions side by side — in practice, different serial
// ports, one per sheet. Showing the same session in two panes adds nothing and, worse, it is how
// "the same serial port" ended up split against itself. The visible panes therefore hold
// distinct sessions: choosing a session an occupied pane already shows takes it away from that
// pane instead of duplicating it, and empty panes are filled with the sessions not yet shown.
function paneIsVisible(index){const p=multiPanes[index];return !!p&&!p.root.hidden}
function usedSessions(exceptIndex){const used=new Set();multiPanes.forEach((p,i)=>{if(i!==exceptIndex&&paneIsVisible(i)&&p.session.value)used.add(p.session.value)});return used}
function claimSession(p,id){const other=multiPanes.find(q=>q!==p&&paneIsVisible(multiPanes.indexOf(q))&&q.session.value===id);if(other){other.session.value='';other.savedName='';other.stamp=''}p.session.value=id;p.savedName=sessions.get(id)||'';p.options=''}
function fillPanes(){if(paneLayout.value==='single')return 0
 // Serial ports first: they are what the split is for, and they are the sessions a user wants
 // to compare side by side. Otherwise the remaining sessions in tab order.
 const taken=new Set(multiPanes.filter((p,i)=>paneIsVisible(i)&&p.session.value).map(p=>p.session.value));
 const spare=[...sessions.keys()].filter(id=>!taken.has(id));
 const ordered=[...spare.filter(id=>String(id).startsWith('serial:')),...spare.filter(id=>!String(id).startsWith('serial:'))];
 let filled=0;
 multiPanes.forEach((p,i)=>{if(!paneIsVisible(i)||p.session.value)return;const id=ordered.shift();if(!id)return;claimSession(p,id);filled++});
 return filled}
function updateMultiPane(p,force=false){const items=[...sessions],options=JSON.stringify(items);if(p.options!==options){const selected=p.session.value,elsewhere=usedSessions(multiPanes.indexOf(p));p.session.replaceChildren(new Option(uiText('选择会话','Select session'),''));for(const [id,name] of items)p.session.append(new Option(elsewhere.has(id)?name+uiText('（已在其它窗格）',' (shown in another pane)'):name,id));p.session.value=sessions.has(selected)?selected:(items.find(([,name])=>name===p.savedName||name===p.savedName+' [恢复]')?.[0]||'');p.options=options;force=true}if(!p.follow&&!force)return;const id=p.session.value,rows=lines.get(id)||[],stamp=[id,rows.length,rows.at(-1)?.text,p.query.value].join('\0');if(!force&&p.stamp===stamp)return;p.stamp=stamp;const query=p.query.value.toLowerCase(),visible=rows.slice(-10000).filter(row=>!query||row.text.toLowerCase().includes(query)).slice(-500);p.logs.innerHTML=visible.map(formatLogRow).join('');p.status.textContent=uiText('最近 10000 行内搜索 · 显示 ','Search latest 10,000 rows · showing ')+visible.length;if(p.follow)p.logs.scrollTop=p.logs.scrollHeight}
for(let index=0;index<4;index++){const root=document.createElement('div'),tools=document.createElement('div'),session=document.createElement('select'),query=document.createElement('input'),logs=document.createElement('pre'),follow=document.createElement('button'),copy=document.createElement('button'),command=document.createElement('input'),send=document.createElement('button'),status=document.createElement('span'),p={root,session,query,logs,follow:true,savedName:multiConfig.names[index]||'',status,followButton:follow,copyButton:copy,sendButton:send,command};root.className='session-pane';tools.className='pane-tools';logs.tabIndex=0;const inputRow=document.createElement('div');inputRow.className='pane-tools';tools.append(session,follow,copy);inputRow.append(command,send);root.append(tools,query,logs,inputRow,status);multiHost.append(root);multiPanes.push(p);session.onchange=()=>{if(session.value)claimSession(p,session.value);p.follow=true;updateMultiPane(p,true);saveMultiLayout()};query.oninput=()=>updateMultiPane(p,true);follow.onclick=()=>{p.follow=true;updateMultiPane(p,true);follow.textContent=uiText('跟随','Follow')};copy.onclick=async()=>{const selection=getSelection();await window.core.copyText(selection?.anchorNode&&logs.contains(selection.anchorNode)?selection.toString():logs.innerText)};
// Same follow-tail rule as the main pane, per pane: wheel up pauses, returning to the bottom
// resumes, Enter jumps to the newest line.
const paneAtBottom=()=>logs.scrollTop+logs.clientHeight>=logs.scrollHeight-4;
let paneProbe=null;
const paneProbeFollow=()=>{clearTimeout(paneProbe);paneProbe=setTimeout(()=>{if(!p.follow&&paneAtBottom()){p.follow=true;follow.textContent=uiText('跟随','Follow');updateMultiPane(p,true)}},120)};
logs.onscroll=paneProbeFollow;
logs.onwheel=event=>{if(event.deltaY<0){p.follow=false;follow.textContent=uiText('恢复滚动','Resume')}else paneProbeFollow()};
logs.onpointerdown=()=>{p.follow=false;follow.textContent=uiText('恢复滚动','Resume');paneProbeFollow()};
logs.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();p.follow=true;follow.textContent=uiText('跟随','Follow');updateMultiPane(p,true);logs.scrollTop=logs.scrollHeight;return}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();p.follow=false;const range=document.createRange();range.selectNodeContents(logs);getSelection().removeAllRanges();getSelection().addRange(range)}};send.onclick=async()=>{const target=session.value;if(connectionStates.get(target)!=='connected'){status.textContent=uiText('此会话未连接，未发送','Session not connected; nothing sent');return}await sendCommand(command.value,target)};command.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();send.click()}}}
// A split needs at least two sessions to show, because its whole purpose is different sessions
// side by side: with one session the same tab would be drawn twice. Restoring a saved layout on
// startup is exempt, so panes are already in place when the sessions come back.
function applyMultiLayout(value,restoring=false){
 if(!['single','horizontal','vertical','quad'].includes(value))value='single';
 if(value!=='single'&&!restoring&&sessions.size<2){$('#status').textContent=uiText('当前只有 '+sessions.size+' 个会话，无法分屏：分屏用于把不同的串口（不同标签）并排查看','Only '+sessions.size+' session(s); a split shows different sessions (different serial ports) side by side');value='single'}
 paneLayout.value=value;multiHost.dataset.layout=value;document.body.classList.toggle('multipane-on',value!=='single');multiHost.hidden=value==='single';
 multiPanes.forEach((p,index)=>{p.root.hidden=index>=(value==='quad'?4:2)});
 fillPanes();
 multiPanes.forEach(p=>updateMultiPane(p,true));
 saveMultiLayout()}
paneLayout.onchange=()=>applyMultiLayout(paneLayout.value);const oldSplitButton=[...bar.children].find(b=>/分屏|Split/.test(b.textContent));if(oldSplitButton)oldSplitButton.onclick=()=>applyMultiLayout(paneLayout.value==='single'?'horizontal':'single');
setInterval(()=>{if(paneLayout.value==='single')return;fillPanes();multiPanes.forEach(p=>{if(!p.root.hidden)updateMultiPane(p)})},250);
const localeBeforeMultiPane=localize;localize=()=>{localeBeforeMultiPane();const selected=paneLayout.value;paneLayout.replaceChildren();for(const [value,zh,en] of [['single','单窗口','Single view'],['horizontal','左右分屏','Side by side'],['vertical','上下分屏','Stacked'],['quad','四宫格','Four panes']])paneLayout.append(new Option(uiText(zh,en),value));paneLayout.value=selected||multiConfig.layout;for(const p of multiPanes){p.query.placeholder=uiText('此窗格文本过滤','Filter this pane (literal text)');p.command.placeholder=uiText('发送到此窗格选择的会话','Send to this pane’s selected session');p.followButton.textContent=uiText('跟随','Follow');p.copyButton.textContent=uiText('复制','Copy');p.sendButton.textContent=uiText('发送','Send')}};localize();applyMultiLayout(multiConfig.layout,true);
