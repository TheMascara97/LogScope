'use strict';
// 输出区自由选择/复制/粘贴（原生文本选择，记事本手感）。
// 早期版本把选择记成"行对象区间"并自绘 .vt-sel 底色：跨行整段复制没问题，但用户要的是
// 记事本那样——鼠标拖到哪个字符就选到哪个字符、Ctrl+C 抄走的就是屏幕上框住的那段。
// 虚拟滚动下 DOM 只有视口窗口行，所以原生选择天然只覆盖"看得见的文本"（和 Notepad++
// 选择文档可见内容一致）；整段缓存（含未渲染行）另有显式入口 lselCopyAll（右键菜单/
// 工具），不和自由选择抢语义。workstation.css 已放开 #terminal 的 user-select。
// 拖出视口边缘时浏览器不会自己扩选：pointermove 记录方向，定时器滚动窗口并用
// Selection.extend 把焦点推到新渲染的首/末行，接近 Notepad++ 的边缘拖选体验。
// 全局一律 lsel 前缀。加载顺序：workspace-controls.js 之后（覆盖它的 selectLogs/copyLogs）。
let lselEdgeDir=0,lselDrag=false,lselStatusTimer=0;
function lselNative(){
 const sel=getSelection();
 if(!sel||sel.isCollapsed||!sel.rangeCount)return null;
 const r=sel.getRangeAt(0);
 if(!logPane.contains(r.startContainer)||!logPane.contains(r.endContainer))return null;
 return sel;
}
function lselNativeText(){const sel=lselNative();return sel?sel.toString():''}
function lselRenderedRows(){return [...logPane.querySelectorAll('.log-row')]}
function lselStatus(msg){$('#status').textContent=msg}
// 覆盖 workspace-controls 的按钮/快捷键实现（函数声明可重赋值；按钮 onclick 是加载期捕获的
// 旧引用，必须一并重绑）。contextmenu 与旧 keydown 按名字调用，运行时解析到新实现。
function selectLogs(){
 if(terminalMode){terminals.get(active)?.term.selectAll();return}
 const rows=lselRenderedRows();
 if(!rows.length){lselStatus(uiText('没有可选择的日志','Nothing to select'));return}
 followTail=false;
 const range=document.createRange();
 range.setStartBefore(rows[0]);range.setEndAfter(rows[rows.length-1]);
 const sel=getSelection();sel.removeAllRanges();sel.addRange(range);logPane.focus();
 lselStatus(uiText(`已选择窗口内 ${rows.length.toLocaleString()} 行（Ctrl+C 复制）`,`Selected ${rows.length.toLocaleString()} rendered rows (Ctrl+C to copy)`));
}
async function copyLogs(){
 if(terminalMode){const term=terminals.get(active)?.term;const text=term?.getSelection()||'';await window.core.copyText(text);lselStatus(uiText('已复制终端选择','Terminal selection copied'));return}
 const text=lselNativeText();
 if(!text){lselStatus(uiText('先用鼠标拖选要复制的内容；Ctrl+A 可全选窗口内全部行','Select text with the mouse first; Ctrl+A selects every rendered row'));return}
 await window.core.copyText(text);
 lselStatus(uiText(`已复制所选内容（${text.length.toLocaleString()} 字符）`,`Copied selection (${text.length.toLocaleString()} chars)`));
}
selectButton.onclick=selectLogs;
copyButton.onclick=copyLogs;
async function lselPaste(){
 let text='';
 try{text=await navigator.clipboard.readText()}
 catch(e){lselStatus(uiText('读取剪贴板失败：','Clipboard read failed: ')+e.message);return}
 lselInsert(text);
}
function lselInsert(text){
 if(!text)return;
 // 优先贴到输出下方的输入行（log-composer.js）；导入文件等无会话场景它被禁用，退回定时发送框。
 const composer=$('#composerInput');
 const input=composer&&!composer.disabled?composer:$('#command');
 input.value+=text;input.focus();
 input.dispatchEvent(new Event('input',{bubbles:true}));
 lselStatus(uiText('已粘贴到输入框','Pasted into the input line'));
}
// 边缘拖选：按住左键把指针移出窗格上下边缘时滚动虚拟窗口，并把选择焦点扩展到
// 新渲染的首/末行（Selection.extend 移动 focus 端，anchor 不动，选区因此逐行增长）。
logPane.addEventListener('pointerdown',e=>{lselDrag=e.button===0&&!terminalMode;lselEdgeDir=0});
logPane.addEventListener('pointermove',e=>{
 if(!lselDrag||!(e.buttons&1)){lselEdgeDir=0;return}
 const rect=logPane.getBoundingClientRect();
 lselEdgeDir=e.clientY<rect.top+2?-1:e.clientY>rect.bottom-2?1:0;
});
window.addEventListener('pointerup',()=>{lselDrag=false;lselEdgeDir=0});
setInterval(()=>{
 if(!lselEdgeDir||!lselNative())return;
 followTail=false;
 logPane.scrollTop+=lselEdgeDir*24;
 const rows=lselRenderedRows();if(!rows.length)return;
 const sel=getSelection();
 const el=lselEdgeDir<0?rows[0]:rows[rows.length-1];
 try{sel.extend(el,lselEdgeDir<0?0:el.childNodes.length)}catch{}
},32);
// 选择变化即时报字符数（Notepad++ 状态栏行为）；节流到一帧一次，拖选时不刷屏。
document.addEventListener('selectionchange',()=>{
 if(lselStatusTimer)return;
 lselStatusTimer=setTimeout(()=>{lselStatusTimer=0;
  const sel=lselNative();
  if(sel)lselStatus(uiText(`已选择 ${sel.toString().length.toLocaleString()} 字符（Ctrl+C 复制，Esc 取消）`,`${sel.toString().length.toLocaleString()} chars selected (Ctrl+C to copy, Esc to clear)`));
 },80);
});
logPane.addEventListener('keydown',e=>{
 if(e.defaultPrevented)return;
 const k=e.key.toLowerCase();
 if((e.ctrlKey||e.metaKey)&&k==='v'){e.preventDefault();lselPaste()}
 else if(e.key==='Escape'&&lselNative()){getSelection().removeAllRanges();lselStatus(uiText('已取消选择','Selection cleared'))}
},true);
// 整段缓存复制：自由选择只覆盖渲染窗口，未渲染的行要靠这个显式入口（数据模型取行，有上限）。
const LSEL_COPY_CAP=100000;
function lselRowText(row){return row.time?'['+row.time+'] '+row.text:String(row.text)}
async function lselCopyAll(){
 const rows=logVirtual.rows;
 if(!rows.length){lselStatus(uiText('没有可复制的日志','No logs to copy'));return}
 const capped=rows.slice(0,LSEL_COPY_CAP);
 await window.core.copyText(capped.map(lselRowText).join('\n'));
 lselStatus(uiText(
  `已复制 ${capped.length.toLocaleString()} 行${rows.length>capped.length?`（超过 ${LSEL_COPY_CAP.toLocaleString()} 行上限已截断；完整内容见保存文件）`:''}`,
  `Copied ${capped.length.toLocaleString()} rows${rows.length>capped.length?` (capped at ${LSEL_COPY_CAP.toLocaleString()}; full content is in the saved file)`:''}`));
}
// 会话切换/关闭后渲染窗口整体替换，原生选择随之失效，无需额外清理。
