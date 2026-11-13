'use strict';
// 终端屏幕文本工具：SerializeAddon 把当前终端（屏幕+回滚缓冲）还原成纯文本 ——
// 保留 ANSI 渲染结果、去掉控制序列，适合把终端现场贴进工单/聊天记录。与日志视图的
// 自由选择复制（log-selection.js）是两层：那边复制结构化日志行，这边复制终端所见。
// 前缀 ttx 全局唯一。加载位置：workbench.js 之后（要用 tool()/download()）。
// dataset.category 显式 'session'：workstation.js classifyTool 只对未分类按钮生效，
// 显式分类不会被中文标签正则重新猜类（e2e 工具分类检查依赖这一点）。
function ttxScreen(){
 const item=active?terminals.get(active):null;
 if(!item||!item.serialize){$('#status').textContent=uiText('当前标签没有可序列化的终端（导入的文件标签或组件缺失）','No serializable terminal for this tab (imported file or addon missing)');return null}
 return item.serialize.serialize({trimRight:true});
}
tool('复制终端屏幕 / Copy screen',()=>{
 const text=ttxScreen();if(text===null)return;
 Promise.resolve(window.core.copyText(text)).then(()=>{$('#status').textContent=uiText('终端屏幕已复制到剪贴板','Terminal screen copied to the clipboard')},e=>{$('#status').textContent=e&&e.message||String(e)});
});
bar.lastElementChild.dataset.category='session';
tool('导出终端屏幕 / Export screen',()=>{
 const text=ttxScreen();if(text===null)return;
 download('LogScope-terminal-'+new Date().toISOString().replace(/[:.]/g,'-')+'.txt',text,'text/plain');
});
bar.lastElementChild.dataset.category='session';
