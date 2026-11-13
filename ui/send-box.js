'use strict';
// The send box is the terminal's input line: you type into it and press Enter, the line goes out
// exactly as typed, and it is echoed into the tab so a session reads like a transcript instead of a
// series of diagnostics. Three things a terminal does that this box has to do too, because without
// them "the send did nothing" and "the device said nothing" are indistinguishable:
//   * every write is echoed into the tab as one plain line — the text as typed, the terminator as
//     a glyph — and the transport report (port, framing, byte count, driver queue) lives in the
//     strip under the box and in the row's tooltip, not inside the echo;
//   * Enter on an empty box sends the terminator alone, which is how a serial console is woken and
//     how a shell prints its next prompt;
//   * the keyboard stays in the box after a send, and the view follows the echo.
// Two session families need different treatment, and the core reports which one a tab is:
//   direct   : pty / serial / tcp / telnet — bytes are written into the live stream
//   exec     : ssh tail -F, adb logcat, cmd /C — the stream ignores stdin, so the core
//              runs the command as a one-shot child and merges its output into the tab
const T=(zh,en)=>typeof uiText==='function'?uiText(zh,en):zh;
const readOnlySessions=new Map(),sessionModes=new Map(),sessionKinds=new Map(),execStates=new Map(),sessionEols=new Map(),sendNotes=new Map(),sendEchoNotes=new Map(),queueNotes=new Map();
let lastSend=null,echoSeen=false,echoTimer=null,confirmTimer=null;
// Declared here rather than where they are built: the listener below is registered with the rest
// of the UI's listeners, which replay any message that arrived before this file loaded, and a
// replayed send must find the strip and the badge already bound rather than in their dead zone.
let sendBar,commandBox,sendButton,eolSelect,modeButton,badge,strip,echoLine;

// Timestamps in the same shape the core uses (Qt::ISODateWithMs), so a locally generated row
// sorts and reads exactly like every row the device produced.
function stamp(){const d=new Date(),pad=(n,width=2)=>String(n).padStart(width,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`}
// Terminators are invisible in a text box, and "the device answers nothing" is usually a device
// that wants CRLF where the user sent CR. Show them, the way a hex editor would.
function glyphs(bytes){return bytes.map(byte=>byte==='0d'?'␍':byte==='0a'?'␊':byte==='09'?'⇥':'\\x'+byte).join('')}
function hexLine(bytes){return bytes.slice(0,48).map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ')+(bytes.length>48?'  … '+T('共 ','of ')+bytes.length+' B':'')}

// Everything the transport can say about one write: the facts on the first line, the bytes on the
// second. This is diagnosis, so it belongs in the strip under the box and in the row's tooltip —
// the echo itself has to stay as plain as the text the user typed, or every command reads like a
// failure report.
function reportFor(message,terminator){
 const isHex=message.eol===undefined;
 const body=isHex?String(message.payload??'').trim().split(/\s+/).filter(Boolean).map(byte=>parseInt(byte,16)):[...new TextEncoder().encode(String(message.echo??''))].concat(terminator.map(byte=>parseInt(byte,16)));
 const parts=[
  message.mode||'',
  message.port?(message.port+' '+String(message.framing||'')).trim():'',
  message.flow?T('流控 ','flow ')+message.flow:'',
  message.open===false?T('串口没有打开','the port is not open'):'',
  message.portError?T('串口错误：','port error: ')+message.portError:'',
  Number(message.queued||0)>0?T('驱动缓冲区 ','driver buffer ')+message.queued+T(' B（异步写入中）',' B (async write in progress)'):'',
  Number(message.bytes||0)+' B'
 ].filter(Boolean);
 return parts.join(' · ')+'\nhex: '+hexLine(body);
}
// A text send reports the text as typed and the terminator separately, so the terminator is drawn
// here as a glyph — CR sent where the device wanted CRLF is invisible in the box the user typed
// into. A HEX send reports the bytes it wrote, terminator included, and has no readable line to
// echo, so those bytes are the echo. The core sends `eol` only for a text send, which is what tells
// the two apart.
function echoFor(message,terminator){
 const payload=String(message.payload??message.echo??'');
 return message.eol===undefined?payload:payload+glyphs(terminator);
}
// The echo: what the user typed, appended to the tab in order, marked TX so the level filter can
// still hide it. A send that leaves no trace is the thing this whole file exists to prevent.
function recordEcho(session,text,detail){
 const rows=lines.get(session);if(!rows)return;
 rows.push({time:stamp(),level:'TX',text,detail,fields:{module:T('发送','TX')},local:true});
 // A command is a statement that the user wants to see what follows it, so sending returns the view
 // to the newest line even if it had been scrolled back — the same thing Enter does in the log.
 if(session===active&&typeof render==='function'&&!paused){followTail=true;render();logPane.scrollTop=logPane.scrollHeight}
}

// A device that never echoes is normal on many consoles, so silence is not an error — but the
// user cannot tell it apart from a dead link, so say which one it looks like, in the tab's own
// echo line (never in the note line: that one belongs to the send result).
function watchEcho(session){echoSeen=false;clearTimeout(echoTimer);echoTimer=setTimeout(()=>{if(echoSeen)return;sendEchoNotes.set(session,T('已写入，但设备 2 秒内没有任何输出：可能该固件不回显，或未上电、波特率/流控不匹配','Written, but the device sent nothing back for 2 s: it may not echo, may be unpowered, or the baud rate / flow control may not match'));paintEcho()},2000)}

// What happened to the last send is a property of the tab, not of the window: switching away and
// back must not show another session's result, and a refusal must not follow the user around.
onCoreEvent(message=>{
 if(message.type==='session'){readOnlySessions.set(message.id,!!message.readOnly);sessionModes.set(message.id,message.mode||'');sessionKinds.set(message.id,message.kind||'');if(!sessionEols.has(message.id))sessionEols.set(message.id,'auto');paintSendMode()}
 if(message.type==='session.mode'){readOnlySessions.set(message.session,!!message.readOnly);sessionModes.set(message.session,message.mode||'');paintSendMode()}
 if(message.type==='session.eol'){sessionEols.set(message.session,message.eol||'auto');paintSendMode()}
 // Any output at all means the link is alive and the device simply has nothing to say.
 if(message.type==='log'||message.type==='terminal'){if(message.session===lastSend?.target)echoSeen=true;if(sendEchoNotes.delete(message.session))paintEcho()}
 // The core emits session.sent only for a *direct* write: a read-only stream takes the
 // out-of-band path instead, writes its own "$ command" line into the tab, and answers with
 // session.exec. So everything here is a write into the live stream and gets a TX row.
 if(message.type==='session.sent'&&message.raw){
  // X/Y/ZMODEM frames: a file is hundreds of these. Echoing each one would bury the log, so only
  // the status line moves; the transfer panel keeps its own progress.
  if($('#status'))$('#status').textContent=T('已发送 ','Sent ')+Number(message.bytes||0)+' B → '+(sessions.get(message.session)||message.session);
 }else if(message.type==='session.sent'){
  // The terminator arrives as hex ("0d", "0d 0a", …) and is drawn as a glyph; the numeric bytes are
  // kept for the hex line in the report.
  const terminator=String(message.eol||'').split(' ').filter(Boolean);
  const total=Number(message.bytes||0);
  const detail=reportFor(message,terminator);
  clearTimeout(confirmTimer);
  queueNotes.delete(message.session);
  noteSend(T('已发送','Sent'),detail.replace(/\nhex: .*/,''),'ok',message.session);
  recordEcho(message.session,echoFor(message,terminator),detail);
  if($('#status'))$('#status').textContent=T('已发送 ','Sent ')+total+' B → '+(sessions.get(message.session)||message.session)+(detail?' · '+detail.replace(/\nhex: .*/,''):'');
  watchEcho(message.session);
 }
 // The driver still holding the bytes 600 ms after the write is the one failure a silent device
 // cannot report on its own: nothing arrived because nothing left the PC. Say which of the two it
 // is, because "no answer" and "never sent" otherwise look identical.
 if(message.type==='session.queued'){
  const detail=T('驱动队列在写入 0.6 秒后仍有 ','the driver queue still held ')+message.queued+T(' B 未发出',' B 0.6 s after the write')+(message.port?' · '+message.port:'')+(message.error?' · '+message.error:'');
  queueNotes.set(message.session,detail+T('：若设备同时没有任何输出，检查流控（CTS/RTS）、USB 适配器或线缆',': if the device is also silent, check flow control (CTS/RTS), the USB adapter or the cable'));
  paintEcho();
 }
 if(message.type==='session.exec'){
  execStates.set(message.session,message);
  clearTimeout(confirmTimer);
  if(message.state==='running')noteSend(T('带外执行中','Running out-of-band'),message.command||'','ok',message.session);
  if(message.state==='done')noteSend(message.ok?T('命令完成','Command finished'):T('命令退出','Command exited'),`exit ${message.exitCode}`+(message.ok?'':' — '+(T('请看日志中的输出','see the output in the log'))),message.ok?'ok':'bad',message.session);
  paintSendMode();
 }
 if(message.type==='error'&&message.session){clearTimeout(confirmTimer);noteSend(T('没有发送','Not sent'),message.message||'','bad',message.session);restoreOnRefusal(message)}
 if(message.type==='warning'&&message.session)noteSend(T('终端输入警告','Terminal input warning'),message.message||'','bad',message.session);
});

// A refused send must not silently eat the command: put it back — but only into the surface the user
// was actually typing into, and only while that surface is still empty. There are two input surfaces
// now (the input line on the output, and the scheduled-send command field), so a refusal must stay
// on its own tab and on its own surface instead of surfacing somewhere the user is not looking.
function restoreOnRefusal(message){
 const codes=['no-session','write-failed','read-only','empty','hex','queue-full','channel-failed','no-channel'];
 if(!lastSend||!codes.includes(message.code))return;
 if(String(message.session)!==String(lastSend.target))return;
 if(Date.now()-lastSend.at>4000)return;
 const box=document.querySelector(lastSend.surface==='composer'?'#composerInput':'#command');
 if(box&&!box.value){box.value=lastSend.text;box.focus()}
}

// Silence is the one answer a user cannot act on. Every send either produces session.sent, an
// out-of-band session.exec, or an error — if none of them arrives, a layer above the box dropped
// the command, and saying so is the difference between "the device ignores me" and "the box does".
function armConfirm(session){
 clearTimeout(confirmTimer);
 confirmTimer=setTimeout(()=>noteSend(T('没有发送','Not sent'),T('没有收到发送确认，命令可能被拦截（空内容、取消的参数对话框或过滤条件）','No confirmation from the core: the command was dropped — empty value, cancelled parameter dialog, or a filter'),'bad',session),2500);
}

sendBar=document.querySelector('.send');commandBox=document.querySelector('#command');
sendButton=document.createElement('button');eolSelect=document.createElement('select');modeButton=document.createElement('button');badge=document.createElement('span');strip=document.createElement('div');echoLine=document.createElement('div');
sendButton.id='sendNow';sendButton.type='button';sendButton.textContent=T('立即发一次','Send once');sendButton.title=T('把这里的内容立刻发送一次，不影响正在运行的定时发送','Put this field on the wire once, without touching a running timer');
eolSelect.id='sendEol';eolSelect.title=T('发送时追加的行尾；自动＝按会话类型（终端 CR、Telnet CRLF、串口 CR、其它 LF）','Line ending appended on send; Auto follows the transport (pty CR, Telnet CRLF, serial CR, else LF)');
for(const [value,label] of [['auto',T('行尾 自动','EOL auto')],['cr','CR'],['lf','LF'],['crlf','CRLF'],['none',T('行尾 无','EOL none')]])eolSelect.append(new Option(label,value));
modeButton.id='sendMode';modeButton.type='button';
badge.id='sendState';badge.style.cssText='margin-left:auto;font-size:12px;opacity:.85;white-space:nowrap';
strip.id='sendStrip';strip.style.cssText='font-size:12px;min-height:16px;margin-top:4px;padding:2px 6px;border-left:2px solid transparent;white-space:pre-wrap;word-break:break-all;display:none';
echoLine.id='sendEcho';echoLine.style.cssText='font-size:12px;margin-top:2px;color:#f6c453;white-space:pre-wrap;word-break:break-all;display:none';
if(sendBar&&commandBox){
 commandBox.after(sendButton);
 sendButton.after(eolSelect);
 sendBar.append(badge,modeButton);
 sendBar.after(strip);
 strip.after(echoLine);
 commandBox.placeholder=T('定时发送的命令：先填这里，再设间隔和次数；Enter 不会发送，按“立即发一次”或“开始定时”','Payload for scheduled send: fill this in, then set an interval and a repeat count. Enter does not send — use "Send once" or "Start timer"');
}

function noteSend(title,detail,tone,session=active){
 if(!strip)return;
 sendNotes.set(session||'',{text:`[${new Date().toLocaleTimeString()}] ${title}：${detail}`,tone});
 paintStrip();
}
function paintStrip(){
 if(!strip)return;
 const note=sendNotes.get(active)||null;
 if(!note){strip.textContent='';strip.style.display='none';strip.style.color='';strip.style.borderLeftColor='transparent';return}
 strip.style.display='block';
 const color=note.tone==='bad'?'#ff7b72':note.tone==='ok'?'var(--green,#3fb950)':'';
 strip.style.color=color;
 strip.style.borderLeftColor=color||'transparent';
 strip.textContent=note.text;
}
function paintEcho(){
 if(!echoLine)return;
 // Two things can be true at once about a silent device — the driver may also still be holding the
 // bytes — and the second one is the more specific answer, so both are shown rather than one
 // overwriting the other.
 const note=[sendEchoNotes.get(active),queueNotes.get(active)].filter(Boolean).join('\n');
 echoLine.textContent=note;
 echoLine.style.display=note?'block':'none';
}
function paintSendMode(){
 if(!badge||!modeButton)return;
 const id=active,kind=sessionKinds.get(id)||'',readOnly=readOnlySessions.get(id),exec=execStates.get(id);
 if(eolSelect)eolSelect.value=id?sessionEols.get(id)||'auto':'auto';
 paintStrip();paintEcho();
 if(!id){badge.textContent=T('无活动会话','No session');modeButton.style.display='none';return}
 let text;
 if(kind==='ssh')text=readOnly?T('日志流 · 带外执行','Log stream · out-of-band'):T('交互终端 · 直通写入','Interactive shell · direct');
 else if(kind==='adb')text=readOnly?T('logcat · 带外执行','logcat · out-of-band'):T('直通写入','Direct');
 else if(readOnly)text=T('只读流 · 带外执行','Read-only · out-of-band');
 else if(sessionModes.get(id)==='terminal')text=T('交互终端 · 直通写入','Interactive shell · direct');
 else if(sessionModes.get(id)==='offline')text=T('会话已结束','Session ended');
 else text=T('直通写入','Direct');
 if(exec&&exec.state==='running')text+=' · '+T('执行中','running');
 if(exec&&exec.state==='queued')text+=' · '+T('排队 ','queued ')+exec.queued;
 badge.textContent=text;
 modeButton.style.display=kind==='ssh'?'':'none';
 modeButton.disabled=kind!=='ssh';
 modeButton.textContent=readOnly?T('转为交互终端','Make interactive'):T('转为日志流','Back to log stream');
 modeButton.title=readOnly?T('重开会话为 pty shell，之后可以直接敲命令（shell 回显会写进日志文件）','Reopen the session as a pty shell so typed commands run directly (shell echo goes into the log file)'):T('重开会话为只读日志流（ssh 执行远程采集命令，不再接收交互输入）','Reopen as a read-only log stream (ssh runs the remote capture command, no interactive input)');
}

// The line ending belongs to the session, not to the one payload being built: it has to reach
// every path that sends (quick commands, the timer, macros, automated scripts) and `window.core`
// is frozen by contextBridge, so it cannot be wrapped here. The selector instead tells the core
// once, and the core applies it to every send for that session until it is changed back to auto.
if(eolSelect)eolSelect.onchange=()=>{
 const value=eolSelect.value,target=active;
 if(!target){noteSend(T('没有活动会话','No session'),T('行尾设置需要一个会话；先新建或选择一个会话','a line ending needs a session; create or select one first'),'bad');eolSelect.value='auto';return}
 if(!sessions.has(target)||String(target).startsWith('file:')){noteSend(T('无法设置行尾','Cannot set the line ending'),T('当前标签不是可写的会话','the active tab is not a writable session'),'bad');eolSelect.value=sessionEols.get(target)||'auto';return}
 lastSend=null;
 sessionEols.set(target,value);
 window.core.send({type:'session.eol',session:target,eol:value});
 noteSend(T('已设置行尾','Line ending set'),value===('auto')?T('自动（按会话类型）','auto (follows the transport)'):value,'ok');
};

// The last override in the load order, so the parameter dialog and the history chain still
// run underneath while the refusals happen where the user can see them.
const boxSendBefore=sendCommand;
async function sendFromBox(value,target=active,surface='box'){
 if(!target){noteSend(T('没有活动会话','No session'),T('先新建或选择一个会话','Create or select a session first'),'bad');return false}
 if(String(target).startsWith('file:')){noteSend(T('无法发送','Cannot send'),T('当前是导入的日志文件标签，不是可写的会话','the active tab is an imported log file, not a writable session'),'bad');return false}
 if(!sessions.has(target)){noteSend(T('无法发送','Cannot send'),T('会话已关闭','the session is closed'),'bad');return false}
 const state=connectionStates.get(target);
 if(!readOnlySessions.get(target)&&state&&state!=='connected'&&state!=='connecting'){
  noteSend(T('无法发送','Cannot send'),T('会话状态：','session state: ')+state+T('；断开后请先重新连接',' — reconnect after a drop'),'bad');
  return false;
 }
 lastSend={target,text:String(value),at:Date.now(),surface};
 if(sendEchoNotes.delete(target))paintEcho();
 queueNotes.delete(target);
 // An empty line has nothing to expand and nothing to recall, and the parameter/history chain above
 // the box drops it outright (`if(!target||!data)return`), so it goes to the core directly: the
 // payload is empty and the session's line ending is what actually gets written.
 if(String(value)===''){
  if((sessionEols.get(target)||'auto')==='none'){noteSend(T('没有内容','Nothing to send'),T('行尾是“无”，输入也是空的：没有可发送的字节','the line ending is "none" and the input is empty: there are no bytes to send'),'bad',target);return false}
  window.core.send({type:'session.send',session:target,data:''});
  armConfirm(target);
  return true;
 }
 try{
  await boxSendBefore(value,target);
  // Whatever a layer above did with the command — an empty payload, a cancelled parameter
  // dialog, a broadcast that matched nothing — the user typed something and is owed an
  // answer. If the core confirms the write, this timer is cancelled; otherwise it speaks.
  armConfirm(target);
  return true;
 }catch(error){noteSend(T('无法发送','Cannot send'),error.message,'bad');return false}
}
sendCommand=async(data=commandBox?commandBox.value:'',target=active)=>sendFromBox(data,target);
// The input line on the output sends through this same chain — parameter templates, history, HEX,
// then the guards and the refusal handling above — so a command typed on the log behaves exactly
// like one typed in the field below it. Only the surface differs, and that is what a refusal is
// restored into, so the two never restore each other's text.
async function sendFromSurface(value,target,surface){return sendFromBox(value,target,surface)}

if(commandBox){
 // The field below the log is the scheduled-send payload, not a send button: Enter no longer puts
 // anything on the wire from here. Sending a line is the input line on the output's job (it sits
 // where a terminal's input line sits), and #sendNow is the deliberate one-shot next to this field.
 // Typing a command into the field and pressing Enter used to send it, which made the timer's
 // payload field and the send surface the same control — they are not the same thing.
 commandBox.addEventListener('focus',paintSendMode);
}
if(sendButton)sendButton.onclick=async()=>{
 if(!commandBox)return;
 const value=commandBox.value;
 if(await sendFromBox(value))commandBox.value='';
 commandBox.focus();
};
if(modeButton)modeButton.onclick=()=>{
 if(!active||sessionKinds.get(active)!=='ssh')return;
 const interactive=!!readOnlySessions.get(active);
 noteSend(T('切换中','Switching'),interactive?T('正在重开为交互终端…','reopening as a pty shell…'):T('正在重开为日志流…','reopening as a log stream…'),'ok');
 window.core.send({type:'session.mode',session:active,interactive});
};

const activateBeforeSendBox=activate;
activate=id=>{
 activateBeforeSendBox(id);
 paintSendMode();
 // Focus is not taken here any more: the keyboard belongs to whichever input surface the current
 // view shows (the input line on the output, or the xterm terminal), and that decision lives with
 // the view, not with this box. Taking it here would drag the user's keyboard into the timer field.
};
paintSendMode();
