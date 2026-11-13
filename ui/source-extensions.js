'use strict';
for(const [kind,label] of [['powershell','PowerShell'],['wsl','WSL']]){const b=document.createElement('button');b.type='button';b.className='proto';b.dataset.type=kind;b.textContent=label;b.onclick=()=>modalType(kind);$('.protocols').append(b)}
const oldProfileAddress=profileAddress;profileAddress=p=>['powershell','wsl'].includes(p.kind)?(p.localCommand||(p.kind==='powershell'?'powershell.exe':'wsl.exe')):oldProfileAddress(p);
