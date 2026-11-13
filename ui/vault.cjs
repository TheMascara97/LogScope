'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net'),{execFile}=require('node:child_process');
const {app,safeStorage}=require('electron');const temporary=new Set();
function root(){return app.getPath('userData')}
function records(){try{return JSON.parse(fs.readFileSync(path.join(root(),'credentials.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return[];throw e}}
function commit(value){fs.mkdirSync(root(),{recursive:true});const file=path.join(root(),'credentials.json');fs.writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(file+'.tmp',file)}
function requireEncryption(){if(!safeStorage.isEncryptionAvailable())throw Error('Windows credential encryption is unavailable')}
function save(name,secret,type='password'){
 requireEncryption();if(typeof name!=='string'||!name.trim()||typeof secret!=='string'||!secret||secret.length>1024*1024)throw Error('Invalid credential');
 if(!/^[a-z]{1,16}$/.test(type))throw Error('Invalid credential type');
 const id=crypto.randomUUID(),all=records();all.push({id,name:name.slice(0,128),type,data:safeStorage.encryptString(secret).toString('base64')});commit(all);return {id,name,type};
}
// API keys live in the same encrypted store as passwords but are requested by the AI backend
// by their own type, so a password entry can never be spent as a provider key.
function secret(id,type){
 requireEncryption();const row=records().find(x=>x.type===type&&(x.id===id||x.name===id));if(!row)throw Error('Credential not found');return safeStorage.decryptString(Buffer.from(row.data,'base64'));
}
function find(id,type){requireEncryption();const row=records().find(x=>x.id===id&&x.type===type);if(!row)throw Error('Credential not found');return safeStorage.decryptString(Buffer.from(row.data,'base64'))}
async function keyFile(id){
 const secret=find(id,'key'),dir=path.join(root(),'runtime-keys');await fs.promises.mkdir(dir,{recursive:true});const file=path.join(dir,'key-'+id+'.pem');
 await fs.promises.writeFile(file,'',{mode:0o600});temporary.add(file);
 const account=(process.env.USERDOMAIN?process.env.USERDOMAIN+'\\':'')+process.env.USERNAME;
 await new Promise((resolve,reject)=>execFile('icacls.exe',[file,'/inheritance:r','/grant:r',account+':(R,W)','SYSTEM:F'],{windowsHide:true},e=>e?reject(e):resolve()));
 await fs.promises.writeFile(file,secret,{mode:0o600});return file;
}
function sendPassword(id,session){const value=find(id,'password');return new Promise((resolve,reject)=>{const socket=net.connect('\\\\.\\pipe\\'+(process.env.LOGSCOPE_PIPE||'LogScopeCore'));socket.setTimeout(5000,()=>{socket.destroy();reject(Error('Core timeout'))});socket.on('error',reject);socket.on('connect',()=>{socket.end(JSON.stringify({type:'session.send',session,data:value+'\r',newline:false})+'\n',resolve)})})}
function cleanup(){for(const file of temporary){try{fs.unlinkSync(file)}catch{}}temporary.clear()}
function cleanupStale(){const dir=path.join(root(),'runtime-keys');if(!fs.existsSync(dir))return;for(const name of fs.readdirSync(dir)){if(/^key-[a-f0-9-]+\.pem$/.test(name))fs.unlinkSync(path.join(dir,name))}}
module.exports={save,secret,list:()=>records().map(({id,name,type})=>({id,name,type})),remove:id=>commit(records().filter(x=>x.id!==id)),keyFile,sendPassword,cleanup,cleanupStale};
