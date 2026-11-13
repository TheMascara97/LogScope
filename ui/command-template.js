'use strict';
(function(root){
 function parameters(text){const list=[],seen=new Set;for(const m of String(text).matchAll(/\$\{([A-Za-z_]\w*)(?:=([^}\r\n]*))?\}/g)){if(!seen.has(m[1])){list.push({name:m[1],value:m[2]||''});seen.add(m[1])}}return list}
 function expand(text,values){return String(text).replace(/\$\{([A-Za-z_]\w*)(?:=([^}\r\n]*))?\}/g,(_,name,defaultValue)=>{const value=String(values[name]??defaultValue??'');if(/[\r\n\0]/.test(value))throw Error('Parameter contains a newline or NUL: '+name);return value})}
 const api={parameters,expand};if(typeof module!=='undefined')module.exports=api;else root.CommandTemplate=api;
})(globalThis);
