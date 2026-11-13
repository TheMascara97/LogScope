'use strict';
// 命令自动补全 + 终端视图键入历史（shell 集成的一部分）。
// 补全弹层挂在两条输入面上（日志视图的 #composerInput、定时发送框 #command）：终端视图里
// Tab/方向键属于远端 shell，xterm 直通，不在客户端抢键。
// 候选来源按可信度排序：本工作区发送历史 > 收藏/模板命令 > 当前会话近期输出里的高频 token
// （路径、子命令一类）。终端视图的键入没有经过 sendCommand 链，这里给每个 xterm 补一个
// onData 监听，把可打印字符按行攒起来（退格删、Ctrl+C 弃行、ESC 序列整行作废），回车提交
// 进共享历史——这就是"设备端没跑 shell 集成脚本也有命令历史"的客户端等价物。
// 全局一律 cc 前缀。加载顺序：log-composer.js 之后（需要 terminalSession、commandHistory、
// commands、sessionKinds）。
const ccPopup=document.createElement('div');
ccPopup.id='ccPopup';ccPopup.hidden=true;
document.body.append(ccPopup);
const CC_MAX_ITEMS=60,CC_MIN_WORD=2,CC_SCAN_ROWS=3000;
const CC_SECRET=/password|passwd|token|secret|api[_-]?key|bearer/i;
let ccInput=null,ccItems=[],ccIndex=0,ccStart=0,ccCaret=0;
let ccCache=null,ccCacheKey='';
// ---- 终端视图键入历史 ----
const ccTyped=new Map();
function ccCommitLine(session,line){
 const text=String(line).trim();
 if(text.length<2||text.length>4096||CC_SECRET.test(text))return;
 // 与 workstation.js 的发送历史同库同规则：去重、置顶、截断 200 条。
 const history=commandHistory().filter(x=>x!==text);
 history.unshift(text);
 localStorage[workspaceKey('commandHistory')]=JSON.stringify(history.slice(0,200));
}
function ccKeystroke(session,data){
 let buf=ccTyped.get(session)||'';
 for(const ch of String(data)){
  if(ch==='\r'||ch==='\n'){ccCommitLine(session,buf);buf=''}
  else if(ch==='\x1b')buf=''; // 方向键/转义序列：这行不再是"一条命令"，作废
  else if(ch==='\b'||ch==='\x7f')buf=buf.slice(0,-1);
  else if(ch==='\x03'||ch==='\x15')buf=''; // Ctrl+C / Ctrl+U
  else if(ch>=' ')buf+=ch;
 }
 ccTyped.set(session,buf);
}
const ccTerminalSessionBefore=terminalSession;
terminalSession=id=>{const item=ccTerminalSessionBefore(id);if(item&&!item.ccHistoryHook){item.ccHistoryHook=true;item.term.onData(data=>ccKeystroke(id,data))}return item};
// ---- 候选集 ----
function ccCandidates(){
 const rows=(typeof lines!=='undefined'&&lines.get(active))||[];
 const key=active+'|'+rows.length+'|'+commandHistory().length+'|'+Math.floor(Date.now()/3000);
 if(ccCache&&ccCacheKey===key)return ccCache;
 const scores=new Map();
 const bump=(text,score)=>{if(!text||text.length<CC_MIN_WORD||text.length>200)return;const old=scores.get(text)||0;if(score>old)scores.set(text,score)};
 for(const command of commandHistory())bump(command,1000);
 if(typeof commands==='function')for(const row of commands())bump(row.command,900);
 const from=Math.max(0,rows.length-CC_SCAN_ROWS);
 for(let i=from;i<rows.length;i++){
  const text=String(rows[i].text||'');
  for(const match of text.matchAll(/[A-Za-z][A-Za-z0-9_./-]{2,63}|\/[A-Za-z0-9_./-]{2,63}/g))bump(match[0],1);
 }
 ccCache=scores;ccCacheKey=key;return scores;
}
function ccWordBefore(value,caret){
 let start=caret;
 while(start>0&&!/\s/.test(value[start-1]))start--;
 return [start,value.slice(start,caret)];
}
function ccRefresh(input){
 if(input!==ccInput){ccInput=input}
 const caret=input.selectionStart??input.value.length;
 const [start,word]=ccWordBefore(input.value,caret);
 if(word.length<CC_MIN_WORD){ccClose();return}
 ccStart=start;ccCaret=caret;
 const needle=word.toLowerCase();
 const pool=ccCandidates();
 const prefix=[],rest=[];
 for(const [text,score] of pool){
  const low=text.toLowerCase();
  if(low.startsWith(needle))prefix.push([text,score]);
  else if(low.includes(needle)&&prefix.length<CC_MAX_ITEMS)rest.push([text,score-500]);
 }
 prefix.sort((a,b)=>b[1]-a[1]||a[0].length-b[0].length);
 rest.sort((a,b)=>b[1]-a[1]);
 ccItems=[...prefix,...rest].slice(0,CC_MAX_ITEMS).map(x=>x[0]);
 if(!ccItems.length){ccClose();return}
 ccIndex=0;
 ccPaint();
}
function ccPaint(){
 ccPopup.replaceChildren();
 ccItems.forEach((text,i)=>{
  const b=document.createElement('button');b.type='button';b.className='cc-item'+(i===ccIndex?' on':'');
  b.textContent=text;b.title=text;
  b.onmouseenter=()=>{if(ccIndex!==i){ccIndex=i;ccPopup.querySelectorAll('.cc-item').forEach((x,k)=>x.classList.toggle('on',k===i))}};
  b.onclick=()=>ccAccept(text);
  ccPopup.append(b);
 });
 const foot=document.createElement('div');foot.className='cc-foot';
 foot.textContent=uiText(`共 ${ccItems.length} 项 · Tab 补全 · ↑↓ 选择 · Esc 关闭`,`${ccItems.length} items · Tab completes · ↑↓ choose · Esc closes`);
 ccPopup.append(foot);
 ccPopup.hidden=false;
 ccPlace();
 const on=ccPopup.querySelector('.cc-item.on');if(on)on.scrollIntoView({block:'nearest'});
}
function ccPlace(){
 const rect=ccInput.getBoundingClientRect();
 ccPopup.style.left=Math.max(8,Math.min(rect.left,innerWidth-320))+'px';
 ccPopup.style.width=Math.max(240,Math.min(rect.width,innerWidth-16))+'px';
 ccPopup.style.top='0px';
 const height=ccPopup.offsetHeight;
 ccPopup.style.top=(rect.top-height-4>8?rect.top-height-4:Math.min(innerHeight-8,rect.bottom+4))+'px';
}
function ccAccept(text){
 if(!ccInput)return;
 const value=ccInput.value;
 ccInput.value=value.slice(0,ccStart)+text+value.slice(ccInput.selectionStart??ccCaret);
 ccInput.focus();
 ccInput.setSelectionRange(ccStart+text.length,ccStart+text.length);
 ccClose();
}
function ccClose(){if(ccPopup.hidden)return;ccPopup.hidden=true;ccItems=[];ccIndex=0}
function ccMove(delta){
 if(!ccItems.length)return;
 ccIndex=((ccIndex+delta)%ccItems.length+ccItems.length)%ccItems.length;
 ccPopup.querySelectorAll('.cc-item').forEach((x,k)=>x.classList.toggle('on',k===ccIndex));
 const on=ccPopup.querySelector('.cc-item.on');if(on)on.scrollIntoView({block:'nearest'});
}
// 捕获阶段挂在 document 上：输入面自己的 keydown（composer 的 Esc 清行/↑↓ 回忆历史）在目标
// 节点注册，弹层打开时必须先于它们拿到方向键和 Esc，否则"选择补全项"和"回忆历史"会打架。
document.addEventListener('keydown',e=>{
 if(ccPopup.hidden)return;
 if(e.target!==$('#composerInput')&&e.target!==$('#command'))return;
 if(e.key==='Escape'){e.preventDefault();e.stopPropagation();ccClose();return}
 if(e.key==='Tab'){e.preventDefault();e.stopPropagation();if(ccItems[ccIndex]!==undefined)ccAccept(ccItems[ccIndex]);return}
 if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();ccMove(e.key==='ArrowDown'?1:-1);return}
 if(e.key==='Enter'){ccClose();return} // 回车维持原语义：发送/定时框自己处理
},true);
for(const input of [$('#composerInput'),$('#command')]){
 input.addEventListener('input',()=>ccRefresh(input));
 input.addEventListener('focus',()=>{if(input.value)ccRefresh(input)});
 input.addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement!==input&&!ccPopup.contains(document.activeElement))ccClose()},120));
}
document.addEventListener('pointerdown',e=>{if(!ccPopup.hidden&&!ccPopup.contains(e.target))ccClose()},true);
window.addEventListener('resize',()=>{if(!ccPopup.hidden)ccPlace()});
