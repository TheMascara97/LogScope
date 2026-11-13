'use strict';
const palettes={dark:{background:'#0c131c',foreground:'#dde8f2',cursor:'#5be0bf',selectionBackground:'#37536a'},light:{background:'#f8fafc',foreground:'#182f43',cursor:'#006c56',selectionBackground:'#c3dcee'},contrast:{background:'#000000',foreground:'#ffffff',cursor:'#ffff00',selectionBackground:'#414141'}};
// 终端主题 = 全局主题调色板 + 用户在"终端选项"里显式覆盖的颜色（terminal-options.js）。
// 只在用户真的存过某个键时才覆盖：TT.options().theme 会把 TT_THEME_DEFAULTS 的五个键全部填满，
// 直接合并等于每次都把深色默认值盖在浅色/高对比调色板上——此前浅色主题下 xterm 区一直是
// #101418，日志区却是 #f8fafc。判断依据是 localStorage 里实际存下的键，不是合并后的对象。
function terminalTheme(theme){
 const base={...palettes[theme]};
 if(typeof TT==='undefined')return base;
 let stored;try{stored=(JSON.parse(localStorage[TT.key||'termOptions']||'{}')||{}).theme}catch{return base}
 if(!stored||typeof stored!=='object')return base;
 for(const [key,value] of Object.entries(stored)){if(typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value))base[key]=value}
 return base
}
function fontOptions(){const opts=typeof TT!=='undefined'?TT.options():{};const size=Math.max(10,Math.min(28,Number(localStorage.logFontSize)||opts.fontSize||13));return {...opts,fontSize:size}}
function applyAppearance(theme=localStorage.appearanceTheme||(localStorage.lightTheme==='true'?'light':'dark')){if(!palettes[theme])theme='dark';localStorage.appearanceTheme=theme;localStorage.lightTheme=String(theme==='light');document.body.classList.toggle('light-theme',theme==='light');document.body.classList.toggle('contrast-theme',theme==='contrast');document.body.dataset.theme=theme;for(const item of terminals.values())item.term.options.theme=terminalTheme(theme);termHost.style.background=terminalTheme(theme).background}
const terminalBeforeAppearance=terminalSession;terminalSession=id=>{const item=terminalBeforeAppearance(id);const opts=fontOptions();item.term.options.theme=terminalTheme(document.body.dataset.theme||'dark');item.term.options.fontSize=opts.fontSize;for(const key of ['lineHeight','letterSpacing','fontWeight','fontWeightBold','fontFamily','minimumContrastRatio'])if(opts[key]!==undefined)item.term.options[key]=opts[key];return item};
const appearanceButton=[...bar.children].find(b=>b.textContent.includes('Theme'));if(appearanceButton)appearanceButton.onclick=()=>openAppearance();
function openAppearance(){return new Promise(resolve=>{const d=document.createElement('dialog');d.id='appearanceDialog';d.className='manager-dialog';const title=document.createElement('h3'),label=document.createElement('label'),select=document.createElement('select'),sizeLabel=document.createElement('label'),size=document.createElement('input'),close=document.createElement('button');title.textContent=uiText('显示设置','Appearance settings');label.textContent=uiText('全局主题','Global theme');for(const [value,zh,en] of [['dark','深色','Dark'],['light','浅色','Light'],['contrast','高对比','High contrast']])select.append(new Option(uiText(zh,en),value));select.value=document.body.dataset.theme;select.onchange=()=>applyAppearance(select.value);sizeLabel.textContent=uiText('日志字体大小','Log font size');size.type='number';size.min='10';size.max='28';size.value=localStorage.logFontSize||13;size.onchange=()=>{const value=Number(size.value);if(!Number.isInteger(value)||value<10||value>28){size.reportValidity();return}localStorage.logFontSize=String(value);$('#terminal').style.fontSize=value+'px';for(const item of terminals.values())item.term.options.fontSize=value;showTerminal()};label.append(select);sizeLabel.append(size);close.textContent=uiText('关闭','Close');close.onclick=()=>d.close();d.onclose=()=>{d.remove();resolve()};d.append(title,label,sizeLabel,close);document.body.append(d);d.showModal()})}
applyAppearance();if(localStorage.logFontSize)$('#terminal').style.fontSize=Math.max(10,Math.min(28,Number(localStorage.logFontSize)||13))+'px';
