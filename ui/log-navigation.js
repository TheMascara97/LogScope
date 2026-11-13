'use strict';
const logAnchors=new Map(),visibleLogRows=new Map(),rowIdentity=new WeakMap();let nextRowIdentity=1;
function rowId(row){if(!rowIdentity.has(row))rowIdentity.set(row,nextRowIdentity++);return rowIdentity.get(row)}
// 虚拟滚动（log-virtual.js）取代了 500 行分页：logAnchors 仅剩历史消费者（replay-tools、
// 测试、followButton 包装器）在做无害的 delete/set，定位一律走 logVirtual.scrollToRow。
function locateEvidence(session,row){const all=lines.get(session);if(!all?.includes(row)){$('#status').textContent=uiText('原日志已被缓存裁剪或会话已关闭，请搜索已保存文件','Evidence was evicted or the session closed; search the saved file');return false}$('#query').value='';levelFilter.value='ALL';logAnchors.delete(session);followTail=false;paused=false;activate(session);
 // Through `setTerminalView`, not by flipping the flag here: the view switch also owns the pressed
 // state of the toggle, the input line under the output and which surface gets the keyboard, and a
 // jump that only moved the two panes left the rest of the view disagreeing with it.
 if(typeof setTerminalView==='function')setTerminalView(false,{persist:false});
 render(true);
 if(!logVirtual.scrollToRow(row,'center')){$('#status').textContent=uiText('定位日志已被裁剪或过滤，已回到最新位置','Anchor was evicted or filtered; showing latest rows');logVirtual.scrollToBottom();return false}
 logPane.querySelector('[data-row-id="'+rowId(row)+'"]')?.classList.add('evidence-focus');
 return true}
