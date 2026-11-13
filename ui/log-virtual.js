'use strict';
// 真虚拟滚动：#terminal 只渲染视口 ± overscan 的行，上下用 spacer div 撑起总高度。
// 行高是变化的（长行会换行、多行堆栈可展开），所以用"估算高度 + 渲染后实测缓存"：
// 高度按 rowId 存在 vtHeights，块高和（vtBlockSums，每 VT_BLOCK 行一块）负责
// offset↔行号 定位；每次绘制后实测本窗口行高、只重算受影响的块，并按"首个可见行"
// 锚点补偿 scrollTop，避免实测修正引起跳动。
// 全局一律 vt 前缀（wt 已被 output-enhancements 占用）。加载顺序：log-navigation.js
// 之后（用 rowId）、workspace-controls.js 之前（它的 render 调 logVirtual.setRows）。
// formatLogRow 定义在 workspace-controls.js 末尾，只在绘制期调用，加载期不碰。
const VT_BLOCK=64,VT_OVERSCAN=12,VT_HEIGHT_EST=28;
const vtPane=$('#terminal');
let vtRows=[],vtHeights=new Map(),vtEst=VT_HEIGHT_EST,vtEstCalibrated=false;
let vtBlockSums=new Float64Array(0),vtTotal=0;
let vtWinStart=-1,vtWinEnd=-1,vtPainted=false,vtPaintHooks=[],vtPendingRow=null,vtRafPending=false,vtSession='';
function vtRowHeight(i){const h=vtHeights.get(rowId(vtRows[i]));return h===undefined?vtEst:h}
function vtBlockCount(){return Math.max(1,Math.ceil(vtRows.length/VT_BLOCK))}
function vtRebuildBlock(b){let s=0;const from=b*VT_BLOCK,to=Math.min(vtRows.length,from+VT_BLOCK);for(let i=from;i<to;i++)s+=vtRowHeight(i);vtBlockSums[b]=s}
function vtRebuildTotals(){let total=0;for(let b=0;b<vtBlockSums.length;b++)total+=vtBlockSums[b];vtTotal=total}
function vtRebuild(fromIdx=0){const n=vtBlockCount();if(vtBlockSums.length!==n){const next=new Float64Array(n);next.set(vtBlockSums.subarray(0,Math.min(n,vtBlockSums.length)));vtBlockSums=next}for(let b=Math.floor(fromIdx/VT_BLOCK);b<n;b++)vtRebuildBlock(b);vtRebuildTotals()}
function vtCumBefore(i){if(i<=0)return 0;let y=0;const b=Math.min(Math.floor(i/VT_BLOCK),vtBlockSums.length-1);for(let k=0;k<b;k++)y+=vtBlockSums[k];for(let r=b*VT_BLOCK;r<i;r++)y+=vtRowHeight(r);return y}
function vtIndexAt(y){if(!vtRows.length)return 0;if(y<=0)return 0;let acc=0;for(let b=0;b<vtBlockSums.length;b++){if(acc+vtBlockSums[b]>y){const from=b*VT_BLOCK,to=Math.min(vtRows.length,from+VT_BLOCK);for(let i=from;i<to;i++){const h=vtRowHeight(i);if(acc+h>y)return i;acc+=h}return Math.max(0,to-1)}acc+=vtBlockSums[b]}return Math.max(0,vtRows.length-1)}
function vtPaint(force,stickBottom){
 if(!vtRows.length){vtPainted=false;return}
 // 终端视图下 #terminal 是 display:none，clientHeight 为 0；跳过绘制，切回来时
 // setTerminalView 包装器（output-enhancements.js）会强制补一帧。
 if(vtPane.offsetParent===null){vtPainted=false;return}
 const viewH=vtPane.clientHeight||600;
 let start,end;
 if(stickBottom){end=vtRows.length;start=Math.max(0,vtIndexAt(Math.max(0,vtTotal-viewH))-VT_OVERSCAN)}
 else{const top=vtPane.scrollTop;start=Math.max(0,vtIndexAt(top)-VT_OVERSCAN);end=Math.min(vtRows.length,vtIndexAt(top+viewH)+1+VT_OVERSCAN)}
 if(!force&&vtPainted&&start===vtWinStart&&end===vtWinEnd)return;
 const anchorIdx=stickBottom?-1:vtIndexAt(vtPane.scrollTop),anchorDelta=stickBottom?0:vtPane.scrollTop-vtCumBefore(anchorIdx);
 let html='<div class="vt-spacer" id="vtTop"></div>';
 for(let i=start;i<end;i++){const row=vtRows[i];html+=formatLogRow(row).replace('class="log-row','data-row-id="'+rowId(row)+'" data-vt-idx="'+i+'" class="log-row'+(i%2===1?' vt-odd':''))}
 html+='<div class="vt-spacer" id="vtBottom"></div>';
 vtPane.innerHTML=html;
 const topEl=$('#vtTop'),bottomEl=$('#vtBottom');
 topEl.style.height=vtCumBefore(start)+'px';
 bottomEl.style.height=Math.max(0,vtTotal-vtCumBefore(end))+'px';
 // 实测本窗口行高；差异修正块高和与总高，再按锚点补偿 scrollTop。
 const dirty=new Set();let measured=false;
 for(const el of vtPane.querySelectorAll('.log-row')){
  const idx=Number(el.dataset.vtIdx);if(!(idx>=start&&idx<end))continue;
  const h=el.offsetHeight;if(h<=0)continue;
  if(!vtEstCalibrated){vtEst=h;vtEstCalibrated=true;vtRebuild(0);dirty.clear();measured=false;
   topEl.style.height=vtCumBefore(start)+'px';bottomEl.style.height=Math.max(0,vtTotal-vtCumBefore(end))+'px';
   vtHeights.set(rowId(vtRows[idx]),h);dirty.add(Math.floor(idx/VT_BLOCK));measured=true;continue}
  if(Math.abs(h-vtRowHeight(idx))>=0.5){vtHeights.set(rowId(vtRows[idx]),h);dirty.add(Math.floor(idx/VT_BLOCK));measured=true}
 }
 if(measured){
  for(const b of dirty)vtRebuildBlock(b);
  vtRebuildTotals();
  bottomEl.style.height=Math.max(0,vtTotal-vtCumBefore(end))+'px';
  if(stickBottom)vtPane.scrollTop=vtPane.scrollHeight;
  else{const y=vtCumBefore(anchorIdx)+anchorDelta;if(Math.abs(vtPane.scrollTop-y)>0.5)vtPane.scrollTop=y}
 }else if(stickBottom)vtPane.scrollTop=vtPane.scrollHeight;
 vtWinStart=start;vtWinEnd=end;vtPainted=true;
 for(const fn of vtPaintHooks){try{fn()}catch(e){console.error(e)}}
}
function vtSchedulePaint(force){if(vtRafPending)return;vtRafPending=true;requestAnimationFrame(()=>{vtRafPending=false;if(!vtRows.length||vtPane.offsetParent===null)return;const viewH=vtPane.clientHeight||600,top=vtPane.scrollTop;const a=vtIndexAt(top),b=vtIndexAt(top+viewH)+1;if(force||!vtPainted||a<vtWinStart||b>vtWinEnd)vtPaint(force)})}
function vtSameRows(a,b){return a.length===b.length&&(a.length===0||(a[0]===b[0]&&a[a.length-1]===b[b.length-1]&&a[Math.floor(a.length/2)]===b[Math.floor(b.length/2)]))}
function vtPrefixedBy(oldRows,newRows){
 // append-only 快速路径：旧数组是新数组的前缀（采样头/中/尾三点，行对象身份唯一，误判概率可忽略）。
 if(newRows.length<=oldRows.length||oldRows.length===0)return false;
 const k=oldRows.length-1;
 return newRows[0]===oldRows[0]&&newRows[k]===oldRows[k]&&newRows[Math.floor(k/2)]===oldRows[Math.floor(k/2)];
}
function vtSetRows(rows,opts={}){
 const old=vtRows;
 const sessionChanged=opts.session!==undefined&&opts.session!==vtSession;
 if(sessionChanged)vtSession=opts.session;
 vtRows=rows;
 if(rows.length===0){vtClear();return}
 if(vtHeights.size>400000){vtHeights.clear();vtEstCalibrated=false;vtEst=VT_HEIGHT_EST}
 if(sessionChanged){vtWinStart=vtWinEnd=-1;vtRebuild(0)}
 else if(vtSameRows(old,rows)){/* 高度和不变 */}
 else if(vtPrefixedBy(old,rows))vtRebuild(old.length);
 else vtRebuild(0);
 if(opts.follow||opts.bottom||sessionChanged){vtPaint(true,true);return}
 if(vtPendingRow){const target=vtPendingRow;vtPendingRow=null;if(vtScrollToRow(target,'center'))return}
 vtPaint(!!opts.force);
}
function vtScrollToRow(row,align='center'){
 const idx=vtRows.indexOf(row);if(idx<0)return false;
 const viewH=vtPane.clientHeight||600;let y=vtCumBefore(idx);
 if(align==='center')y-=(viewH-vtRowHeight(idx))/2;
 else if(align==='nearest'){const top=vtPane.scrollTop;if(y>=top&&y+vtRowHeight(idx)<=top+viewH){vtPaint(true);return true}}
 vtPane.scrollTop=Math.max(0,y);vtPaint(true);return true;
}
function vtScrollByPages(n){const viewH=vtPane.clientHeight||600;const max=Math.max(0,vtTotal-viewH);vtPane.scrollTop=Math.max(0,Math.min(max,vtPane.scrollTop+n*(viewH-40)));vtPaint(true);return true}
function vtClear(){vtRows=[];vtBlockSums=new Float64Array(0);vtTotal=0;vtWinStart=vtWinEnd=-1;vtPainted=false;vtPendingRow=null;vtSession=''}
vtPane.addEventListener('scroll',()=>vtSchedulePaint(),{passive:true});
let vtResizeTimer=null,vtLastWidth=vtPane.clientWidth;
new ResizeObserver(()=>{
 if(vtPane.offsetParent===null)return;
 const width=vtPane.clientWidth,widthChanged=Math.abs(width-vtLastWidth)>1;vtLastWidth=width;
 clearTimeout(vtResizeTimer);
 if(widthChanged){
  // 宽度变化会改变换行 → 全部实测高度作废；防抖到拖动结束后重算，并锚回原首行。
  vtResizeTimer=setTimeout(()=>{const anchorRow=vtRows[vtIndexAt(vtPane.scrollTop)];vtHeights.clear();vtEstCalibrated=false;vtEst=VT_HEIGHT_EST;vtRebuild(0);if(anchorRow&&!vtScrollToRow(anchorRow,'start'))vtPaint(true)},120);
 }else vtSchedulePaint(true);
}).observe(vtPane);
const logVirtual={
 setRows:vtSetRows,
 paint(force){vtPaint(!!force)},
 schedulePaint:vtSchedulePaint,
 scrollToRow:vtScrollToRow,
 requestScrollToRow(row,align='center'){if(!vtScrollToRow(row,align))vtPendingRow=row},
 scrollByPages:vtScrollByPages,
 scrollToBottom(){vtPaint(true,true)},
 onPaint(fn){vtPaintHooks.push(fn)},
 clear:vtClear,
 get rows(){return vtRows},
 indexOfRow(row){return vtRows.indexOf(row)},
};
