'use strict';
// Keep the collection view uncluttered while retaining discoverable advanced tools.
const toolbox=document.createElement('details'),toolSummary=document.createElement('summary'),toolSearch=document.createElement('input');
toolbox.className='toolbox';toolSummary.textContent='工具 / Tools';toolSearch.placeholder='搜索工具 / Find a tool';
bar.before(toolbox);toolbox.append(toolSummary,toolSearch,bar);toolSearch.oninput=()=>{for(const b of bar.children)b.hidden=!b.textContent.toLowerCase().includes(toolSearch.value.toLowerCase())};
const names={'清屏':'Clear','字体 +':'Font +','字体 −':'Font −','工作区导出':'Export workspace','工作区导入':'Import workspace','结构化字段':'Parsed fields','异常趋势':'Error trends','书签列表':'Bookmarks','日志对比':'Compare logs','HTML 报告':'HTML report','本地知识库':'Local knowledge base','知识库检索':'Search knowledge base','项目工作区':'Project workspace','自动恢复 开/关':'Toggle auto restore','导入加密私钥':'Import encrypted key','凭据管理':'Credentials','规则动作':'Rule actions','解析插件':'Parser templates','条件脚本':'Conditional script','停止条件脚本':'Stop script','测试步骤':'Test steps','测试结果关联':'Test correlation','自动保存目录':'Automatic log directory','脱敏字段':'Redaction fields','HEX 发送 开/关':'Toggle HEX send','PDF 报告':'PDF report','异常通知 开/关':'Toggle notifications','SFTP 列表':'SFTP list','SFTP 上传':'SFTP upload','SFTP 下载':'SFTP download','保存恢复点':'Save recovery point','恢复标签页':'Restore tabs','搜索整个文件':'Search entire file','终端 / 日志':'Terminal / Logs','数据位':'Data bits','停止位':'Stop bits','校验':'Parity','流控':'Flow control','扫描':'Scan','快捷命令':'Quick commands','＋ 添加命令':'Add command','取消':'Cancel','保存':'Save','加密保存':'Save encrypted','关闭':'Close','删除':'Delete','填入当前会话密码提示':'Send to current password prompt'};
const labels={newSession:['＋ 新建会话','＋ New session'],save:['自动保存位置','Log save path'],importLog:['导入日志','Import logs'],rules:['过滤规则','Filter rules'],bookmark:['书签','Bookmark'],context:['异常上下文','Error context'],stats:['统计','Statistics'],report:['导出报告','Export report'],ai:['智能分析','Analyze'],schedule:['定时发送','Scheduled send'],quickManage:['快捷命令','Quick commands'],close:['断开','Disconnect'],quickAdd:['＋ 添加命令','Add command'],quickSave:['保存','Save']};
const originalText=new WeakMap();
function translateControls(){const en=$('#language').value==='en';document.documentElement.lang=en?'en':'zh-CN';for(const [id,values] of Object.entries(labels))if($('#'+id))$('#'+id).textContent=values[en?1:0];
 $('#query').placeholder=en?'Search / regex in current session':'搜索 / 正则过滤当前窗口';
 // The field below the log is the scheduled-send payload, so its placeholder says so; the wording
 // lives here because this pass owns placeholders for both languages.
 $('#command').placeholder=en?'Command for scheduled send (Enter does not send)':'定时发送的命令（Enter 不发送）';
 toolSummary.textContent=en?'Tools':'工具';toolSearch.placeholder=en?'Find a tool':'搜索工具';
 for(const element of document.querySelectorAll('.toolbox button,dialog button,dialog label,dialog label span,dialog strong')){if(element.id&&labels[element.id])continue;for(const node of element.childNodes){if(node.nodeType!==Node.TEXT_NODE||!node.textContent.trim())continue;if(!originalText.has(node))originalText.set(node,node.textContent);const source=originalText.get(node);const key=source.trim();const translation=names[key]||(key.includes(' / ')?key.split(' / ').slice(1).join(' / '):null);if(translation)node.textContent=en?translation:source}}
 // `#timerToggle` is deliberately not set here any more: schedule-send.js owns the whole timer
 // panel and repaints it after this pass runs, and a second writer here only made the button show
 // a stale label on every language change.
}
const localeBeforeTools=localize;localize=()=>{localeBeforeTools();translateControls()};$('#language').onchange=localize;
const cappedFinding=addFinding;addFinding=(title,text)=>{cappedFinding(title,String(text).slice(0,200000));while($('#findings').children.length>100)$('#findings').lastElementChild.remove()};
const logMeter=document.createElement('span');logMeter.className='log-meter';$('#terminal').before(logMeter);
let paused=false,followTail=true;
tool('暂停显示 / Pause display',()=>{paused=!paused;if(!paused)render();logMeter.textContent=paused?'显示暂停；采集和保存继续 / Display paused; collection continues':''});
tool('自动滚动 / Follow tail',()=>{followTail=!followTail;$('#status').textContent='Follow tail: '+followTail});
tool('关闭标签 / Close tab',()=>{if(!active)return;closedTabs.add(active);window.core.send({type:'session.close',session:active});terminals.get(active)?.term.dispose();terminals.get(active)?.node.remove();terminals.delete(active);termTitles.delete(active);sessions.delete(active);lines.delete(active);importPaths.delete(active);active=sessions.keys().next().value||'';applySessionView(active);render();showTerminal()});
const boundedRender=render;render=()=>{if(paused)return;const pane=$('#terminal'),scroll=pane.scrollTop;boundedRender();if(followTail)pane.scrollTop=pane.scrollHeight;else pane.scrollTop=scroll;const count=(lines.get(active)||[]).length;logMeter.textContent=$('#language').value==='en'?`${count.toLocaleString()} buffered rows · display ≤ 2,000 · raw file independent`:`缓存 ${count.toLocaleString()} 行 · 显示上限 2,000 行 · 原始文件独立保存`;if(splitPane)splitPane.textContent=(lines.get(splitSelect.value)||[]).slice(-300).map(x=>'['+x.time+'] '+x.text).join('\n')};
$('#query').oninput=render;
localize();render();
window.core.onMenu(command=>{if(command.startsWith('language:')){$('#language').value=command.slice(9);localize()}});
tool('TICK 时间基准 / TICK clock',async()=>{const value=await editor('TICK: frequency Hz; optional baseTime (ISO) and baseTick',localStorage.tickClock||'{"frequency":1000,"baseTick":0,"baseTime":""}');if(value===null)return;try{const v=JSON.parse(value);if(!Number.isFinite(v.frequency)||v.frequency<=0||!Number.isFinite(v.baseTick)||v.baseTime&&!Number.isFinite(Date.parse(v.baseTime)))throw Error('Invalid TICK clock');localStorage.tickClock=JSON.stringify(v)}catch(e){$('#status').textContent=e.message}});
const ordinaryTimeValue=timeValue;timeValue=value=>{if(!/^TICK/i.test(value))return ordinaryTimeValue(value);let config;try{config=JSON.parse(localStorage.tickClock||'{}')}catch{config={}}const tick=Number(value.match(/\d+/)?.[0]),ms=(tick-(config.baseTick||0))*1000/(config.frequency||1000);return value+' → '+(config.baseTime?new Date(Date.parse(config.baseTime)+ms).toLocaleString():ms/1000+' s elapsed (no wall-clock base configured)')};
translateControls();
