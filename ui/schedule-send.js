'use strict';
// This strip is the scheduled-send panel and nothing else. It used to double as a send surface: the
// field was `#command`, Enter put it on the wire, and a "timer" toggled an interval over the same
// control — so "the payload a timer repeats" and "send this line now" were the same thing, and the
// only way to find out which one you had configured was to watch the wire. They are separate now:
// one line goes out from the input line on the output (log-composer.js), a repeating line goes out
// from here, and this panel states what it will send, how often, how many times, and when the next
// one leaves. Per `renderer.js` the timer globals stay the shared ones, so a disconnect that code
// already cleans up still lands here.
const timerPanel=$('#timerPanel'),timerToggle=$('#timerToggle'),timerState=$('#timerState'),intervalInput=$('#interval');
// 「间隔（秒）」在 index.html 里是 label 的裸文本节点。interface.js 的通用改写只走 .toolbox 和 dialog
// 内部，够不到这个面板，所以切到英文后它会一直停在中文。这里把它换成自己的 span 并由本文件重绘，
// 和 #timerToggle 同一个道理：定时面板只能有一个写入者，两个人都写就会出现陈旧标签。
const timerIntervalText=document.createElement('span');
let timerActive=false,timerSession='',timerPayload='',timerLimit=0,timerSent=0,timerNextAt=0,timerIntervalMs=0,timerCountdownHandle=null;

const repeatLabel=document.createElement('label'),repeatText=document.createElement('span'),repeatInput=document.createElement('input');
repeatLabel.style.cssText='margin:0;display:flex;align-items:center;gap:6px';
repeatInput.id='timerRepeat';repeatInput.type='number';repeatInput.min='0';repeatInput.value='0';repeatInput.style.cssText='width:70px';
const timerCountdown=document.createElement('span'),timerCount=document.createElement('span'),hintSpan=document.createElement('span');
timerCountdown.id='timerCountdown';timerCountdown.style.cssText='color:var(--green,#55d98b);white-space:nowrap';
timerCount.id='timerCount';timerCount.style.cssText='white-space:nowrap';
hintSpan.id='timerHint';hintSpan.style.cssText='flex-basis:100%;font-size:12px;line-height:1.5;opacity:.8';
repeatLabel.append(repeatText,repeatInput);
if(timerPanel){
 // The panel is permanent furniture at the bottom of the log, not a dialog behind a button: a timer
 // you cannot see is a timer you forget is running. `#schedule` only collapses it.
 timerPanel.classList.remove('hidden');
 timerPanel.style.cssText='flex-wrap:wrap;height:auto;min-height:36px;row-gap:4px';
 // Next to the interval field, not inside its label: a label inside a label is invalid, and the
 // inner field would be read out as part of the outer one.
 intervalInput.closest('label').after(repeatLabel);
 timerToggle.after(timerState,timerCountdown,timerCount);
 timerPanel.append(hintSpan);
}
const timerRepeatLabel=()=>repeatText;
// 只在确实存在 interval 输入框时才接管标签：面板被裁剪掉的环境（例如只加载部分脚本的测试）不该在这里炸。
if(intervalInput){
 const intervalLabel=intervalInput.closest('label');
 // 文本节点排在 input 前面，所以取第一个非空文本节点即可；改完清空它的内容，避免和 span 重复显示。
 const bare=[...intervalLabel.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim());
 if(bare)bare.textContent='';
 intervalLabel.prepend(timerIntervalText);
}
// 首屏要写一次，而且必须在上面插好 span 之后：interface.js 的 translateControls() 在加载末尾已经跑过了，
// 而「英语」可能是本次加载之前就存在 localStorage 里的——那时根本没有一次语言切换来触发重绘。
timerRepeatLabel().textContent=T('重复次数（0＝不限）','Repeat (0 = unlimited)');
timerIntervalText.textContent=T('间隔（秒）','Interval (s)');

function payloadSummary(){
 if(timerPayload)return timerPayload.length>60?timerPayload.slice(0,60)+'…':timerPayload;
 return (sessionEols.get(timerSession)||'auto')==='none'?T('（没有可发送的字节）','(nothing to send)'):T('（空行：只发行尾）','(empty line: sends the line ending alone)');
}
function stopTimer(note){
 if(timer){clearInterval(timer);timer=null}
 if(timerCountdownHandle){clearInterval(timerCountdownHandle);timerCountdownHandle=null}
 timerActive=false;timerTarget='';timerNextAt=0;
 paintTimer(note||T('定时发送已停止','the timer stopped'));
}
// What the panel says has to be the truth about the timer and not a decoration: how often, how many
// times, which tab, which bytes, and — once it is running — when the next one goes out. A scheduler
// that only says "running" leaves the user counting seconds in their head.
function paintTimer(note){
 const running=timerActive;
 timerToggle.textContent=running?T('停止定时','Stop timer'):T('开始定时','Start timer');
 timerToggle.setAttribute('aria-pressed',String(running));
 timerToggle.title=running?T('停止定时发送；已经发出的命令不会撤回','Stop the timer; commands already sent are not recalled'):T('按这里的间隔和次数重复发送上面的命令','Repeat the command above at the interval and repeat count set here');
 const name=timerSession?(sessions.get(timerSession)||timerSession):'';
 timerCount.textContent=timerSent?T('已发 '+timerSent+' 次','sent '+timerSent):'';
 if(!running)timerCountdown.textContent='';
 if(running){
  const limit=timerLimit>0?T('共 '+timerLimit+' 次','up to '+timerLimit):T('不限次数','unlimited');
  timerState.textContent=T('每 ','every ')+Math.round(timerIntervalMs/1000)+T(' 秒 · ',' s · ')+limit+(name?' · '+T('目标 ','to ')+name:'');
  timerState.title=payloadSummary();
  paintCountdown();
 }else{
  timerState.textContent=note||'';
  timerState.title='';
 }
 hintSpan.textContent=running?T('正在重复发送：','Repeating: ')+payloadSummary()+T('（行尾用“行尾”选择器设置）',' (line ending comes from the EOL selector)')
  :T('填好命令、间隔和重复次数后点“开始定时”。定时发送的每一条都会在日志里留下回显行，效果和手敲一条一样。','Fill in the command, the interval and the repeat count, then start. Every scheduled send leaves an echo row in the log, exactly like one typed by hand.');
}
function paintCountdown(){
 const left=Math.max(0,Math.ceil((timerNextAt-Date.now())/1000));
 const text=T('下一次 '+left+' 秒后','next in '+left+' s');
 if(timerCountdown.textContent!==text)timerCountdown.textContent=text;
}
function startTimer(){
 if(timerActive)return;
 const target=active,payload=commandBox?commandBox.value:'',eol=sessionEols.get(target)||'auto';
 if(!target||!sessions.has(target)||String(target).startsWith('file:')){paintTimer(T('没有可发送的会话：先新建或选择一个会话','No sendable session: create or select one first'));return}
 if(!payload&&eol==='none'){paintTimer(T('命令为空且行尾是“无”：没有可发送的字节','The command is empty and the line ending is "none": there are no bytes to send'));return}
 const seconds=Math.max(1,+intervalInput.value||5),repeat=Math.max(0,+repeatInput.value||0);
 timerActive=true;timerSession=target;timerTarget=target;timerPayload=payload;timerLimit=repeat;timerSent=0;timerIntervalMs=seconds*1000;timerNextAt=Date.now()+timerIntervalMs;
 // The first line goes through the full send chain so a parameter template still gets its dialog and
 // a refusal still says why; the ticks after it write straight to the core, because a template cannot
 // be re-prompted every interval and a prompt per tick is not a scheduler.
 sendCommand(payload,target);
 timer=setInterval(fireTimer,seconds*1000);
 timerCountdownHandle=setInterval(tickTimer,250);
 paintTimer();
}
function fireTimer(){
 if(!timerActive)return;
 if(!sessions.has(timerSession)){stopTimer(T('目标标签已关闭，定时发送已停止','the target tab closed; the timer stopped'));return}
 window.core.send({type:'session.send',session:timerSession,data:timerPayload});
 timerNextAt=Date.now()+timerIntervalMs;
 paintCountdown();
}
// A safety net rather than the primary stop: the disconnect path in `renderer.js` clears the shared
// `timer` handle, and a `closeTab` removes the session without any session.state at all. Both leave
// `timerActive` true, and a scheduler that believes it is running while nothing runs is worse than
// one that has stopped.
function tickTimer(){
 if(!timerActive)return;
 if(!timer||!sessions.has(timerSession)){stopTimer(T('会话已结束，定时发送已停止','the session ended; the timer stopped'));return}
 if(!document.hidden)paintCountdown();
}
if(timerToggle)timerToggle.onclick=()=>timerActive?stopTimer():startTimer();
if(repeatInput)repeatInput.onchange=()=>{repeatInput.value=String(Math.max(0,+repeatInput.value||0))};
if(intervalInput)intervalInput.onchange=()=>{intervalInput.value=String(Math.max(1,+intervalInput.value||5))};
const scheduleButton=$('#schedule');
if(scheduleButton)scheduleButton.onclick=()=>{const open=timerPanel.style.display!=='none';timerPanel.style.display=open?'none':'';scheduleButton.setAttribute('aria-expanded',String(!open));$('#status').textContent=open?T('定时发送面板已收起','Scheduled send collapsed'):T('定时发送面板已展开','Scheduled send expanded')};
if(scheduleButton)scheduleButton.setAttribute('aria-expanded','true');

onCoreEvent(m=>{
 // Counted on confirmation, not on intent: "已发 3 次" has to mean three lines the core actually
 // wrote, or a timer whose sends are all being refused would report a healthy run.
 if(m.type==='session.sent'&&timerActive&&m.session===timerSession){
  timerSent++;
  if(timerLimit>0&&timerSent>=timerLimit)stopTimer(T('已发满 '+timerLimit+' 次，定时发送已停止','reached '+timerLimit+' sends; the timer stopped'));
  else paintTimer();
 }
 // A refusal that repeats is not a timer that is working, it is a loop that will keep failing until
 // someone notices. Stop and say which refusal it was.
 if(m.type==='error'&&timerActive&&m.session===timerSession)stopTimer(T('发送被拒绝，定时已停止：','a send was refused, so the timer stopped: ')+(m.message||''));
 if(m.type==='session.state'&&timerActive&&m.id===timerSession&&['closed','error','reconnecting'].includes(m.state))stopTimer(T('连接已结束，定时发送已停止','the connection ended; the timer stopped'));
});
const localizeBeforeTimer=localize;
localize=()=>{
 // interface.js 的 translateControls() 每次切语言都会重跑一遍通用文本改写，而它不认这两个标签：
 // 「重复次数」是这里自己新建的 label，「间隔（秒）」在 .timer 面板里、不在它的作用域内。所以这段
 // 文案只由本文件负责，而且必须写在 localizeBeforeTimer() 之后，否则会被上一轮的文本覆盖回去。
 localizeBeforeTimer();
 timerRepeatLabel().textContent=T('重复次数（0＝不限）','Repeat (0 = unlimited)');
 timerIntervalText.textContent=T('间隔（秒）','Interval (s)');
 paintTimer();
};

// The collapsed state and the panel's own furniture are the last things to settle: the localisation
// pass and the layout above this file both run before it, and a panel built before them would be
// re-styled out from under it.
timerPanel&&(timerPanel.style.display='');
paintTimer();
