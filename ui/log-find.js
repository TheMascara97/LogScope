'use strict';
// Notepad++ 式查找：Ctrl+F 查找栏，区分大小写/全词/正则，▲▼ 导航 + 绕回，匹配计数，
// 页内黄色高亮（当前命中橙色），F3 / Shift+F3 全局继续查找。
// 和搜索行的"过滤"不同：过滤会隐藏不匹配的行，查找不动任何行——在当前视图里找并
// 点亮（Notepad++ 的 Find 也不改文档）。匹配计算跑在 logVirtual.rows 上（已经过级别/
// 搜索行过滤），即"看见什么搜什么"；未渲染的行用工具箱"搜索整个文件"。
// 高亮走 workspace-controls formatLogRow 的 fdDecorate 钩子：命中段包 <mark>，其余段
// 仍走 timeMarkup，时间戳链接保留。跨多行堆栈的命中按 part 裁剪（跨换行的整段匹配跳过）。
// 全局一律 fd 前缀。加载顺序：log-selection.js 之后（用 logVirtual、uiText、esc、timeMarkup）。
const FD_MAX=20000;
let fdQuery='',fdCaseOn=false,fdWordOn=false,fdReOn=false,fdMatches=[],fdRowMap=new Map(),fdCur=-1,fdCapped=false,fdRowsRef=null,fdTimer=0;
const findBar=document.createElement('div');findBar.id='findBar';findBar.className='find-bar';findBar.hidden=true;
findBar.innerHTML='<input id="findInput" type="text" aria-label="Find"><button type="button" id="fdCase" aria-pressed="false">Aa</button><button type="button" id="fdWord" aria-pressed="false">W</button><button type="button" id="fdRe" aria-pressed="false">.*</button><span class="fd-count" id="fdCount">0/0</span><button type="button" id="fdPrev">▲</button><button type="button" id="fdNext">▼</button><button type="button" id="fdClose">×</button>';
$('#terminal').before(findBar);
const fdInput=$('#findInput');
function fdEsc(q){return q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
function fdCount(note){$('#fdCount').textContent=note||((fdMatches.length?fdCur+1:0)+'/'+fdMatches.length+(fdCapped?'+':''))}
function fdBuild(){
 fdMatches=[];fdRowMap=new Map();fdCapped=false;
 if(!fdQuery){fdCur=-1;fdCount();return}
 let re;
 if(fdReOn){try{re=new RegExp(fdQuery,fdCaseOn?'g':'gi')}catch(e){fdCur=-1;fdCount(uiText('无效正则','Invalid regex'));return}}
 else re=new RegExp(fdWordOn?`\\b${fdEsc(fdQuery)}\\b`:fdEsc(fdQuery),fdCaseOn?'g':'gi');
 const rows=logVirtual.rows;
 outer:for(let i=0;i<rows.length;i++){
  const text=String(rows[i].text);re.lastIndex=0;let m;
  while((m=re.exec(text))!==null){
   if(m[0]===''){re.lastIndex++;continue}
   const k=fdMatches.length;
   fdMatches.push({i,s:m.index,e:m.index+m[0].length,k});
   const list=fdRowMap.get(rows[i]);if(list)list.push(fdMatches[k]);else fdRowMap.set(rows[i],[fdMatches[k]]);
   if(k+1>=FD_MAX){fdCapped=true;break outer}
  }
 }
 fdCur=fdMatches.length?Math.max(0,Math.min(fdCur,fdMatches.length-1)):-1;
 fdCount();
}
// formatLogRow 的绘制钩子：part 是 row.text 的一个换行段，off 是它在整行里的起点。
function fdDecorate(part,row,off){
 const list=fdRowMap.get(row);if(!list||!list.length)return timeMarkup(part);
 const end=off+part.length;let html='',cursor=0,hit=false;
 for(const r of list){
  if(r.s<off||r.e>end)continue;
  hit=true;
  if(r.s-off>cursor)html+=timeMarkup(part.slice(cursor,r.s-off));
  html+=`<mark class="fd-hit${r.k===fdCur?' fd-cur':''}">${esc(part.slice(r.s-off,r.e-off))}</mark>`;
  cursor=r.e-off;
 }
 if(!hit)return timeMarkup(part);
 return html+timeMarkup(part.slice(cursor));
}
function fdStep(d){
 if(!fdMatches.length){$('#status').textContent=uiText('没有匹配','No matches');return}
 const before=fdCur;fdCur=(fdCur+d+fdMatches.length)%fdMatches.length;
 const row=logVirtual.rows[fdMatches[fdCur].i];
 if(row)logVirtual.requestScrollToRow(row,'center');else logVirtual.paint(true);
 fdCount();
 if(fdMatches.length>1){
  if(d>0&&fdCur<=before)$('#status').textContent=uiText('已绕回第一个匹配','Wrapped to the first match');
  else if(d<0&&fdCur>=before)$('#status').textContent=uiText('已绕回最后一个匹配','Wrapped to the last match');
 }
}
function fdOpen(){findBar.hidden=false;fdInput.focus();fdInput.select();if(fdQuery&&fdRowsRef!==logVirtual.rows){fdRowsRef=logVirtual.rows;fdBuild()}}
function fdClose(){findBar.hidden=true;if(fdQuery){fdQuery='';fdInput.value='';fdRowsRef=logVirtual.rows;fdBuild();logVirtual.paint(true)}const c=$('#composerInput');(c&&!c.disabled?c:logPane).focus()}
function fdRefresh(){
 // 未跟随（向上滚动过）时，render 的 setRows 被 followTail 门挡住，logVirtual.rows 停在旧
 // 快照——滚动之后到达的行不在里面，查找会静默落空且无任何提示。构建匹配集前强制同步一次
 // 虚拟滚动器（与 #query 搜索框输入同一条 render(true) 路径，开销一致，滚动位置不动，之后
 // fdStep 才跳到命中行）；"暂停显示"期间保持冻结语义，不同步。
 // 若 render 因 worker 过滤挂起提前返回（filtered===null），worker 结果落地会触发 setRows →
 // paint → 下方 onPaint 钩子按新 rows 重算，仍能自愈。
 if(!paused)render(true);
 fdQuery=fdInput.value;fdRowsRef=logVirtual.rows;fdCur=-1;fdBuild();
 if(fdMatches.length){fdCur=0;fdStep(0)}else logVirtual.paint(true);
}
fdInput.addEventListener('input',()=>{clearTimeout(fdTimer);fdTimer=setTimeout(fdRefresh,120)});
$('#fdCase').onclick=e=>{fdCaseOn=!fdCaseOn;e.currentTarget.setAttribute('aria-pressed',String(fdCaseOn));fdRefresh()};
$('#fdWord').onclick=e=>{fdWordOn=!fdWordOn;e.currentTarget.setAttribute('aria-pressed',String(fdWordOn));fdRefresh()};
$('#fdRe').onclick=e=>{fdReOn=!fdReOn;e.currentTarget.setAttribute('aria-pressed',String(fdReOn));fdRefresh()};
$('#fdPrev').onclick=()=>fdStep(-1);
$('#fdNext').onclick=()=>fdStep(1);
$('#fdClose').onclick=fdClose;
const fdToggle=document.createElement('button');fdToggle.id='fdToggle';logActions.append(fdToggle);
fdToggle.onclick=()=>findBar.hidden?fdOpen():fdClose();
function fdLocalize(){
 fdInput.placeholder=uiText('在当前视图查找…（Enter 下一个）','Find in view… (Enter = next)');
 $('#fdCase').title=uiText('区分大小写','Match case');
 $('#fdWord').title=uiText('全词匹配','Whole word');
 $('#fdRe').title=uiText('正则表达式','Regular expression');
 $('#fdPrev').title=uiText('上一个（Shift+F3）','Previous (Shift+F3)');
 $('#fdNext').title=uiText('下一个（F3）','Next (F3)');
 $('#fdClose').title=uiText('关闭（Esc）','Close (Esc)');
 fdToggle.textContent=uiText('查找','Find');
}
const fdPrevLocalize=localizeControls;localizeControls=()=>{fdPrevLocalize();fdLocalize()};
fdLocalize();
document.addEventListener('keydown',e=>{
 const k=e.key;
 if((e.ctrlKey||e.metaKey)&&k.toLowerCase()==='f'&&!e.shiftKey&&!e.altKey){e.preventDefault();e.stopPropagation();if(findBar.hidden)fdOpen();else{fdInput.focus();fdInput.select()}return}
 if(findBar.hidden){
  if(k==='F3'){e.preventDefault();fdOpen();if(fdQuery)fdStep(e.shiftKey?-1:1)}
  return;
 }
 if(k==='Escape'){e.preventDefault();e.stopPropagation();fdClose();return}
 if(k==='F3'){e.preventDefault();fdStep(e.shiftKey?-1:1);return}
 if(k==='Enter'&&document.activeElement===fdInput){e.preventDefault();fdStep(e.shiftKey?-1:1)}
},true);
// 新日志到达/过滤变化会换掉行数组：绘制后核对引用，命中集跟着当前视图重算。
// 重算发生在 paint 之后，刚画出来的窗口还没带上 <mark>——必须再补一次 paint(true)。
// 递归只有一层：重绘时 fdRowsRef 已等于 logVirtual.rows，走 else 分支只刷计数。
// 没有这个补绘，"输入防抖(120ms)先于渲染(100ms 节流+异步)完成"的竞态会让高亮永远不上屏。
logVirtual.onPaint(()=>{if(fdRowsRef!==logVirtual.rows){fdRowsRef=logVirtual.rows;if(fdQuery){fdBuild();if(fdMatches.length&&fdCur<0)fdCur=0;fdCount();logVirtual.paint(true)}}else if(fdQuery)fdCount()});
