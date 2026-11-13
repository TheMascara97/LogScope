'use strict';
// Persistent drop indicator. Overload used to be a transient #status sentence that the
// next status message overwrote, so "did anything get dropped?" was unanswerable a minute
// later. This badge stays in the filter row whenever any of the three bounded queues has
// dropped data since the last reset, and clicking it opens the breakdown:
//   - core display drops (log lines the capture queue refused; raw file is unaffected)
//   - raw-writer dropped bytes (disk queue overflow; these bytes are NOT in the raw file)
//   - terminal display skipped bytes (xterm backlog cap; raw file and log view unaffected)
// Counters are cumulative per core process; a restart lowers them, which re-baselines
// automatically instead of showing negative deltas.
let dropCoreLines=0,dropWriteBytes=0;
const dropBaseline={lines:0,writeBytes:0,termBytes:0};
const dropBadge=document.createElement('button');dropBadge.id='dropBadge';dropBadge.type='button';dropBadge.hidden=true;
document.querySelector('.filter').append(dropBadge);
function dropTermBytes(){let total=0;if(typeof terminals!=='undefined')for(const item of terminals.values())if(typeof item.droppedBytes==='function')total+=item.droppedBytes();return total}
function dropDeltas(){
 // A core restart resets its counters; treat a decrease as a new baseline.
 if(dropCoreLines<dropBaseline.lines)dropBaseline.lines=dropCoreLines;
 if(dropWriteBytes<dropBaseline.writeBytes)dropBaseline.writeBytes=dropWriteBytes;
 const term=dropTermBytes();
 if(term<dropBaseline.termBytes)dropBaseline.termBytes=term;
 return {lines:dropCoreLines-dropBaseline.lines,writeBytes:dropWriteBytes-dropBaseline.writeBytes,termBytes:term-dropBaseline.termBytes};
}
function updateDropBadge(){
 const d=dropDeltas(),any=d.lines>0||d.writeBytes>0||d.termBytes>0;
 dropBadge.hidden=!any;
 if(!any){dropBadge.title='';return}
 const parts=[];
 if(d.lines)parts.push(uiText(d.lines+' 行',d.lines+' lines'));
 if(d.writeBytes)parts.push(uiText('写盘 '+d.writeBytes+' 字节','disk '+d.writeBytes+' B'));
 if(d.termBytes)parts.push(uiText('终端 '+d.termBytes+' 字节','term '+d.termBytes+' B'));
 dropBadge.textContent=uiText('已丢弃：','Dropped: ')+parts.join(' / ');
 dropBadge.title=uiText('存在过载丢弃，点击查看明细；原始日志是否受影响见明细','Overload drops recorded; click for the breakdown and whether raw logs are affected');
}
onCoreEvent(m=>{if(m.type==='core.metrics'){dropCoreLines=m.droppedLines||0;dropWriteBytes=(m.writers||[]).reduce((a,w)=>a+(w.droppedBytes||0),0);updateDropBadge()}});
// Terminal drops do not ride core.metrics; poll the per-session counters on the same cadence.
setInterval(updateDropBadge,2000);
dropBadge.onclick=()=>{
 // A programmatic close() removes the dialog only when the close event fires (a task
 // later); sweep any stale closed instance so a same-task reopen cannot find it by id.
 for(const stale of document.querySelectorAll('#dropDetails'))if(!stale.open)stale.remove();
 const d=document.createElement('dialog');d.id='dropDetails';d.className='manager-dialog';
 const title=document.createElement('h3'),hint=document.createElement('p'),body=document.createElement('pre');
 title.textContent=uiText('丢弃与过载明细','Drops and overload details');
 hint.textContent=uiText('三类计数含义不同：采集丢行只影响日志显示（原始文件不受影响）；写盘丢字节意味着这些字节未进入原始文件；终端跳过字节只影响终端显示。清零只重置本提示的基线，不删除任何日志。','The three counters mean different things: capture drops affect only the log display (raw files are unaffected); raw-writer dropped bytes never reached the raw file; terminal-skipped bytes affect only the terminal view. Reset only re-baselines this indicator; no logs are deleted.');
 const draw=()=>{const x=dropDeltas();body.textContent=uiText('采集显示丢行：','Capture display dropped lines: ')+x.lines+'\n'+uiText('写盘丢弃字节：','Raw-writer dropped bytes: ')+x.writeBytes+'\n'+uiText('终端显示跳过字节：','Terminal display skipped bytes: ')+x.termBytes};
 const reset=document.createElement('button'),close=document.createElement('button');
 reset.type='button';reset.textContent=uiText('清零计数','Reset counters');
 reset.onclick=()=>{dropBaseline.lines=dropCoreLines;dropBaseline.writeBytes=dropWriteBytes;dropBaseline.termBytes=dropTermBytes();draw();updateDropBadge()};
 close.type='button';close.textContent=uiText('关闭','Close');
 const refresh=setInterval(draw,1000);
 // Remove synchronously on close: the close event fires a task later, and reopening the
 // badge in the same task would otherwise find the stale closed dialog by id.
 const finish=()=>{clearInterval(refresh);d.remove()};
 close.onclick=()=>{d.close();finish()};
 d.onclose=finish;
 d.append(title,hint,body,reset,close);document.body.append(d);draw();d.showModal();
};
const localeBeforeDropIndicator=localize;localize=()=>{localeBeforeDropIndicator();updateDropBadge()};updateDropBadge();
