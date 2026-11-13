'use strict';
// 终端（VT）逐字段选项：xterm.js 就是这里的 VT 模拟器，用户可调的能力来自 xterm 的
// ITerminalOptions / ITheme。本模块把它们从"写死的三四个值"变成一份设置表单：
//   · 结构（滚回行数、光标、行高、字重、字距、最小对比度、标签页宽、平滑滚动、滚动灵敏度…）
//   · 行为（允许点链接、右键选中、macOptionIsMeta、忽略 bracketed paste、只读 stdin）
//   · 配色（前景/背景/光标/选区/ANSI 16 色）
// 保存到 localStorage.termOptions，新终端按它构造；"应用到已打开终端"走 apply 回调，
// 不需要重开会话（xterm 的 options 是运行时可变属性）。
// 前缀 term 全局唯一；加载位置：terminal-view.js 之后（构造端读 TT.defaults()）。
const TT_KEY='termOptions';
// 可调字段表：key → {type, 默认值, 范围/选项, 本地化标签}。只列 xterm 真正支持的字段，
// 不做"看起来有、其实被忽略"的假选项。
const TT_FIELDS={
 scrollback:{type:'number',def:10000,min:0,max:200000,label:['回滚缓冲（行）','Scrollback (lines)']},
 scrollSensitivity:{type:'number',def:1,min:1,max:20,label:['滚轮灵敏度','Scroll sensitivity']},
 fastScrollSensitivity:{type:'number',def:5,min:1,max:20,label:['快速滚动倍数','Fast scroll multiplier']},
 smoothScrollDuration:{type:'number',def:0,min:0,max:1000,label:['平滑滚动（ms，0＝关）','Smooth scroll (ms, 0 = off)']},
 cursorBlink:{type:'bool',def:true,label:['光标闪烁','Cursor blink']},
 cursorStyle:{type:'select',def:'block',options:['block','underline','bar'],label:['光标形状','Cursor style']},
 cursorInactiveStyle:{type:'select',def:'outline',options:['outline','block','bar','underline','none'],label:['失焦光标','Inactive cursor']},
 cursorWidth:{type:'number',def:1,min:1,max:32,label:['竖线光标宽度（px）','Bar cursor width (px)']},
 fontSize:{type:'number',def:13,min:8,max:40,label:['字号','Font size']},
 fontFamily:{type:'text',def:"'Cascadia Mono', Consolas, 'Microsoft YaHei UI', monospace",label:['字体','Font family']},
 fontWeight:{type:'select',def:'normal',options:['normal','bold'],label:['字重','Font weight']},
 fontWeightBold:{type:'select',def:'bold',options:['normal','bold'],label:['粗体字重','Bold weight']},
 lineHeight:{type:'number',def:1,min:1,max:3,step:0.05,label:['行高倍数','Line height']},
 letterSpacing:{type:'number',def:0,min:-5,max:20,label:['字间距（px）','Letter spacing (px)']},
 minimumContrastRatio:{type:'number',def:1,min:1,max:21,label:['最小对比度（1＝关）','Minimum contrast (1 = off)']},
 tabStopWidth:{type:'number',def:8,min:1,max:32,label:['制表位宽度','Tab stop width']},
 altClickMovesCursor:{type:'bool',def:true,label:['Alt+点击移动光标','Alt+click moves cursor']},
 rightClickSelectsWord:{type:'bool',def:false,label:['右键选中单词','Right click selects word']},
 macOptionIsMeta:{type:'bool',def:false,label:['mac Option 作 Meta','mac Option as Meta']},
 ignoreBracketedPasteMode:{type:'bool',def:false,label:['忽略 bracketed paste 模式','Ignore bracketed paste mode']},
 disableStdin:{type:'bool',def:false,label:['禁止输入（只读终端）','Disable stdin (read-only)']},
 allowTransparency:{type:'bool',def:false,label:['允许透明背景','Allow transparent background']},
 drawBoldTextInBrightColors:{type:'bool',def:true,label:['粗体使用亮色','Draw bold text in bright colors']},
 customGlyphs:{type:'bool',def:true,label:['使用自定义字形','Use custom glyphs']},
 convertEol:{type:'bool',def:false,label:['LF 视为 CRLF','Treat LF as CRLF']},
 screenReaderMode:{type:'bool',def:false,label:['读屏模式','Screen reader mode']},
 rescaleOverlappingGlyphs:{type:'bool',def:true,label:['缩放重叠字形','Rescale overlapping glyphs']},
};
// 配色：xterm ITheme 的字段（留空＝用默认深色主题的原值）。
const TT_THEME_DEFAULTS={background:'#101418',foreground:'#d7e1e8',cursor:'#d7e1e8',cursorAccent:'#101418',selectionBackground:'#264f78'};
const TT_THEME_FIELDS=[['background',['背景','Background']],['foreground',['前景','Foreground']],['cursor',['光标','Cursor']],['cursorAccent',['光标底色','Cursor accent']],['selectionBackground',['选区背景','Selection background']]];
function ttText(zh,en){return localStorage.lang==='en'?en:zh}
function ttDefaults(){
 const base={allowProposedApi:true,fontFamily:"'Cascadia Mono', Consolas, 'Microsoft YaHei UI', monospace",fontSize:13,linkHandler:true};
 const out={};
 for(const [key,f] of Object.entries(TT_FIELDS))out[key]=f.def;
 out.theme={...TT_THEME_DEFAULTS};
 return {out,base};
}
function ttStored(){try{const v=JSON.parse(localStorage[TT_KEY]||'{}');return v&&typeof v==='object'?v:{}}catch{return {}}}
function ttOptions(){
 const stored=ttStored(),out={};
 for(const [key,f] of Object.entries(TT_FIELDS)){
  let v=stored[key];
  if(v===undefined||v===null)v=f.def;
  if(f.type==='number'){v=Number(v);if(!Number.isFinite(v))v=f.def;if(v<f.min)v=f.min;if(v>f.max)v=f.max}
  else if(f.type==='bool')v=v===true||v==='true';
  else if(f.type==='select'&&!f.options.includes(v))v=f.def;
  out[key]=v;
 }
 const theme={...TT_THEME_DEFAULTS};
 const storedTheme=stored.theme&&typeof stored.theme==='object'?stored.theme:{};
 for(const [key] of TT_THEME_FIELDS){const v=storedTheme[key];if(typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v))theme[key]=v}
 out.theme=theme;
 return out;
}
function ttValidate(patch){
 const next=ttOptions();
 for(const [key,value] of Object.entries(patch||{})){
  if(key==='theme'){for(const [tk,tv] of Object.entries(value||{})){if(!TT_THEME_DEFAULTS[tk])throw Error('Unknown theme field: '+tk);if(typeof tv==='string'&&tv&&!/^#[0-9a-f]{6}$/i.test(tv))throw Error('Invalid colour for '+tk+' (expected #rrggbb)');next.theme[tk]=tv||TT_THEME_DEFAULTS[tk]}continue}
  const f=TT_FIELDS[key];if(!f)throw Error('Unknown terminal option: '+key);
  if(f.type==='number'){const n=Number(value);if(!Number.isFinite(n)||n<f.min||n>f.max)throw Error(f.label[0]+' 超出范围 '+f.min+'–'+f.max);next[key]=n}
  else if(f.type==='bool')next[key]=value===true||value==='true';
  else if(f.type==='select'){if(!f.options.includes(value))throw Error(f.label[0]+' 取值无效');next[key]=value}
  else next[key]=String(value).slice(0,200);
 }
 return next;
}
function ttSave(next){localStorage[TT_KEY]=JSON.stringify(next);return next}
// 已打开的终端：直接改 options；滚回行数这类需要重建缓冲的字段，xterm 会在下次清屏后生效，
// 这里如实提示而不是假装重建（重建会丢掉设备当前的屏幕内容）。
function ttApply(next){
 let applied=0,rebuildNeeded=false;
 for(const [id,item] of terminals){
  if(!item||!item.term)continue;
  for(const [key,f] of Object.entries(TT_FIELDS)){
   const value=next[key];
   if(item.term.options[key]===value)continue;
   try{item.term.options[key]=value;applied++}catch(e){$('#status').textContent=(localStorage.lang==='en'?'Could not apply ':'无法应用 ')+key+': '+e.message}
   if(key==='scrollback')rebuildNeeded=true;
  }
  // 主题要和主题调色板一起重算，不能把 next.theme（含全部默认深色键）直接合并到当前主题上：
  // 那样浅色/高对比界面下一次"应用"就会把 xterm 区域改回深色。terminalTheme 只合并用户显式
  // 存过的键（appearance.js）。
  if(typeof terminalTheme==='function')item.term.options.theme=terminalTheme(document.body.dataset.theme||'dark');
  else item.term.options.theme={...(item.term.options.theme||{}),...next.theme};
  try{item.fit&&item.fit.fit()}catch(e){}
 }
 return {applied,terminals:terminals.size,rebuildNeeded};
}
const TT={defaults:ttDefaults,options:ttOptions,validate:ttValidate,save:ttSave,apply:ttApply,fields:TT_FIELDS,themeFields:TT_THEME_FIELDS,key:TT_KEY};
if(typeof module!=='undefined'&&module.exports)module.exports=TT;
