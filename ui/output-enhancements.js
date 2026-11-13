'use strict';
// WindTerm 式输出增强，全部是"后到者包装"模式，不改前序文件的既有行为：
//   1. 搜索命中行内高亮（<mark class="wt-hit">，DOM 后处理，不动 formatLogRow 的 HTML 拼接）；
//   2. 命中计数 + 上一个/下一个跳转（虚拟滚动全量定位，借 logVirtual.requestScrollToRow）；
//   3. 悬浮"回到底部（N 条新日志）"胶囊按钮（跟随暂停时计数，点击走 followButton.onclick，
//      navigation-tools 对它的包装——清分页锚点——因此仍然生效）；
//   4. 时间戳列显示开关（纯 CSS 类切换，持久化到 localStorage）。
// 依赖加载顺序：rule-pipeline.js（wtSearchMatches）→ 本文件。所有新全局都用 wt 前缀，
// 避免与共用全局作用域里的既有名字冲突。

// ---- 1. 搜索命中行内高亮 ----
// 为什么在 DOM 上做而不是拼进 formatLogRow：消息列里已有 time-token 链接、log-tag 等嵌套
// HTML，按字符串偏移插 <mark> 很容易截断标签。正则安全性由 worker 过滤兜底——灾难回溯会在
// worker 里超时终止、过滤结果为空，这里根本不会执行。虚拟滚动下每次只绘制视口 ± overscan
// 行（几十行），所以高亮挂在 logVirtual.onPaint 上随窗口重打，预算按"一帧内完成"收紧。
let wtMarkToken='',wtNavPos=-1,wtFocusRid=-1;
function wtActiveRegex(){
 const query=$('#query').value;if(!query)return null;
 const flags=(typeof wtQueryFlags==='function'?wtQueryFlags():'i')+'g';
 try{return new RegExp(typeof wtQueryPattern==='function'?wtQueryPattern(query):query,flags)}catch{return null}
}
function wtUnwrapMarks(){
 const parents=new Set();
 for(const mark of logPane.querySelectorAll('mark.wt-hit')){const parent=mark.parentNode;parents.add(parent);while(mark.firstChild)parent.insertBefore(mark.firstChild,mark);parent.removeChild(mark)}
 // 合并被 mark 切碎的相邻文本节点，下一轮正则才能看到完整行文本。
 for(const parent of parents)parent.normalize();
}
function wtApplyHighlights(){
 // 终端视图下 #terminal 是隐藏的，标记没有意义；作废 token，切回日志视图后必定重打一遍。
 if(terminalMode){wtMarkToken='';return}
 const token=logPane.dataset.session+'|'+$('#query').value+'|'+(typeof wtQueryFlags==='function'?wtQueryFlags():'i');
 if(token!==wtMarkToken){wtMarkToken=token;wtNavPos=-1;wtFocusRid=-1} // 查询/会话变了，跳转位置从头计
 wtUnwrapMarks();
 const re=wtActiveRegex();if(!re)return;
 const deadline=performance.now()+40;let budget=1500;
 for(const message of logPane.querySelectorAll('.log-message')){
  if(budget<=0||performance.now()>deadline)return;
  // 多行折叠行（details/summary）先跳过：summary 里内联标记会破坏 "+N" 徽标结构，
  // 这类行仍然被过滤/计数/整行定位覆盖，只是没有行内黄标。
  if(message.querySelector('details'))continue;
  const walker=document.createTreeWalker(message,NodeFilter.SHOW_TEXT,{acceptNode(node){return node.parentElement?.classList?.contains('log-tag')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT}});
  let node;
  while((node=walker.nextNode())){
   re.lastIndex=0;
   const ranges=[];let m;
   while((m=re.exec(node.data))&&ranges.length<200){if(m[0].length)ranges.push([m.index,m.index+m[0].length]);else re.lastIndex=m.index+1}
   // 倒序包裹：先处理靠后的命中，前面命中的偏移量才不受 splitText 影响。
   for(let k=ranges.length-1;k>=0&&budget>0;k--,budget--){
    const range=document.createRange();range.setStart(node,ranges[k][0]);range.setEnd(node,ranges[k][1]);
    const mark=document.createElement('mark');mark.className='wt-hit';
    try{range.surroundContents(mark)}catch{break}
   }
  }
 }
}

// ---- 2. 命中计数与上一个/下一个跳转 ----
const wtMatchCounter=document.createElement('span'),wtPrevButton=document.createElement('button'),wtNextButton=document.createElement('button');
wtMatchCounter.id='wtMatchCount';
wtPrevButton.id='wtPrevMatch';wtPrevButton.type='button';wtPrevButton.textContent='▲';
wtPrevButton.title='上一个命中（Shift+Enter / Shift+F3）/ Previous match';
wtNextButton.id='wtNextMatch';wtNextButton.type='button';wtNextButton.textContent='▼';
wtNextButton.title='下一个命中（Enter / F3）/ Next match';
$('#searchRegexToggle')?.after(wtMatchCounter,wtPrevButton,wtNextButton);
function wtPaintNav(){
 const query=$('#query').value;
 // 查询为空或正则无效时不显示计数——否则会挂着上一次有效查询的过期数字。
 if(!query||!wtActiveRegex()||typeof wtSearchMatches==='undefined'||!wtSearchMatches||!wtSearchMatches.rows.length){wtMatchCounter.textContent='';return}
 const rows=wtSearchMatches.rows.length,total=wtSearchMatches.total;
 wtMatchCounter.textContent=wtNavPos>=0
  ?uiText(`第 ${wtNavPos+1}/${rows} 行命中`,`Hit ${wtNavPos+1} of ${rows}`)
  :uiText(`命中 ${rows} 行 · ${total} 处`,`${rows} rows · ${total} hits`);
}
function wtFocusRow(rid){
 wtFocusRid=rid;
 wtApplyFocusDecor();
}
// 虚拟滚动下目标行可能还没被绘制（requestScrollToRow 在 worker 过滤完成前是挂起的），
// 所以"当前命中行"的装饰记在 wtFocusRid 里，由绘制钩子在每次窗口重画后补上。
function wtApplyFocusDecor(){
 logPane.querySelectorAll('.wt-hit-row').forEach(x=>x.classList.remove('wt-hit-row'));
 logPane.querySelectorAll('.wt-hit-active').forEach(x=>x.classList.remove('wt-hit-active'));
 if(wtFocusRid<0)return;
 const target=logPane.querySelector('[data-row-id="'+wtFocusRid+'"]');if(!target)return;
 target.classList.add('wt-hit-row');
 target.querySelector('mark.wt-hit')?.classList.add('wt-hit-active');
}
function wtNavGo(delta){
 const list=(typeof wtSearchMatches!=='undefined'&&wtSearchMatches?.rows)||[];
 if(!list.length){wtPaintNav();return}
 // 和 locateEvidence 同理：跳转必须在日志视图里可见，切换要走 setTerminalView（它还管
 // 按钮按下态和输入焦点归属），不能只翻 terminalMode 标志。
 if(terminalMode&&typeof setTerminalView==='function')setTerminalView(false,{persist:false});
 wtNavPos=(((wtNavPos+delta)%list.length)+list.length)%list.length;
 const row=list[wtNavPos];
 followTail=false;
 // 命中行一定在当前过滤结果里；过滤还在 worker 里跑时 requestScrollToRow 会挂起目标，
 // setRows 收到新行集后立即补跳。
 logVirtual.requestScrollToRow(row);
 wtFocusRow(rowId(row));wtPaintNav();localizeControls();
}
wtPrevButton.onclick=()=>wtNavGo(-1);
wtNextButton.onclick=()=>wtNavGo(1);
// Enter 跳转时避开输入法组合状态（中文输入选词期间的 Enter 不能触发跳转）。
$('#query').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();wtNavGo(event.shiftKey?-1:1)}});
logPane.addEventListener('keydown',event=>{if(event.key==='F3'){event.preventDefault();wtNavGo(event.shiftKey?-1:1)}});

// ---- 3. 悬浮"回到底部"胶囊 ----
const wtPill=document.createElement('button');
wtPill.id='wtBackToBottom';wtPill.type='button';wtPill.hidden=true;
document.body.append(wtPill);
let wtPillNew=0,wtPillTimer=null,wtPillSession='';
function wtPillPaint(){
 wtPillTimer=null;
 const following=followTail&&!paused,visible=!terminalMode&&logPane.offsetParent!==null;
 if(following)wtPillNew=0;
 if(!visible||following){wtPill.hidden=true;return}
 wtPill.textContent=wtPillNew>0
  ?`↓ ${uiText('回到底部','Back to bottom')} · ${uiText(`${wtPillNew} 条新日志`,`${wtPillNew} new lines`)}`
  :`↓ ${uiText('回到底部','Back to bottom')}`;
 wtPill.hidden=false;
 const rect=logPane.getBoundingClientRect();
 wtPill.style.left=Math.max(8,rect.right-wtPill.offsetWidth-28)+'px';
 wtPill.style.top=Math.max(8,rect.bottom-wtPill.offsetHeight-16)+'px';
}
function wtPillPaintSoon(){if(wtPillTimer!==null)return;wtPillTimer=setTimeout(wtPillPaint,200)}
wtPill.onclick=()=>{wtPillNew=0;followButton.onclick();logPane.scrollTop=logPane.scrollHeight;wtPillPaint()};
onCoreEvent(message=>{
 if(message.type!=='log'||message.session!==active)return;
 if(followTail&&!paused){wtPillNew=0;if(!wtPill.hidden)wtPillPaintSoon()}
 else{wtPillNew++;wtPillPaintSoon()}
});
window.addEventListener('resize',wtPillPaintSoon);
// 跟随状态每一次变化都会经过 localizeControls（滚轮、指针、滚动探针、回车、跟随按钮），
// 包装它就能让胶囊随状态即时显隐，也顺带刷新时间戳按钮的多语言文案。
const localizeControlsBeforeWtPill=localizeControls;
localizeControls=()=>{localizeControlsBeforeWtPill();wtApplyTimeColumn();wtPillPaintSoon()};
if(typeof setTerminalView==='function'){const setTerminalViewBeforeWtPill=setTerminalView;setTerminalView=(...args)=>{const result=setTerminalViewBeforeWtPill(...args);
 // 终端视图期间 #terminal 是 display:none，虚拟滚动跳过了绘制；切回日志视图立即补一帧，
 // 高亮/命中装饰由绘制钩子一并补上。
 if(!terminalMode)logVirtual.paint(true);
 wtPillPaintSoon();return result}}

// ---- 4. 时间戳列开关 ----
const wtTimeButton=document.createElement('button');
wtTimeButton.id='toggleTimeColumn';wtTimeButton.type='button';
logActions.append(wtTimeButton);
function wtApplyTimeColumn(){
 const show=typeof wtSearchOptions==='undefined'||wtSearchOptions.showTime;
 logPane.classList.toggle('wt-hide-time',!show);
 wtTimeButton.setAttribute('aria-pressed',String(show));
 wtTimeButton.textContent=uiText('时间戳','Time');
}
wtTimeButton.onclick=()=>{wtSearchOptions.showTime=!wtSearchOptions.showTime;localStorage.logscopeShowTime=wtSearchOptions.showTime?'':'0';wtApplyTimeColumn()};

// ---- 5.（已移除）滚到顶部自动翻页 ----
// 虚拟滚动（log-virtual.js）之后整个缓冲是一个连续的滚动面，向上滚就能一直回看，
// 不再存在"页"的概念，原来的 wtAutoPageEarlier 连同名监听一起删除。

// ---- 挂接渲染管线并做初始绘制 ----
// 高亮与命中行装饰改挂在虚拟滚动的绘制钩子上：滚动换窗口不经过 render()，只有钩子
// 能保证新画出来的行也带上 <mark> 与 .wt-hit-row。
logVirtual.onPaint(()=>{wtApplyHighlights();wtApplyFocusDecor()});
const renderBeforeWtSearch=render;
render=(force)=>{renderBeforeWtSearch(force);
 // 会话切换后旧会话攒的"新日志"计数不再有意义（计数只统计 active 会话的到达）。
 if(logPane.dataset.session!==wtPillSession){wtPillSession=logPane.dataset.session;wtPillNew=0}
 wtPaintNav();wtPillPaintSoon()};
wtApplyTimeColumn();
wtPaintNav();
wtPillPaintSoon();
