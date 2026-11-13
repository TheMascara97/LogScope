'use strict';
// WindTerm 式搜索选项：区分大小写、正则/字面切换。
// 必须排在 workspace-controls.js 之前加载——它末尾的 localize() 会立刻触发一次 render(true)，
// 而 render/filteredRowsAsync 都要调用下面的 wtQueryPattern/wtQueryFlags。ui/*.js 共用一个
// 全局作用域，加载顺序错了整份脚本直接 ReferenceError。
const wtSearchOptions={
 caseSensitive:localStorage.logscopeSearchCase==='1',
 regex:localStorage.logscopeSearchRegex!=='0',
 showTime:localStorage.logscopeShowTime!=='0'};
function wtEscapeLiteral(text){return String(text).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
// 把搜索框内容统一成 worker 可执行的模式：正则模式原样返回（语法由 render 层把关），
// 字面模式转义全部元字符——此时 '[' 不再报错，就是一个普通字符。
function wtQueryPattern(query){return wtSearchOptions.regex?query:wtEscapeLiteral(query)}
function wtQueryFlags(){return wtSearchOptions.caseSensitive?'':'i'}
(function(){
 const caseButton=document.createElement('button'),regexButton=document.createElement('button');
 caseButton.id='searchCaseToggle';caseButton.type='button';caseButton.textContent='Aa';
 caseButton.title='区分大小写 / Match case';
 regexButton.id='searchRegexToggle';regexButton.type='button';regexButton.textContent='.*';
 regexButton.title='正则模式；关闭后按字面文本匹配 / Regex mode; off = literal text';
 // 此时 #query 已在 DOM（脚本都在 body 末尾），插到搜索框和 #status 之间。
 $('#query').after(caseButton,regexButton);
 function paint(){caseButton.setAttribute('aria-pressed',String(wtSearchOptions.caseSensitive));regexButton.setAttribute('aria-pressed',String(wtSearchOptions.regex))}
 caseButton.onclick=()=>{wtSearchOptions.caseSensitive=!wtSearchOptions.caseSensitive;localStorage.logscopeSearchCase=wtSearchOptions.caseSensitive?'1':'';paint();render(true)};
 regexButton.onclick=()=>{wtSearchOptions.regex=!wtSearchOptions.regex;localStorage.logscopeSearchRegex=wtSearchOptions.regex?'':'0';paint();render(true)};
 paint();
})();
