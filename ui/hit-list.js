'use strict';
// 命中列表：把 worker 过滤发布的 wtSearchMatches（rule-pipeline.js）展开成可点击的清单，
// 点击任意一条 → 虚拟滚动定位到该行并标为当前命中（与 ▲▼ 导航共享 wtNavPos/wtFocusRow）。
// 面板按需增量渲染（每批 500 条 + "加载更多"），十万级命中也不会一次性建 DOM。
// 加载顺序：output-enhancements.js 之后（依赖 wtSearchMatches、wtNavGo 一族、logVirtual）。
const wtHitListButton=document.createElement('button');
wtHitListButton.id='wtHitListToggle';wtHitListButton.type='button';
wtHitListButton.setAttribute('aria-pressed','false');
wtNextButton.after(wtHitListButton);
const wtHitPanel=document.createElement('div');
wtHitPanel.id='wtHitList';wtHitPanel.hidden=true;
document.body.append(wtHitPanel);
const WT_HIT_PAGE=500;
let wtHitShown=0,wtHitDebounce=null;
function wtHitRows(){return (typeof wtSearchMatches!=='undefined'&&wtSearchMatches?.rows)||[]}
function wtHitSnippet(row){
 const text=String(row.text||'');
 const head=text.slice(0,240);
 const re=wtActiveRegex();
 let hit=null;
 if(re){re.lastIndex=0;const m=re.exec(text);if(m&&m[0].length&&m.index<head.length)hit=[m.index,Math.min(m.index+m[0].length,head.length)]}
 if(!hit)return esc(head)+(text.length>head.length?'…':'');
 return esc(head.slice(0,hit[0]))+'<mark>'+esc(head.slice(hit[0],hit[1]))+'</mark>'+esc(head.slice(hit[1]))+(text.length>head.length?'…':'');
}
function wtHitAppendMore(){
 const rows=wtHitRows(),end=Math.min(rows.length,wtHitShown+WT_HIT_PAGE);
 const frag=document.createDocumentFragment();
 for(let i=wtHitShown;i<end;i++){
  const row=rows[i];
  const b=document.createElement('button');b.type='button';b.className='hit-item';b.dataset.hit=String(i);
  b.innerHTML=`<small>#${i+1}</small>${row.time?esc(row.time)+' ':''}<b>${esc(row.level||'INFO')}</b> ${wtHitSnippet(row)}`;
  b.onclick=()=>wtHitJump(i);
  frag.append(b);
 }
 wtHitShown=end;
 wtHitPanel.querySelector('.hit-more')?.remove();
 wtHitPanel.append(frag);
 if(wtHitShown<rows.length){
  const more=document.createElement('button');more.type='button';more.className='hit-more';
  more.textContent=uiText(`加载更多（剩余 ${(rows.length-wtHitShown).toLocaleString()} 行）`,`Load more (${(rows.length-wtHitShown).toLocaleString()} rows left)`);
  more.onclick=()=>wtHitAppendMore();
  wtHitPanel.append(more);
 }
}
function wtHitRebuild(){
 const rows=wtHitRows();
 wtHitShown=0;
 wtHitPanel.replaceChildren();
 if(!rows.length){wtHitPanel.hidden=true;wtHitListButton.setAttribute('aria-pressed','false');return}
 const head=document.createElement('div');head.className='hit-head';
 head.textContent=uiText(`命中 ${rows.length.toLocaleString()} 行 · ${wtSearchMatches.total.toLocaleString()} 处（点击跳转）`,`${rows.length.toLocaleString()} rows · ${wtSearchMatches.total.toLocaleString()} hits — click to jump`);
 wtHitPanel.append(head);
 wtHitAppendMore();
}
function wtHitPlace(){
 const anchor=(wtMatchCounter.getBoundingClientRect().top?wtMatchCounter:$('#query')).getBoundingClientRect();
 wtHitPanel.style.top=Math.min(anchor.bottom+6,innerHeight-160)+'px';
 wtHitPanel.style.left=Math.max(8,Math.min(anchor.left,innerWidth-wtHitPanel.offsetWidth-8))+'px';
}
function wtHitJump(i){
 const rows=wtHitRows(),row=rows[i];if(!row)return;
 if(terminalMode&&typeof setTerminalView==='function')setTerminalView(false,{persist:false});
 wtNavPos=i;followTail=false;
 logVirtual.requestScrollToRow(row);
 wtFocusRow(rowId(row));wtPaintNav();localizeControls();
 wtHitPanel.querySelectorAll('.hit-item.active').forEach(x=>x.classList.remove('active'));
 const item=wtHitPanel.querySelector('[data-hit="'+i+'"]');
 if(item){item.classList.add('active');item.scrollIntoView({block:'nearest'})}
}
function wtHitClose(){wtHitPanel.hidden=true;wtHitListButton.setAttribute('aria-pressed','false')}
wtHitListButton.onclick=()=>{
 if(!wtHitPanel.hidden){wtHitClose();return}
 if(!wtHitRows().length){$('#status').textContent=uiText('没有命中行可列出；先在搜索框输入内容','No matching rows to list; type a search first');return}
 wtHitRebuild();
 wtHitPanel.hidden=false;wtHitListButton.setAttribute('aria-pressed','true');
 wtHitPlace();
};
wtHitPanel.addEventListener('keydown',e=>{if(e.key==='Escape')wtHitClose()});
document.addEventListener('pointerdown',e=>{
 if(!wtHitPanel.hidden&&!wtHitPanel.contains(e.target)&&e.target!==wtHitListButton)wtHitClose();
});
window.addEventListener('resize',()=>{if(!wtHitPanel.hidden)wtHitPlace()});
// 结果集变化（新查询、新日志触发重过滤）后按需刷新面板；防抖避免跟着流式渲染抖动。
const renderBeforeHitList=render;
render=(force)=>{
 renderBeforeHitList(force);
 if(wtHitPanel.hidden)return;
 clearTimeout(wtHitDebounce);
 wtHitDebounce=setTimeout(()=>{
  if(wtHitPanel.hidden)return;
  const activeItem=wtHitPanel.querySelector('.hit-item.active');
  const keep=activeItem?Number(activeItem.dataset.hit):-1;
  const open=wtHitPanel.scrollTop;
  wtHitRebuild();
  if(keep>=0&&keep<wtHitRows().length){const it=wtHitPanel.querySelector('[data-hit="'+keep+'"]');it?.classList.add('active')}
  wtHitPanel.scrollTop=open;
 },250);
};
const localizeBeforeHitList=localize;
localize=()=>{localizeBeforeHitList();wtHitListButton.textContent=uiText('命中列表','Hit list');if(!wtHitPanel.hidden)wtHitRebuild()};
localize();
