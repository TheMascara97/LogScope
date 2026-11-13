'use strict';
// 信息密度：WindTerm 的窗口里垂直空间几乎全部留给输出。这里做两件低风险的事——
// 1) logMeter（缓存/匹配/跟随状态）原本独占一根状态条，吃掉一整行高度；把它挪进搜索行
//    右端，状态照样常显，输出口多出一行。元素只搬家不改类名，e2e 与其它模块读的都是
//    logMeter.textContent / .log-meter 类，搬家对它们透明。
// 2) 其余密度（头部 48px、标签 38px、搜索行 40px、按钮 6px 内边距等）全部走
//    workstation.css 末尾的密度批次，不碰任何 JS 逻辑。
// 加载顺序：interface.js（logMeter 诞生处）之后即可；放在 command-completion.js 旁。
if(typeof logMeter!=='undefined'&&logMeter.parentElement!==$('.filter')){
 const filter=$('.filter');
 if(filter)filter.append(logMeter);
}
