'use strict';
// Hold a button's lock for the actual async operation, not a fixed debounce alone.
const actionLocks=new WeakMap(),guardedHandlers=new WeakSet();
function guardAction(element,handler){
 if(guardedHandlers.has(handler))return handler;
 const wrapped=function(event){
  if(actionLocks.has(element)){event?.preventDefault();return false;}
  const wasDisabled=element.disabled,started=performance.now();
  actionLocks.set(element,true);element.disabled=true;element.setAttribute('aria-busy','true');
  let result;
  const release=()=>setTimeout(()=>{actionLocks.delete(element);element.disabled=wasDisabled;element.removeAttribute('aria-busy')},Math.max(0,350-(performance.now()-started)));
  try{result=handler.call(this,event)}catch(error){release();$('#status').textContent=error.message;return false;}
  if(result&&typeof result.then==='function')Promise.resolve(result).catch(error=>{$('#status').textContent=error.message}).finally(release);
  else release();
  // Preserve native form handling for synchronous handlers.
  return result===false?false:undefined;
 };
 guardedHandlers.add(wrapped);return wrapped;
}
// 导航/切换类按钮（查找栏 ▲▼ 与 Aa/W/.* 开关、终端查找、命中列表上下条、翻页）是
// 幂等且同步的：连点五次就该走五步，开关连点两次就该回到原状。固定 350ms 的防连点
// 会把第 2 次起全丢掉——绕回、大小写切换这些测试就是这样红的。用 data-no-lock 显式
// 豁免，默认仍保护发命令、连接、保存这类有副作用的按钮。
const ACTION_UNLOCKED=new Set(['fdPrev','fdNext','fdCase','fdWord','fdRe','termSearchPrev','termSearchNext','termSearchCase','wtPrevMatch','wtNextMatch']);
function actionLockable(element){return !element.hasAttribute('data-no-lock')&&!ACTION_UNLOCKED.has(element.id)}
for(const kind of ['click','dblclick'])document.addEventListener(kind,event=>{
 const element=event.target.closest(kind==='click'?'button':'.saved-item');if(!element)return;
 if(!actionLockable(element))return;
 if(actionLocks.has(element)){event.preventDefault();event.stopImmediatePropagation();return;}
 const key='on'+kind;if(typeof element[key]==='function')element[key]=guardAction(element,element[key]);
},true);
