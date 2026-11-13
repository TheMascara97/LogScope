'use strict';
// The input line on the output. WindTerm's whole feel is that the place the log arrives is the place
// you type: click anywhere in the output, the keyboard lands on a prompt under it, the line you type
// appears in the transcript, and Enter puts it on the wire. That is this file.
//
// It is a sibling of `#terminal`, never a child: `workspace-controls.js` replaces the whole of
// `#terminal.innerHTML` on every render, and its keydown handler claims Enter / Ctrl+A / Ctrl+C
// without looking at `e.target` — so a child input would be wiped on the next redraw and have its
// Enter stolen even before that.
//
// Line mode, not raw passthrough: this line builds one line and sends it with the session's line
// ending. Arrow keys, Tab completion and Ctrl chords stay in the terminal view, where xterm.js is
// the thing driving them. Two views, two jobs — this one is the log view's input.
const logComposer=document.createElement('div'),composerPrompt=document.createElement('span'),composerInput=document.createElement('input'),composerEol=document.createElement('span'),composerState=document.createElement('span');
logComposer.id='logComposer';
composerPrompt.textContent='›';composerPrompt.style.cssText='color:var(--green,#55d98b);font-weight:700';
composerInput.id='composerInput';composerInput.type='text';composerInput.autocomplete='off';composerInput.spellcheck=false;composerInput.setAttribute('aria-label','Input line');composerInput.disabled=true;
composerEol.id='composerEol';composerState.id='composerState';
composerEol.style.cssText='white-space:nowrap;opacity:.75';
composerState.style.cssText='white-space:nowrap;font-size:12px;opacity:.75';
// Only layout is set here: inline styles outrank the theme rules in appearance.css, so padding,
// the separator line and the font belong to the stylesheet — a hard-coded dark background or
// 13px font would keep this line looking the same in every theme, which is exactly what the
// WindTerm density pass is trying to avoid. `display` stays inline because paintComposer() toggles
// it between flex and none on every view switch.
logComposer.style.cssText='display:flex;align-items:center;gap:8px;flex-shrink:0';
composerInput.style.cssText='flex:1;background:transparent;border:0;outline:0';
logComposer.append(composerPrompt,composerInput,composerEol,composerState);
($('#terminalHost')||$('#terminal')).after(logComposer);

// Built at paint time, not at load time: a glyph table captured before the first language change
// would keep saying "无" in the English UI.
function composerEolLabel(eol){
 if(eol==='none')return T('行尾 无','EOL none');
 return T('行尾 ','EOL ')+({auto:'auto',cr:'␍',lf:'␊',crlf:'␍␊'}[eol]||eol);
}
function composerTarget(){
 const id=active;
 if(!id||!sessions.has(id))return {id,reason:T('没有会话：先新建或选择一个会话','No session: create or select one first')};
 if(String(id).startsWith('file:'))return {id,reason:T('这是导入的日志文件，不能发送','This is an imported log file; nothing can be sent')};
 const state=connectionStates.get(id);
 if(!readOnlySessions.get(id)&&state&&state!=='connected'&&state!=='connecting')return {id,reason:T('会话状态：','session state: ')+state+T('（断开后请先重新连接）',' (reconnect after a drop)')};
 return {id,reason:''};
}
// The line has to say what Enter will do before Enter is pressed: which session it writes to, which
// line ending the core will append, and — when there is nothing to write to — why the key does
// nothing. A prompt with no state is the "the input does nothing" half of the old complaint.
function paintComposer(){
 const {id,reason}=composerTarget();
 const eol=id?(sessionEols.get(id)||'auto'):'auto';
 composerEol.textContent=composerEolLabel(eol);
 composerState.textContent=reason||(id&&sessions.get(id)?sessions.get(id):'');
 composerState.style.color=reason?'#f6c453':'';
 composerInput.disabled=!!reason;
 composerInput.placeholder=reason?T('（不能发送：见右侧说明）','(cannot send — see the note on the right)'):T('输入后按 Enter 发送给当前会话；空行只发行尾，Esc 清行，↑↓ 回忆历史','Type and press Enter to send to this session; an empty line sends just the line ending, Esc clears, ↑↓ recalls history');
 // Set both ways, not just when hiding: switching back from the terminal view has to bring the line
 // back, and a one-armed conditional leaves it hidden for good.
 logComposer.style.display=terminalMode?'none':'flex';
}
// The keyboard belongs to the view that is showing. Both the view switch and a newly arrived session
// come through here, so "the view opened but nothing happens when I type" cannot happen.
function focusInputSurface(){
 if(terminalMode){terminals.get(active)?.term.focus();return}
 if(!composerInput.disabled)composerInput.focus();
}
// The keyboard is decided here, after `paintComposer` has settled whether this line can be typed
// into at all: `setTerminalView` focuses the surface before this wrapper runs, and a line that is
// about to be disabled — or was disabled a moment ago — would either lose that focus or refuse it.
const setTerminalViewBeforeComposer=setTerminalView;
setTerminalView=(on,options)=>{setTerminalViewBeforeComposer(on,options);paintComposer();focusInputSurface()};
const activateBeforeComposer=activate;
activate=id=>{activateBeforeComposer(id);paintComposer();focusInputSurface()};

let composerHistoryPosition=-1,composerDraft='';
composerInput.addEventListener('input',()=>composerHistoryPosition=-1);
composerInput.addEventListener('keydown',async e=>{
 if(e.key==='Escape'){e.preventDefault();composerInput.value='';composerHistoryPosition=-1;return}
 if(e.key==='ArrowUp'||e.key==='ArrowDown'){
  const history=commandHistory();
  if(!history.length)return;
  // stopPropagation is not enough here: nothing above this line listens on Arrow keys, but the
  // history dialog and the field below both keep their own position, and sharing one would make ↑
  // here move the cursor there. This line keeps its own.
  e.preventDefault();
  if(composerHistoryPosition===-1)composerDraft=composerInput.value;
  composerHistoryPosition=Math.max(-1,Math.min(history.length-1,composerHistoryPosition+(e.key==='ArrowUp'?1:-1)));
  composerInput.value=composerHistoryPosition<0?composerDraft:history[composerHistoryPosition];
  composerInput.setSelectionRange(composerInput.value.length,composerInput.value.length);
  return;
 }
 if(e.key!=='Enter'||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
 e.preventDefault();
 // Shift+Enter is left alone on purpose: nothing here is multi-line, and swallowing it would make a
 // key that visibly does nothing.
 const value=composerInput.value,ok=await sendFromSurface(value,active,'composer');
 // A refusal puts the text back itself, into this surface and no other, so this only has to clear on
 // success and keep the keyboard where it was.
 if(ok)composerInput.value='';
 composerHistoryPosition=-1;
 composerInput.focus();
});
// Clicking the output hands the keyboard to this line, the way clicking a terminal does — but only
// when nothing is selected, so selecting text to copy still works and does not yank focus away.
$('#terminal').addEventListener('click',()=>{if(getSelection().isCollapsed)focusInputSurface()});

onCoreEvent(m=>{
 if(['session','session.state','session.mode','session.eol'].includes(m.type))paintComposer();
});
const localizeBeforeComposer=localize;
localize=()=>{localizeBeforeComposer();composerInput.setAttribute('aria-label',T('输入行','Input line'));paintComposer()};
paintComposer();
