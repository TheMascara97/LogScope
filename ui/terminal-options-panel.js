'use strict';
// 终端选项面板：把 terminal-options.js 的字段表渲染成表单（下拉/数字/勾选/文本/颜色）。
// 保存时 ttValidate 逐字段校验（范围、枚举、#rrggbb），再 ttSave + ttApply，
// 已打开终端即时生效（滚回行数除外，见 terminal-options.js 的说明）。
// 前缀 tto 全局唯一；加载位置：terminal-options.js 之后、settings.js 之前。
const ttoButton=document.createElement('button');
ttoButton.id='terminalOptions';
ttoButton.dataset.category='session';
ttoButton.textContent='终端选项';
bar.append(ttoButton);
function ttoLabel(f){const [zh,en]=f.label;return (localStorage.lang==='en'?en:zh)}
function openTerminalOptions(){
 if($('#terminalOptionsDialog'))return;
 return new Promise(resolve=>{
  const d=document.createElement('dialog');d.id='terminalOptionsDialog';d.className='manager-dialog';
  const title=document.createElement('h3'),form=document.createElement('form'),grid=document.createElement('div'),error=document.createElement('p'),note=document.createElement('p');
  title.textContent=localStorage.lang==='en'?'Terminal options (VT)':'终端选项（VT）';
  grid.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;max-height:60vh;overflow:auto';
  const inputs={},themeInputs={};
  const current=TT.options();
  for(const [key,f] of Object.entries(TT.fields)){
   const wrap=document.createElement('label');wrap.textContent=ttoLabel(f);
   let el;
   if(f.type==='select'){el=document.createElement('select');for(const v of f.options)el.append(new Option(v,v));el.value=current[key]}
   else if(f.type==='bool'){el=document.createElement('input');el.type='checkbox';el.checked=current[key]}
   else if(f.type==='number'){el=document.createElement('input');el.type='number';el.min=String(f.min);el.max=String(f.max);if(f.step)el.step=String(f.step);el.value=String(current[key])}
   else{el=document.createElement('input');el.type='text';el.value=String(current[key])}
   el.dataset.opt=key;wrap.append(el);grid.append(wrap);inputs[key]=el;
  }
  const themeTitle=document.createElement('h4');themeTitle.textContent=localStorage.lang==='en'?'Terminal colours (override the global theme)':'终端配色（覆盖全局主题）';
  const themeGrid=document.createElement('div');themeGrid.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:6px 14px';
  // 每个颜色框旁边一个"跟随主题"勾选：没勾的键不写进 localStorage。terminal-options.js 的
  // ttOptions() 会把缺省的键填成深色默认值，只要存过一次就再也不会跟随浅色/高对比主题——
  // 这正是浅色界面里终端区仍是深色 #101418 的来源。默认全部不勾。
  let storedTheme={};try{storedTheme=(JSON.parse(localStorage[TT.key||'termOptions']||'{}')||{}).theme||{}}catch{}
  const themeFollow={};
  for(const [key,label] of TT.themeFields){
   const wrap=document.createElement('label'),row=document.createElement('span');wrap.textContent=localStorage.lang==='en'?label[1]:label[0];
   row.style.cssText='display:flex;align-items:center;gap:6px';
   const el=document.createElement('input');el.type='color';el.value=current.theme[key]||'#000000';el.dataset.theme=key;
   const follow=document.createElement('input');follow.type='checkbox';follow.dataset.follow=key;
   follow.checked=!Object.prototype.hasOwnProperty.call(storedTheme,key);
   follow.title=localStorage.lang==='en'?'Follow the global theme':'跟随全局主题';
   if(follow.checked)el.disabled=true;
   follow.onchange=()=>{el.disabled=follow.checked};
   const tag=document.createElement('small');tag.textContent=localStorage.lang==='en'?'follow':'跟随';tag.style.cssText='opacity:.8;font-size:12px';
   row.append(el,follow,tag);wrap.append(row);themeGrid.append(wrap);themeInputs[key]=el;themeFollow[key]=follow;
  }
  const reset=document.createElement('button'),save=document.createElement('button'),cancel=document.createElement('button');
  reset.type='button';reset.textContent=localStorage.lang==='en'?'Reset to defaults':'恢复默认';
  save.type='submit';save.textContent=localStorage.lang==='en'?'Save and apply':'保存并应用';
  cancel.type='button';cancel.textContent=localStorage.lang==='en'?'Cancel':'取消';
  cancel.onclick=()=>d.close();
  reset.onclick=()=>{const defs=TT.options();for(const [key,f] of Object.entries(TT.fields)){const el=inputs[key];if(f.type==='bool')el.checked=f.def;else el.value=String(f.def)}for(const [key] of TT.themeFields){themeInputs[key].value=current.theme[key]||'#000000';themeFollow[key].checked=true;themeInputs[key].disabled=true}error.textContent=''};
  form.onsubmit=e=>{
   e.preventDefault();
   try{
    const patch={},theme={};
    for(const [key,f] of Object.entries(TT.fields)){const el=inputs[key];patch[key]=f.type==='bool'?el.checked:el.value}
    for(const [key] of TT.themeFields)if(!themeFollow[key].checked)theme[key]=themeInputs[key].value;
    patch.theme=theme;
    const next=TT.validate(patch);
    // ttOptions() 会把没存的颜色键补成默认值；保存时把"跟随主题"的键删掉，localStorage 里才
    // 只剩用户真正定过的颜色，下一次切换主题这些键才会跟着变。
    for(const [key] of TT.themeFields)if(themeFollow[key].checked)delete next.theme[key];
    TT.save(next);
    const applied=TT.apply(next);
    // 全局字号偏好与终端字号保持一致，避免"显示设置"里改过之后两者打架。
    localStorage.logFontSize=String(next.fontSize);
    note.textContent=(localStorage.lang==='en'?'Applied to ':'已应用到 ')+applied.terminals+(localStorage.lang==='en'?' open terminal(s).':' 个已打开终端。')
     +(applied.rebuildNeeded?(localStorage.lang==='en'?' Scrollback size takes effect after the next clear.':' 回滚行数将在下次清屏后生效。'):'');
    d.close();
   }catch(err){error.textContent=err.message}
  };
  form.append(grid,themeTitle,themeGrid,reset,error,note,save,cancel);
  d.append(title,form);
  d.onclose=()=>{d.remove();resolve()};
  document.body.append(d);d.showModal();
 });
}
ttoButton.onclick=openTerminalOptions;
function ttoLocalize(){ttoButton.textContent=localStorage.lang==='en'?'Terminal options':'终端选项'}
ttoLocalize();
const ttoPrevLocalize=localize;localize=()=>{ttoPrevLocalize();ttoLocalize()};
