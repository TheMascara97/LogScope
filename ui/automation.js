'use strict';
(function(root){
 function validate(steps,depth=0){
  if(!Array.isArray(steps)||depth>12)throw Error('Script nesting is invalid');
  let cost=0;
  for(const s of steps){
   if(!s||typeof s!=='object')throw Error('Invalid script step');
   const keys=['send','wait','expect','repeat','if'].filter(k=>Object.hasOwn(s,k));if(keys.length!==1)throw Error('Each step needs exactly one action');
   if('send'in s&&(typeof s.send!=='string'||s.send.length>4096))throw Error('Invalid command');
   if('wait'in s&&(!Number.isFinite(s.wait)||s.wait<0||s.wait>60000))throw Error('Wait must be 0..60000 ms');
   if('expect'in s&&(typeof s.expect!=='string'||!s.expect||s.timeout!==undefined&&(!Number.isFinite(s.timeout)||s.timeout<0||s.timeout>60000)))throw Error('Invalid expect step');
   if('repeat'in s){if(!Number.isInteger(s.repeat)||s.repeat<1||s.repeat>1000)throw Error('Repeat must be 1..1000');cost+=s.repeat*validate(s.steps,depth+1)}
   else if('if'in s){if(typeof s.if!=='string')throw Error('Invalid condition');cost+=Math.max(validate(s.then||[],depth+1),validate(s.else||[],depth+1))}
   else cost++;
   if(cost>10000)throw Error('Script exceeds 10000 actions');
  }
  return cost;
 }
 async function run(steps,ctx){
  validate(steps);
  const check=()=>{if(ctx.signal?.aborted)throw Error('Script stopped')};
  const pause=async ms=>{const end=Date.now()+ms;while(Date.now()<end){check();await new Promise(r=>setTimeout(r,Math.min(50,end-Date.now())))}};
  async function execute(list){for(const s of list){check();if('send'in s){await ctx.send(s.send)}else if('wait'in s)await pause(s.wait);else if('expect'in s){const end=Date.now()+(s.timeout??10000);while(!ctx.text().includes(s.expect)){if(Date.now()>=end)throw Error('Expected text timed out: '+s.expect);await pause(50)}}else if('repeat'in s){for(let i=0;i<s.repeat;i++)await execute(s.steps)}else await execute(ctx.text().includes(s.if)?s.then||[]:s.else||[])}}
  await execute(steps);
 }
 const api={run,validate};if(typeof module!=='undefined')module.exports=api;else root.LogAutomation=api;
})(globalThis);
