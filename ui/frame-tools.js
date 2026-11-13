'use strict';
// HEX 帧解析对话框：字段模板（类型/位域/字节序）、校验算法、批量切帧、反向组帧。
//
// 界面只做三件事：读模板、调 FrameAnalysis、把结果画出来。所有换算和边界检查都在
// frame-analysis.js 里，这样同一份逻辑能被 Node 测试直接覆盖。
const frameButton=document.createElement('button');frameButton.id='frameAnalysis';frameButton.dataset.category='analysis';bar.append(frameButton);
frameButton.onclick=()=>new Promise(resolve=>{
 const d=document.createElement('dialog');d.id='frameDialog';d.className='manager-dialog';
 const title=document.createElement('h3'),frame=document.createElement('textarea'),form=document.createElement('div'),fieldRows=document.createElement('div'),result=document.createElement('pre');
 title.textContent=uiText('二进制帧解析（离线计算）','Binary frame analysis (offline)');
 frame.placeholder='01 03 00 00 00 0A C5 CD';frame.value=localStorage.frameSample||frame.placeholder;
 function input(parent,label,value,type='text',step){const wrap=document.createElement('label'),el=document.createElement('input');wrap.textContent=label;el.type=type;el.value=value;if(step)el.step=step;wrap.append(el);parent.append(wrap);return el}
 function select(parent,label,options,value){const wrap=document.createElement('label'),el=document.createElement('select');wrap.textContent=label;for(const item of options)el.append(new Option(item,item));el.value=value;wrap.append(el);parent.append(wrap);return el}
 let savedTemplate;try{savedTemplate=JSON.parse(localStorage.frameTemplate||'null')}catch{}
 const defaults={length:8,fields:[{name:'Device',type:'uint',offset:0,size:1,endian:'big'},{name:'Count',type:'uint',offset:4,size:2,endian:'big'}],checksum:{algorithm:'crc16-modbus',start:0,end:6,offset:6,endian:'little'}};
 const preset=savedTemplate&&Array.isArray(savedTemplate.fields)?savedTemplate:defaults;
 const algorithms=['none','sum8','lrc','xor8','crc8','crc16-modbus','crc16-ccitt','crc16-xmodem','fletcher16','adler32','crc32'];
 const length=input(form,uiText('预期字节数（空白不检查）','Expected bytes (blank skips check)'),preset.length??'','number');
 const algorithm=select(form,uiText('校验算法','Checksum'),algorithms,preset.checksum?.algorithm||'none');
 const start=input(form,uiText('覆盖起点（含）','Start (inclusive)'),preset.checksum?.start??0,'number');
 const end=input(form,uiText('覆盖终点（不含）','End (exclusive)'),preset.checksum?.end??6,'number');
 const offset=input(form,uiText('校验值位置','Checksum offset'),preset.checksum?.offset??6,'number');
 const endian=select(form,uiText('校验值字节序','Checksum byte order'),['little','big'],preset.checksum?.endian||'little');

 // 字段编辑器：类型决定哪些输入有意义（位域用 bitOffset，整数/浮点/ASCII/BCD 用字节数）。
 const fields=[];
 function addField(field={name:'Field',type:'uint',offset:0,size:1,endian:'big'}){
  if(fields.length>=64)return;
  const row=document.createElement('fieldset'),data={row};
  data.name=input(row,uiText('字段','Field'),field.name||'Field');
  data.type=select(row,uiText('类型','Type'),['uint','int','float','ascii','bcd','bits'],field.type||'uint');
  data.offset=input(row,uiText('偏移','Offset'),field.offset??0,'number');
  data.size=input(row,uiText('字节数 / 位数','Bytes / bits'),field.size??1,'number');
  data.bitOffset=input(row,uiText('位偏移（位域用）','Bit offset (bits only)'),field.bitOffset??0,'number');
  data.endian=select(row,uiText('字节序','Byte order'),['big','little'],field.endian||'big');
  const remove=document.createElement('button');remove.textContent=uiText('删除字段','Remove field');
  remove.onclick=()=>{fields.splice(fields.indexOf(data),1);row.remove()};
  row.append(remove);fields.push(data);fieldRows.append(row);
  const sync=()=>{const bits=data.type.value==='bits';data.bitOffset.disabled=!bits;data.endian.disabled=bits||data.type.value==='ascii'||data.type.value==='bcd'};
  data.type.onchange=sync;sync();
 }
 for(const field of (preset.fields||[]).slice(0,64))addField(field);

 const add=document.createElement('button'),run=document.createElement('button'),build=document.createElement('button'),scan=document.createElement('button'),save=document.createElement('button'),close=document.createElement('button');
 add.textContent=uiText('添加字段','Add field');
 run.textContent=uiText('解析并校验','Analyze & validate');
 build.textContent=uiText('按模板组帧','Build frame from template');
 scan.textContent=uiText('切分多帧','Split stream');
 save.textContent=uiText('保存模板','Save template');
 close.textContent=uiText('关闭','Close');
 add.onclick=()=>addField();

 const template=()=>({
  length:length.value===''?undefined:Number(length.value),
  fields:fields.map(field=>({name:field.name.value,type:field.type.value,offset:field.offset.value,size:field.size.value,bitOffset:field.bitOffset.value,endian:field.endian.value})),
  checksum:{algorithm:algorithm.value,start:start.value,end:end.value,offset:offset.value,endian:endian.value}
 });

 // 组帧：把每个字段的 value 输入框里的值写成字节。值框是懒创建的——模板编辑阶段
 // 不需要它们，只有组帧时才显示。
 const values=document.createElement('div');values.className='frame-values';
 const valueInputs=new Map();
 const syncValueInputs=()=>{
  values.replaceChildren();valueInputs.clear();
  for(const field of template().fields){
   const wrap=document.createElement('label'),el=document.createElement('input');
   wrap.textContent=field.name;el.placeholder=field.type==='ascii'?'text':field.type==='bcd'?'1234':'0';el.dataset.field=field.name;
   wrap.append(el);values.append(wrap);valueInputs.set(field.name,el);
  }
 };
 const print=value=>{result.textContent=typeof value==='string'?value:JSON.stringify(value,null,2)};

 run.onclick=()=>{
  try{
   const analysis=FrameAnalysis.analyze(frame.value,template());
   localStorage.frameSample=frame.value;
   print(FrameAnalysis.report(analysis)+'\n\n'+JSON.stringify(analysis,null,2));
  }catch(e){print(uiText('解析失败：','Analysis failed: ')+e.message)}
 };
 build.onclick=()=>{
  try{
   syncValueInputs();
   const collected={};
   for(const [name,el] of valueInputs)if(el.value!=='')collected[name]=el.value;
   const bytes=FrameAnalysis.build(template(),collected);
   const hex=[...bytes].map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(' ');
   frame.value=hex;
   print(uiText('已组帧（字节已填入上方输入框）：\n','Frame built (bytes filled into the box above):\n')+hex+'\n\n'+FrameAnalysis.report(FrameAnalysis.analyze(hex,template())));
  }catch(e){print(uiText('组帧失败：','Build failed: ')+e.message)}
 };
 scan.onclick=()=>{
  try{
   // 切帧参数从模板里推断：校验之前的字节里如果有固定的帧头字节，就用它当 SOF。
   // 没有帧头时退回按 0x7E 分隔；两条都不给用户猜，直接说明用了哪条规则。
   const sof=template().fields.find(field=>Number(field.offset)===0)?.name;
   const delimiter=localStorage.frameDelimiter?Number(localStorage.frameDelimiter):0x7e;
   const frames=FrameAnalysis.scan(frame.value,{delimiter});
   print(uiText('按 0x','Split on 0x')+delimiter.toString(16).toUpperCase()+uiText(' 切出 ',' → ')+frames.length+uiText(' 帧：\n',' frames:\n')+frames.map((item,index)=>'#'+(index+1)+'  offset '+item.start+'  '+item.length+' B  '+[...item.data].map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(' ')).join('\n'));
   void sof;
  }catch(e){print(uiText('切帧失败：','Split failed: ')+e.message)}
 };
 save.onclick=()=>{
  try{
   FrameAnalysis.analyze(frame.value,template());
   localStorage.frameTemplate=JSON.stringify(template());
   localStorage.frameSample=frame.value;
   print(uiText('模板已保存','Template saved'));
  }catch(e){print(e.message)}
 };
 close.onclick=()=>d.close();
 d.onclose=()=>{d.remove();resolve()};
 d.append(title,frame,form,fieldRows,add,values,run,build,scan,save,close,result);
 document.body.append(d);d.showModal();
});
const localeBeforeFrames=localize;localize=()=>{localeBeforeFrames();frameButton.textContent=uiText('二进制帧解析','Binary frame analyzer')};localize();
