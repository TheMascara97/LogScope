'use strict';
(function(root){
 class LogCacheBudget{
  constructor(perSession=32*1024*1024,total=128*1024*1024,maxRows=100000){this.perSession=perSession;this.total=total;this.maxRows=maxRows;this.states=new Map();this.costs=new WeakMap();this.evicted=0}
  cost(row){return 256+96*Object.keys(row.fields||{}).length+4*(String(row.text||'').length+String(row.redacted||'').length)}
  update(id,rows){let state=this.states.get(id);if(!state||state.rows!==rows||rows.length<state.length){state={rows,length:0,bytes:0,last:null};this.states.set(id,state)}if(state.last){const now=this.cost(state.last),before=this.costs.get(state.last)||0;state.bytes+=now-before;this.costs.set(state.last,now)}for(let i=state.length;i<rows.length;i++){const value=this.cost(rows[i]);this.costs.set(rows[i],value);state.bytes+=value}state.length=rows.length;state.last=rows.at(-1);return state}
  trim(state){const count=Math.min(1000,Math.max(1,Math.ceil(state.rows.length/20)));const removed=state.rows.splice(0,count);for(const row of removed)state.bytes-=this.costs.get(row)||this.cost(row);state.length=state.rows.length;state.last=state.rows.at(-1);this.evicted+=removed.length}
  enforce(buffers){for(const id of this.states.keys())if(!buffers.has(id))this.states.delete(id);for(const [id,rows] of buffers){const state=this.update(id,rows);while(state.rows.length&&(state.bytes>this.perSession||state.rows.length>this.maxRows))this.trim(state)}let sum=[...this.states.values()].reduce((n,s)=>n+s.bytes,0);while(sum>this.total){const largest=[...this.states.values()].sort((a,b)=>b.bytes-a.bytes)[0];if(!largest?.rows.length)break;const before=largest.bytes;this.trim(largest);sum-=before-largest.bytes}return {estimatedBytes:sum,evicted:this.evicted}}
 }
 if(typeof module!=='undefined')module.exports={LogCacheBudget};else root.LogCacheBudget=LogCacheBudget;
})(globalThis);
