'use strict';
// AI provider configuration. The saved shape lives in localStorage (provider, base, model,
// which vault entry holds the key) — the key itself never does: it goes to the encrypted
// vault through IPC and the renderer only ever keeps its id.
function aiConfig(){try{const c=JSON.parse(localStorage.aiProvider||'{}');return c&&typeof c==='object'?c:{}}catch{return {}}}
// Call sites read the provider from here instead of passing a bare model name, so a provider
// switch cannot leave an old model name addressed to the new base URL.
function aiRequestOptions(){
 const cfg=aiConfig();
 return {provider:cfg.provider||'custom',base:cfg.base||'',model:cfg.model||($('#model')?$('#model').value:''),keyId:cfg.keyId||'',envKey:cfg.envKey||''};
}
async function openAiSettings(){
 const d=document.createElement('dialog');d.id='aiSettings';
 d.className='manager-dialog';
 const title=document.createElement('h3'),hint=document.createElement('p'),form=document.createElement('form'),error=document.createElement('p');
 title.textContent=uiText('AI 模型服务配置','AI provider configuration');
 hint.textContent=uiText('密钥保存在 Windows 凭据加密存储中，只有主进程能读取；界面只保存密钥条目编号。请求仅发送给所选服务商，发送前仍会显示脱敏预览并要求确认。','The key is kept in the Windows encrypted credential store and read only by the main process; the UI stores just its entry id. Requests go only to the chosen provider, and every send still shows a redacted preview for confirmation.');
 const providerLabel=document.createElement('label'),provider=document.createElement('select');
 providerLabel.textContent=uiText('服务商','Provider');providerLabel.append(provider);form.append(providerLabel);
 const baseLabel=document.createElement('label'),base=document.createElement('input');
 baseLabel.textContent=uiText('接口地址（https，OpenAI 兼容）','Base URL (https, OpenAI-compatible)');base.placeholder='https://api.deepseek.com/v1';baseLabel.append(base);form.append(baseLabel);
 const modelLabel=document.createElement('label'),model=document.createElement('input');
 modelLabel.textContent=uiText('模型名称','Model');model.placeholder='deepseek-chat';modelLabel.append(model);form.append(modelLabel);
 // Free-model quick picks. The list comes from the main process presets (not hardcoded
 // here), each entry fills the model field and stays editable. Free tiers still need the
 // provider's own key and can change on the provider's side, so the row says that; the
 // genuinely free path without any account is the local Ollama service, reachable here too.
 const freeRow=document.createElement('div');freeRow.className='small';freeRow.dataset.role='freeModels';freeRow.hidden=true;
 const freeHint=document.createElement('p');freeHint.className='small';freeHint.hidden=true;
 freeHint.textContent=uiText('免费模型来自服务商公开政策，额度与可用性可能调整；仍需注册该服务商并保存 API 密钥。完全免费、无需账号的方式是下面的本机模型（Ollama）。','Free models follow each provider\'s published policy; quotas and availability may change. You still need that provider\'s account and API key. The fully free, account-less option is the local model (Ollama) below.');
 const localButton=document.createElement('button');localButton.type='button';
 localButton.textContent=uiText('本机模型（Ollama，免费离线）','Local model (Ollama, free offline)');
 localButton.onclick=()=>{d.close();if(typeof localModelButton!=='undefined')localModelButton.click()};
 const renderFreeModels=()=>{
  const current=presets.find(p=>p.id===provider.value),list=current&&Array.isArray(current.freeModels)?current.freeModels:[];
  freeRow.replaceChildren();freeRow.hidden=freeHint.hidden=!list.length;
  if(!list.length)return;
  const caption=document.createElement('span');caption.textContent=uiText('免费模型：','Free models: ');freeRow.append(caption);
  for(const name of list){
   const pick=document.createElement('button');pick.type='button';pick.textContent=name;pick.title=uiText('填入模型名称（可再编辑）','Fill the model name (still editable)');
   pick.onclick=()=>{model.value=name};
   freeRow.append(pick);
  }
 };
 form.append(freeRow,freeHint,localButton);
 const table=document.createElement('div'),tableHint=document.createElement('p');tableHint.className='small';
 tableHint.textContent=uiText('密钥保存在系统加密存储中（与凭据管理共用），列表中只显示名称。','Keys are saved in the system encrypted store (shared with Credentials); only names are listed.');
 const keyLabel=document.createElement('label'),key=document.createElement('input');
 keyLabel.textContent=uiText('API 密钥（保存后不再显示）','API key (not shown again once saved)');key.type='password';key.autocomplete='off';keyLabel.append(key);form.append(keyLabel);
 const keyNameLabel=document.createElement('label'),keyName=document.createElement('input');
 keyNameLabel.textContent=uiText('密钥名称','Key name');keyName.placeholder='deepseek-main';keyNameLabel.append(keyName);form.append(keyNameLabel);
 const addKey=document.createElement('button');addKey.type='button';addKey.textContent=uiText('加密保存密钥','Save key encrypted');
 const save=document.createElement('button'),cancel=document.createElement('button');
 save.type='submit';save.textContent=uiText('保存','Save');cancel.type='button';cancel.textContent=uiText('取消','Cancel');cancel.onclick=()=>d.close();
 let presets=[],keys=[],env={},envKey='';
 const renderKeys=()=>{table.replaceChildren();const pick=document.createElement('select');
  pick.append(new Option(uiText('使用环境变量（若已设置）','Use an environment variable (if set)'),''));
  for(const row of keys)pick.append(new Option(row.name,row.id));
  const stored=aiConfig().keyId;if(stored&&keys.some(x=>x.id===stored))pick.value=stored;
  pick.onchange=()=>{model.dataset.keyId=pick.value};
  const current=presets.find(p=>p.id===provider.value);
  const envNote=document.createElement('span');envNote.className='small';
  envNote.textContent=current&&current.env?(env[current.env]?uiText(' 已检测到环境变量 ',' detected: ')+current.env:uiText(' 未检测到环境变量 ','not set: ')+current.env):uiText(' 该服务商没有默认环境变量',' no default environment variable');
  const label=document.createElement('label');label.textContent=uiText('使用的密钥','Key to use');label.append(pick);
  table.append(label,envNote);
  pick.dataset.role='keyPick';
 };
 const syncBase=()=>{const current=presets.find(p=>p.id===provider.value);if(!current)return;
  const stored=aiConfig();
  // Only overwrite the fields when the provider actually changed; otherwise reopening the
  // dialog would silently discard a hand-edited base URL or model.
  if(stored.provider===current.id){base.value=stored.base||current.base;model.value=stored.model||current.model;envKey=stored.envKey||current.env||''}
  else{base.value=current.base;model.value=current.model;envKey=current.env||''}
  base.disabled=model.disabled=false;
  renderKeys();
  renderFreeModels();
 };
 provider.onchange=syncBase;
 form.append(tableHint,table);
 addKey.onclick=async()=>{
  const name=keyName.value.trim()||(presets.find(p=>p.id===provider.value)||{}).label||'AI key';
  if(!key.value.trim()){error.textContent=uiText('请先粘贴 API 密钥','Paste an API key first');return}
  try{const saved=await window.core.aiSaveKey(name,key.value.trim());key.value='';keys=keys.filter(x=>x.id!==saved.id).concat({id:saved.id,name:saved.name});error.textContent='';renderKeys();const pick=table.querySelector('[data-role=keyPick]');if(pick){pick.value=saved.id;model.dataset.keyId=saved.id}}
  catch(e){error.textContent=e.message}
 };
 form.onsubmit=e=>{
  e.preventDefault();
  try{
   const text=base.value.trim();
   if(/^http:/i.test(text))throw Error(uiText('必须使用 https：密钥会随请求头发送','https is required: the key travels in a request header'));
   const pick=table.querySelector('[data-role=keyPick]');
   localStorage.aiProvider=JSON.stringify({provider:provider.value,base:text,model:model.value.trim(),keyId:pick?pick.value:'',envKey});
   d.close();
  }catch(err){error.textContent=err.message}
 };
 form.append(addKey,error,save,cancel);
 d.append(title,hint,form);d.onclose=()=>{key.value='';d.remove()};document.body.append(d);d.showModal();
 try{
  const info=await window.core.aiProviders();
  presets=info.presets||[];keys=info.keys||[];env=info.env||{};window.aiPresetCache=presets;
  const stored=aiConfig();
  for(const p of presets){
   const free=Array.isArray(p.freeModels)&&p.freeModels.length;
   const suffix=free?(p.free?uiText('（默认模型免费）',' (default model free)'):uiText('（有免费模型）',' (free models available)')):'';
   provider.append(new Option(uiText(p.label,p.labelEn||p.label)+suffix,p.id));
  }
  provider.value=stored.provider&&presets.some(p=>p.id===stored.provider)?stored.provider:presets[0]?.id||'custom';
  syncBase();
 }catch(e){error.textContent=e.message}
}
const aiProviderButton=document.createElement('button');aiProviderButton.id='aiProviderSettings';aiProviderButton.dataset.category='session';bar.append(aiProviderButton);
aiProviderButton.onclick=()=>openAiSettings();
const localeBeforeAiProvider=localize;localize=()=>{localeBeforeAiProvider();aiProviderButton.textContent=uiText('AI 服务商','AI provider')};localize();
