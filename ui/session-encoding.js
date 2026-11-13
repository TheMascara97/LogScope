'use strict';
// CJK 编码规避（纯 UI，不改 C++ core、不重编译）：core 的终端解码固定 UTF-8，而中文
// Windows 的 cmd/PowerShell 默认 GBK 代码页，中文输出必乱码。两层规避：
//  ① 连接时组合（encCompose）：给 localCommand/command 前置编码命令 —— cmd 用
//     `chcp 65001>nul&`（>nul 吃掉回显）；powershell 前置 OutputEncoding 赋值；
//     wsl / 非交互 ssh 前置 export LANG。
//  ② 连接后自动发送（encArm）：组合没机会生效时（如 cmd 空命令直接开交互壳），在
//     session 事件 400ms 后补发一行编码命令；代价是回显一行（"Active code page:
//     65001"），每会话至多一次（encDone 幂等，closed/error 重新武装）。
// 开关（全局设置）：utf8Fix 默认开（'false' 关）；sshLangFix 默认关 —— export LANG
// 会让非 POSIX 远端（Windows sshd、网络设备）整行报错，须用户显式开启。
// 诚实限制（STATUS.md 同步记录）：串口 GBK/Big5 仍乱码（core 缺解码器，需改 C++）；
// 远端程序无视 LANG 时无效；export 只影响其后启动的子进程。
// 前缀 enc 全局唯一。加载位置：automation.js 之后、workbench.js 之前 —— connect 包装链
// （config-controls→workspace-controls→workbench→本文件→renderer）里 workbench 向下传
// remember=false 并自行保存原始 profile，因此组合出的命令行不会污染已保存会话。
const encDone=new Set(),encComposed=new Map();
const ENC_PS='[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8';
const ENC_EXPORT='export LANG=C.UTF-8 LC_ALL=C.UTF-8';
function encUtf8On(){return localStorage.utf8Fix!=='false'}
function encSshLangOn(){return localStorage.sshLangFix==='true'}
function encCompose(p){
 if(!p||typeof p!=='object'||!encUtf8On())return p;
 const kind=String(p.kind||'').toLowerCase(),q={...p};let touched=false;
 if(kind==='cmd'&&q.localCommand){q.localCommand='chcp 65001>nul&'+q.localCommand;touched=true}
 else if(kind==='powershell'&&q.localCommand){q.localCommand=ENC_PS+'; '+q.localCommand;touched=true}
 else if(kind==='wsl'&&q.localCommand){q.localCommand=ENC_EXPORT+'; '+q.localCommand;touched=true}
 else if(kind==='ssh'&&!q.interactive&&q.command&&encSshLangOn()){q.command=ENC_EXPORT+'; '+q.command;touched=true}
 if(touched&&q.requestId){encComposed.set(q.requestId,true);setTimeout(()=>encComposed.delete(q.requestId),15000)}
 return touched?q:p;
}
const encConnectBase=connect;
connect=(p,remember=true)=>encConnectBase(encCompose(p),remember);
// 连接成功后补发编码命令。延迟 400ms：等 core 把会话 stdin 稳定下来，也让
// workspace-controls 的 sessionProfiles 先落库（ssh interactive 判定要用 profile）。
onCoreEvent(m=>{
 if(m.type==='session.state'&&(m.state==='closed'||m.state==='error')){encDone.delete(m.id);return}
 if(m.type!=='session'||!encUtf8On()||encDone.has(m.id))return;
 const kind=String(m.kind||'').toLowerCase();
 if(!['cmd','powershell','wsl','ssh'].includes(kind))return;
 const id=m.id,composed=!!(m.requestId&&encComposed.get(m.requestId)),readOnly=!!m.readOnly;
 encDone.add(id);
 setTimeout(()=>{
  let line='';
  try{
   if(kind==='cmd'&&!readOnly&&!composed)line='chcp 65001';
   else if(kind==='powershell'&&!composed)line=ENC_PS;
   else if(kind==='wsl'&&!composed)line=ENC_EXPORT;
   else if(kind==='ssh'){const p=(typeof sessionProfiles!=='undefined'&&sessionProfiles.get(id))||null;if(p&&p.interactive)line=ENC_EXPORT}
   if(line)window.core.send({type:'session.send',session:id,data:line+'\r',newline:false});
  }catch(e){/* 会话已关闭：放弃注入，不重试 */}
  if(encDone.size>500)encDone.clear();
 },400);
});
