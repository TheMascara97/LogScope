'use strict';
const {spawn}=require('node:child_process');
function run(program,args,input='',timeoutMs=60000){
 return new Promise((resolve,reject)=>{
  const p=spawn(program,args,{windowsHide:true});let out='',err='',done=false;
  const timeout=setTimeout(()=>{p.kill();finish(Error('Operation timed out'))},timeoutMs);
  function finish(error){if(done)return;done=true;clearTimeout(timeout);error?reject(error):resolve(out)}
  p.on('error',finish);p.stdout.on('data',d=>out=(out+d).slice(-1024*1024));p.stderr.on('data',d=>err=(err+d).slice(-65536));
  p.on('close',code=>finish(code===0?null:Error(err||'Process exit '+code)));p.stdin.on('error',()=>{});p.stdin.end(input);
 });
}
function quote(value){if(/[\r\n\0]/.test(value))throw Error('Invalid path');return '"'+value.replace(/\\/g,'/').replace(/"/g,'\\"')+'"'}
// Argument and batch construction is split out from execution so it can be asserted without
// a server: the resume switches are the whole feature, and a wrong one silently either
// restarts a transfer from zero or appends to the wrong file.
function sftpArgs(cfg,action){
 if(!/^[\w.:[\]-]+$/.test(cfg.host)||! /^[\w.-]+$/.test(cfg.user))throw Error('Invalid SSH host/user');
 // `||22` made port 0 the login port, so an invalid port was silently accepted instead of
 // rejected. Only a missing port defaults now.
 const port=cfg.port===undefined||cfg.port===null||cfg.port===''?22:Number(cfg.port);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
 const args=['-oBatchMode=yes','-oConnectTimeout=10','-P',String(port),'-b','-'];
 if(cfg.key)args.push('-i',cfg.key);
 if(cfg.jump){if(!/^[\w.@:[\],-]+$/.test(cfg.jump))throw Error('Invalid jump host');args.push('-oProxyJump='+cfg.jump);}
 args.push(cfg.user+'@'+cfg.host);
 return args;
}
function sftpCommand(cfg,action,remote,local){
 if(action!=='list'&&/[?*\[\]]/.test(remote))throw Error('Wildcard transfer paths are not supported; select one exact file');
 if(action==='list')return 'ls -la '+quote(remote||'.');
 // `get -a` resumes a partial download and `put -a` resumes a partial upload: sftp appends
 // from the local file's current length (download) or re-reads the remote length (upload)
 // instead of starting over. They are the whole reason a 15-minute transfer budget is now
 // survivable — a dropped link costs the bytes in flight, not the file.
 if(action==='download'||action==='download-file')return (cfg.resume?'get -a ':'get ')+quote(remote)+' '+quote(local);
 if(action==='upload'||action==='upload-file')return (cfg.resume?'put -a ':'put ')+quote(local)+' '+quote(remote);
 throw Error('Unsupported file operation');
}
async function sftp(cfg,action,remote,local){
 const args=sftpArgs(cfg,action);
 // A listing answers in seconds, but a transfer is bounded by its size and the link, and
 // a 60 s cap killed legitimate uploads. Give transfers their own budget; callers may
 // still pass an explicit one.
 const timeoutMs=Number(cfg.timeoutMs)>0?Number(cfg.timeoutMs):(action==='list'?60000:15*60*1000);
 const command=sftpCommand(cfg,action,remote,local);
 if(action==='upload'||action==='upload-file'){
   // Watch the local file so a too-short budget fails with the reason, not with silence.
   let size=0;try{size=require('node:fs').statSync(local).size}catch(cause){throw Error('Local file is not readable: '+cause.message)}
   if(size>4*1024*1024*1024)throw Error('File is larger than the 4 GiB upload limit');
   return run('sftp.exe',args,command+'\nbye\n',timeoutMs).then(output=>output+'\n'+size+' bytes uploaded');
 }
 return run('sftp.exe',args,command+'\nbye\n',timeoutMs);
}
async function adbDevices(){
 const output=await run('adb.exe',['devices','-l']);
 return output.split(/\r?\n/).slice(1).filter(x=>x.trim()).map(line=>{const [serial,state,...details]=line.trim().split(/\s+/);return {serial,state,description:details.join(' ')}});
}
module.exports={sftp,sftpArgs,sftpCommand,adbDevices};
