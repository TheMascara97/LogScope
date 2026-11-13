'use strict';
(function(root){
  // Redaction runs for every ingested line, and building this expression on each call
  // showed up as compile time in the hot path. The key set is tiny (the configured
  // fields), so cache one compiled pattern per set instead.
  const patternCache=new Map();

  function redactPattern(extra){
    const key=extra.join('|');
    let pattern=patternCache.get(key);
    if(!pattern){
      const keys=['password','passwd','token','api[_-]?key','secret','authorization','cookie','device[\\w-]*','serial[\\w-]*','sn','imei','imsi','iccid','vin','signal[\\w-]*','rssi','rsrp','rsrq','sinr',...extra];
      pattern=new RegExp('\\b('+keys.join('|')+')(["\\\']?)\\s*([=:])\\s*','gi');
      if(patternCache.size>=32)patternCache.clear();
      patternCache.set(key,pattern);
    }
    pattern.lastIndex=0;
    return pattern;
  }
  function redact(value,extraFields=[]) {
    let text=String(value).replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'<IP>')
      .replace(/\b(?:[\da-f]{2}:){5}[\da-f]{2}\b/gi,'<MAC>')
      .replace(/\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi,'$1<REDACTED>@');
    const extra=Array.isArray(extraFields)?extraFields.filter(x=>typeof x==='string'&&/^\w+$/.test(x)).slice(0,50):[];
    const pattern=redactPattern(extra);
    let out='',cursor=0,match;
    while((match=pattern.exec(text))){
      const start=pattern.lastIndex;let end=start,quote='',depth=0,escaped=false;
      if(text[start]==='"'||text[start]==="'"){
        quote=text[start];end=start+1;
        for(;end<text.length;end++){const c=text[end];if(escaped){escaped=false;continue}if(c==='\\'){escaped=true;continue}if(c===quote){end++;break}}
      }else if(text[start]==='{'||text[start]==='['){
        for(end=start;end<text.length;end++){const c=text[end];if(quote){if(escaped){escaped=false;continue}if(c==='\\'){escaped=true;continue}if(c===quote)quote='';continue}if(c==='"'||c==="'"){quote=c;continue}if(c==='{'||c==='[')depth++;if(c==='}'||c===']'){depth--;if(depth===0){end++;break}}}
      }else while(end<text.length&&!/[\s,;}\]]/.test(text[end]))end++;
      if(end===start)continue;
      out+=text.slice(cursor,start)+(match[2]?'"<REDACTED>"':'<REDACTED>');cursor=end;pattern.lastIndex=end;
    }
    return (out+text.slice(cursor)).replace(/\bBearer\s+[^\s"',;}]+/gi,'Bearer <TOKEN>');
  }
  // A single line can be megabytes long (a hex dump, a base64 blob, a device spewing
  // without newlines). Every stage here — JSON/logfmt/CSV scans, the level and time
  // regexes, classification and redaction — is O(n) over the full text, so one such line
  // used to stall the UI thread for seconds. Analysis now runs on a bounded head+tail
  // window while `text` keeps the whole line for display and raw export. The window
  // covers where structure actually lives (line start) and where a dump usually ends
  // (error tail); `truncated` tells the caller the middle was not analysed.
  const ANALYSIS_WINDOW=65536;
  function analysisWindow(text){
    if(text.length<=ANALYSIS_WINDOW)return text;
    const half=ANALYSIS_WINDOW>>1;
    return text.slice(0,half)+'\n…\n'+text.slice(text.length-half);
  }
  function parse(text, receipt) {
    text=String(text);let fields={},format='text';
    const huge=text.length>ANALYSIS_WINDOW,scan=huge?analysisWindow(text):text;
    // JSON.parse on every line was half the import cost: a failed parse throws, and the
    // thrower dominates 2s of a 300k-line file. Only an object can become `fields` (an
    // array or a scalar leaves format='text'), so a line that does not open with '{'
    // cannot change the outcome — skip the attempt entirely.
    if(scan.charCodeAt(0)===123||/^\s*\{/.test(scan)){
      try{const v=JSON.parse(scan);if(v&&typeof v==='object'&&!Array.isArray(v)){fields=v;format='json';}}catch{}
    }
    if(format==='text'){
      logfmtFields(scan,fields);
      if(Object.keys(fields).length)format='logfmt';
    }
    if(format==='text'){
      const sys=/^(?:<(\d+)>)?([A-Z][a-z]{2}\s+\d{1,2}\s+\d\d:\d\d:\d\d)\s+(\S+)\s+([^:\[]+)(?:\[(\d+)\])?:\s*(.*)$/.exec(scan);
      if(sys){format='syslog';fields={timestamp:sys[2],host:sys[3],module:sys[4],pid:sys[5],message:sys[6]};if(sys[1])fields.level=['ERROR','ERROR','ERROR','ERROR','WARN','INFO','INFO','DEBUG'][Number(sys[1])%8];}
      else if(scan.includes(',')){const columns=[];let cell='',quoted=false;for(let i=0;i<scan.length;i++){const c=scan[i];if(c==='"'){if(quoted&&scan[i+1]==='"'){cell+='"';i++}else quoted=!quoted}else if(c===','&&!quoted){columns.push(cell);cell=''}else cell+=c;}columns.push(cell);if(!quoted&&columns.length>1){format='csv';fields=Object.fromEntries(columns.map((value,i)=>['col'+(i+1),value]));}}
    }
    let level=String(fields.level||fields.severity||((scan.match(/\b(ERROR|FATAL|CRITICAL|EXCEPTION|TRACEBACK|WARN(?:ING)?|WARING|INFO|DEBUG|TRACE)\b/i)||[])[1])||'INFO').toUpperCase();
    if(/FATAL|CRITICAL|EXCEPTION|TRACEBACK/.test(level))level='ERROR';
    if(level==='WARNING'||level==='WARING')level='WARN';
    const time=fields.timestamp||fields.time||(scan.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/)||[])[0]||receipt||'';
    // A line that carries no severity of its own can still be a device event — a reboot, a
    // watchdog bite, a brown-out. Classify every line, not just the unlabelled ones: a device
    // that prints a watchdog bite at WARN still lost its watchdog, so a fault may raise the level.
    // It never lowers one the device stated, and an inferred "warn" finding (a timeout, a missing
    // answer) never raises anything — otherwise every INFO line mentioning a timeout would land in
    // the WARN filter. main.cpp's promotes() keeps the fault half of this rule.
    const event=classify(scan);
    if(event&&event.severity!=='warn'&&(event.level==='ERROR'||['INFO','DEBUG','TRACE'].includes(level)))level=event.level;
    const row={text,time,level,fields,format,redacted:redact(scan),event:event||undefined};
    if(huge)row.truncated=true;
    return row;
  }
  // Device lifecycle is part of the analysis, not a footnote. A reboot, a watchdog bite or a
  // brown-out is what an engineer opens the log to find, and none of them is spelled ERROR, so
  // the table carries a category and a severity instead of one flat "looks severe". Order is
  // priority: the specific lifecycle rules first, the generic severity rule last. main.cpp keeps
  // the same table so a line is classified the same live and after import.
  const RULES=[
    [/watchdog|\bwdt\b|watch dog|feed(?:ing)? the dog|\biwdg\b|\bwwdg\b/i,'看门狗','critical','看门狗触发：核对喂狗任务是否被阻塞、复位原因寄存器与复位计数'],
    [/\bpanic\b|kernel oops|hard ?fault|segmentation fault|\bsegfault\b|stack overflow|assert(?:ion)? (?:failed|failure)|\babort(?:ed)?\b|double free|core dump|unhandled exception/i,'异常复位','critical','固件异常复位：保留复位前后日志，核对调用栈与断言位置'],
    [/brown ?out|under ?voltage|low voltage|power(?: supply)? (?:fail|loss)|power loss|\bvbat\b|voltage (?:drop|dip|below)/i,'掉电欠压','critical','供电异常：检查掉电/欠压阈值、电源纹波与线束接触'],
    [/\breboot(?:ed|ing)?\b|\brestart(?:ed|ing)?\b|system reset|software reset|hard reset|reset (?:reason|cause|source|by)|power[ -]?on|power[ -]?up|booting up|\bbooted\b/i,'设备重启','event','设备重启：记录重启时刻与复位原因，并核对重启前后的日志中断时间'],
    [/out of memory|\boom\b|heap exhausted|alloc(?:ation)? fail(?:ed|ure)?|memory leak/i,'内存不足','critical','内存不足：检查内存水位、泄漏和容器限制'],
    [/no space left|disk full|read-only file system|bad block|\bfsck\b|mount (?:fail|error)|(?:sd ?card|emmc|nand|flash)[^.]{0,24}(?:error|fail|timeout|full|corrupt)/i,'存储异常','error','存储异常：检查剩余空间、坏块与文件系统挂载'],
    [/link (?:down|up)|carrier lost|disconnect(?:ed|ing)?|reconnect(?:ed|ing)?|connection (?:lost|reset)|bus ?off|\bcan ?bus\b/i,'链路变化','event','通信链路变化：核对断开与恢复时刻、对端状态和线束'],
    [/\bota\b|firmware|bootloader|flash (?:write|erase|error)|upgrade|downgrade/i,'固件升级','event','固件与升级：确认版本、升级结果以及是否发生回滚'],
    [/over ?temp|thermal|throttl|temperature .{0,20}(?:high|critical)/i,'温度','error','温度异常：检查散热、风扇与降频策略'],
    [/timeout|timed out|no response/i,'超时','warn','请求超时：检查下游可用性、网络延迟与连接池'],
    [/connection refused/i,'连接被拒绝','error','连接被拒绝：确认目标服务监听、防火墙和服务状态'],
    [/permission denied|access denied|authentication fail/i,'权限','error','权限失败：检查账号、资源权限与凭据'],
    [/\b(ERROR|FATAL|CRITICAL|EXCEPTION|TRACEBACK)\b/i,'严重异常','error','严重异常：请结合前后日志和调用链排查']
  ];
  function levelOf(severity){return severity==='critical'||severity==='error'?'ERROR':severity==='warn'?'WARN':'EVENT'}
  // Linear logfmt scan with the exact semantics of the old
  // /([A-Za-z_][\w.-]*)=("(?:\\.|[^"])*"|'[^']*'|[^\s]+)/g matchAll loop. That loop was
  // quadratic on a long token without '=' (hex dump, base64 blob): the key run backtracked
  // at every suffix of every start position — ~0.8s for one 64KB window. Here each '=' is
  // found once with indexOf, the key is the [\w.-] run before it (trimmed to a valid
  // [A-Za-z_] start, like the regex's leftmost match), and the value alternatives are
  // unchanged and consumed with a sticky regex so '=' inside a quoted value stays inside.
  const LOGFMT_VALUE=/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/y,LOGFMT_KEY_CHAR=/[\w.-]/,LOGFMT_KEY_START=/[A-Za-z_]/;
  function logfmtFields(scan,fields){
    let cursor=0;
    for(;;){
      const eq=scan.indexOf('=',cursor);
      if(eq<0)return;
      let start=eq;
      while(start>cursor&&LOGFMT_KEY_CHAR.test(scan[start-1]))start--;
      while(start<eq&&!LOGFMT_KEY_START.test(scan[start]))start++;
      if(start>=eq){cursor=eq+1;continue}
      LOGFMT_VALUE.lastIndex=eq+1;
      const m=LOGFMT_VALUE.exec(scan);
      if(!m){cursor=eq+1;continue}
      fields[scan.slice(start,eq)]=m[0].replace(/^["']|["']$/g,'');
      cursor=LOGFMT_VALUE.lastIndex;
    }
  }
  const LIFECYCLE=new Set(['看门狗','异常复位','掉电欠压','设备重启','链路变化','固件升级','温度']);
  function classify(text){for(const [re,category,severity,advice] of RULES)if(re.test(text))return {category,severity,level:levelOf(severity),advice};return null}
  function diagnose(row){
    // Same bound as parse(): the full text may be a megabyte-sized dump.
    const s=analysisWindow(row.text);
    // A lifecycle category (a reboot, a watchdog bite, a brown-out) outranks both the generic
    // "this line looks severe" wording and the older single-symptom wording below: it is what
    // an engineer opens the log to find, and "watchdog timeout" is not a latency problem.
    const found=classify(s);
    if(found&&LIFECYCLE.has(found.category))return found.advice;
    if(/out of memory|\boom\b/i.test(s))return 'Memory exhausted: inspect heap, allocation rate and limits.';
    if(/timeout|timed out/i.test(s))return 'Timeout: inspect latency, downstream health and retry settings.';
    if(/connection refused/i.test(s))return 'Connection refused: inspect listener, port and firewall.';
    if(/permission denied|access denied/i.test(s))return 'Permission failure: inspect account, resource permissions and credentials.';
    if(/no space left|disk full/i.test(s))return 'Disk full: inspect free space, retention and rotation.';
    if(row.level==='WARN')return 'Warning detected: inspect nearby events, retry counts and device state.';
    return row.level==='ERROR'?'Error detected: inspect surrounding logs and related sessions.':'';
  }
  function summarize(rows){
    const levels={},modules={},minutes={};
    for(const r of rows){levels[r.level]=(levels[r.level]||0)+1;const module=String(r.fields?.module||r.fields?.logger||r.fields?.tag||'unknown');modules[module]=(modules[module]||0)+1;const t=String(r.time).slice(0,16);minutes[t]=(minutes[t]||0)+1;}
    return {count:rows.length,levels,modules,minutes};
  }
  function isContinuation(text){return /^\s+at\s|^\s+File\s|^Caused by:|^\s+\.\.\. \d+ more/.test(text)}
  // Comparing two logs by Set membership lost both the row order and the duplicate counts:
  // a line printed three times on one side and never on the other showed up once, and a
  // changed line always read as one removal plus one unrelated addition. Counting
  // occurrences per side and walking each side in its original order keeps both, and the
  // surplus count says how many times a line is actually missing.
  function countLines(rows){
    const counts=new Map();
    for(const row of rows){const text=typeof row==='string'?row:String(row?.text??row);counts.set(text,(counts.get(text)||0)+1)}
    return counts;
  }
  function compareLines(leftRows,rightRows,{limit=200}={}){
    const left=countLines(leftRows),right=countLines(rightRows);
    // A line on both sides can still be missing occurrences: 3× on the left against 1× on
    // the right is 2 missing lines, not a match. Only the surplus is reported, and only
    // when it is positive, so an equal count stays silent.
    const walk=(source,other)=>{
      const surplus=new Map();
      for(const [text,count] of source){
        const mine=count-(other.get(text)||0);
        if(mine>0)surplus.set(text,mine);
      }
      const rows=[];let occurrences=0;
      for(const [text,count] of surplus){occurrences+=count;if(rows.length<limit)rows.push({text,count})}
      return {rows,total:surplus.size,occurrences};
    };
    const onlyLeft=walk(left,right),onlyRight=walk(right,left);
    let shared=0;for(const [text] of left)if(right.has(text))shared++;
    return {onlyLeft,onlyRight,shared,leftLines:leftRows.length,rightLines:rightRows.length};
  }
  // Fixed-width so a scrollback line cannot be mistaken for a count column.
  function formatCompare(result,labels={}){
    const {onlyLeft,onlyRight}=result,out=[];
    const noun=labels.unit||'distinct line(s)';
    out.push((labels.left||'Only in A')+': '+onlyLeft.total+' '+noun+', '+onlyLeft.occurrences+' missing occurrence(s)');
    for(const item of onlyLeft.rows)out.push('  ×'+String(item.count).padStart(4)+'  '+item.text);
    if(onlyLeft.total>onlyLeft.rows.length)out.push('  … '+(onlyLeft.total-onlyLeft.rows.length)+' more not shown');
    out.push('');
    out.push((labels.right||'Only in B')+': '+onlyRight.total+' '+noun+', '+onlyRight.occurrences+' missing occurrence(s)');
    for(const item of onlyRight.rows)out.push('  ×'+String(item.count).padStart(4)+'  '+item.text);
    if(onlyRight.total>onlyRight.rows.length)out.push('  … '+(onlyRight.total-onlyRight.rows.length)+' more not shown');
    return out.join('\n');
  }
  function merge(rows){
    const out=[];
    for(const row of rows){
      if(out.length&&isContinuation(row.text)){const r=out[out.length-1];r.text=(r.text+'\n'+row.text).slice(-ANALYSIS_WINDOW);r.redacted=redact(analysisWindow(r.text));}
      else out.push({...row});
    }
    return out;
  }
  function ansi(text){
    const colors=['#15191d','#e76b6b','#6bbf81','#dbbd62','#75a7ef','#be8be0','#70c4c4','#ddd'];let fg='',bold=false,result='',at=0;
    const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const part=s=>'<span style="'+(fg?'color:'+fg+';':'')+(bold?'font-weight:bold;':'')+'">'+escape(s)+'</span>';
    for(const m of text.matchAll(/\x1b\[([0-9;]*)m/g)){result+=part(text.slice(at,m.index));for(const c of (m[1]||'0').split(';').map(Number)){if(c===0){fg='';bold=false}else if(c===1)bold=true;else if(c===22)bold=false;else if(c===39)fg='';else if(c>=30&&c<=37)fg=colors[c-30];else if(c>=90&&c<=97)fg=colors[c-90]}at=m.index+m[0].length;}return result+part(text.slice(at));
  }
  // -----------------------------------------------------------------------------------------------
  // Clustering, timeline, trend and ranked causes.
  //
  // These are the four things "it only locates a line" was missing: which anomaly this is and how
  // often it happened, when the device did something and when it stopped talking at all, whether the
  // rate is climbing or bursty, and which causes are worth acting on first. All of them are pure
  // functions of the rows, so they can be asserted without Electron — and all of them are heuristics
  // over text, not causal analysis, which the report says out loud.
  // -----------------------------------------------------------------------------------------------

  // The one normaliser in the workspace. `workstation.js` delegates to this instead of keeping its
  // own copy: two normalisers that drift apart would split one anomaly into two groups depending on
  // which panel happened to look at it.
  function signature(row){
    // Cap before redacting: signature only keeps 400 chars anyway, and a huge line must
    // not run the redactor over its full length once per clustering pass.
    return String(row.level)+'|'+redact(analysisWindow(String(row.text)))
      .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.+Z-]+/g,'<time>')
      .replace(/\b(?:0x[\da-f]+|\d+)\b/gi,'#')
      .slice(0,400);
  }

  const SEVERITY_WEIGHT={critical:4,error:3,warn:2,event:1};
  // Why a category usually happens. Paired with the rule's advice, this is the "cause → action" half
  // of the ranked list; the four steps it must not take are guessing, so an unmatched anomaly is
  // reported as unmatched rather than being pushed into the nearest bucket.
  const CAUSES={
    '看门狗':'喂狗任务被长时间阻塞（长临界区、死循环、优先级反转）或看门狗超时配置过紧',
    '异常复位':'固件缺陷：空指针、栈溢出、断言失败或未捕获异常导致任务或内核崩溃',
    '掉电欠压':'供电跌落：线束接触、电源纹波、电池电量或负载瞬变超出稳压范围',
    '设备重启':'主动或被动重启：复位请求、看门狗、掉电，或升级后的重启',
    '内存不足':'内存泄漏，或分配峰值超出堆上限',
    '存储异常':'存储介质故障、写满或文件系统损坏',
    '链路变化':'物理链路或对端状态变化：线缆、接口、交换机端口、对端服务',
    '固件升级':'升级过程失败或版本不匹配',
    '温度':'散热不足，或环境温度超出设计范围',
    '超时':'下游响应慢或不可达、网络抖动、连接池耗尽',
    '连接被拒绝':'目标未监听、端口错误或防火墙拦截',
    '权限':'账号或凭据无权限、证书过期',
    '严重异常':'需要结合前后日志与调用链定位',
    '未分类':'未命中已知规则，需要人工判读（这不代表设备正常）'
  };

  // -----------------------------------------------------------------------------------------------
  // 诊断文案的英文对照表。
  //
  // 为什么必须放在这里而不是放到 diagnostic-locale.js：类别、建议和原因是从 RULES/CAUSES 直接流进
  // 报告对象的，而报告对象同时喂给右侧面板、Markdown、HTML 和 PDF 四条导出路径。只在渲染层翻译，
  // 就会变成"面板是英文、导出还是中文"——同一份数据四条出口说法不一致，正是这份代码一直在避免的事。
  // 所以翻译跟着数据走：`buildReport(rows,{lang})` 一次翻完，下游谁都不用再管。
  //
  // 三个表都以中文原文为键，因为中文是 RULES/CAUSES 里的唯一真值，也是 hybrid/core/main.cpp 里
  // 同一张表发给 UI 的东西。键对不上时翻译函数原样返回中文——宁可露出中文，也不要凭空造一个
  // 对不上的英文标签，那会让"这条结论对应哪条规则"无法回溯。
  const CATEGORY_EN={
    '看门狗':'Watchdog','异常复位':'Fault reset','掉电欠压':'Brown-out','设备重启':'Device reboot',
    '内存不足':'Out of memory','存储异常':'Storage fault','链路变化':'Link change','固件升级':'Firmware update',
    '温度':'Temperature','超时':'Timeout','连接被拒绝':'Connection refused','权限':'Permission','严重异常':'Severe fault','未分类':'Uncategorised'
  };
  const ADVICE_EN={
    '看门狗触发：核对喂狗任务是否被阻塞、复位原因寄存器与复位计数':'Watchdog fired: check whether the feed task is blocked, plus the reset-reason register and reset count',
    '固件异常复位：保留复位前后日志，核对调用栈与断言位置':'Firmware fault reset: keep the logs from before and after, and check the call stack and the assertion site',
    '供电异常：检查掉电/欠压阈值、电源纹波与线束接触':'Supply fault: check the brown-out threshold, supply ripple and harness contact',
    '设备重启：记录重启时刻与复位原因，并核对重启前后的日志中断时间':'Device reboot: record the time and the reset reason, and compare the log gap around the reboot',
    '内存不足：检查内存水位、泄漏和容器限制':'Out of memory: check the memory watermark, leaks and any container limit',
    '存储异常：检查剩余空间、坏块与文件系统挂载':'Storage fault: check free space, bad blocks and the filesystem mount',
    '通信链路变化：核对断开与恢复时刻、对端状态和线束':'Link change: check when it dropped and recovered, the peer state and the cabling',
    '固件与升级：确认版本、升级结果以及是否发生回滚':'Firmware and upgrade: confirm the version, the upgrade result and whether a rollback happened',
    '温度异常：检查散热、风扇与降频策略':'Temperature fault: check cooling, fans and the throttling policy',
    '请求超时：检查下游可用性、网络延迟与连接池':'Request timed out: check downstream availability, network latency and the connection pool',
    '连接被拒绝：确认目标服务监听、防火墙和服务状态':'Connection refused: confirm the listener, the firewall and the target service state',
    '权限失败：检查账号、资源权限与凭据':'Permission failure: check the account, the resource permissions and the credentials',
    '严重异常：请结合前后日志和调用链排查':'Severe fault: investigate with the surrounding logs and the call chain'
  };
  const CAUSES_EN={
    '喂狗任务被长时间阻塞（长临界区、死循环、优先级反转）或看门狗超时配置过紧':'The feed task was blocked for too long (long critical section, infinite loop, priority inversion), or the watchdog timeout is configured too tight',
    '固件缺陷：空指针、栈溢出、断言失败或未捕获异常导致任务或内核崩溃':'A firmware defect: a null pointer, stack overflow, failed assertion or unhandled exception took down a task or the kernel',
    '供电跌落：线束接触、电源纹波、电池电量或负载瞬变超出稳压范围':'A supply droop: harness contact, supply ripple, battery level or a load transient left the regulator range',
    '主动或被动重启：复位请求、看门狗、掉电，或升级后的重启':'A deliberate or forced restart: a reset request, the watchdog, a brown-out, or a reboot after an upgrade',
    '内存泄漏，或分配峰值超出堆上限':'A memory leak, or an allocation peak above the heap limit',
    '存储介质故障、写满或文件系统损坏':'A failing medium, a full volume, or a corrupt filesystem',
    '物理链路或对端状态变化：线缆、接口、交换机端口、对端服务':'A physical link or peer state change: cable, connector, switch port, or the peer service',
    '升级过程失败或版本不匹配':'The upgrade failed, or the versions do not match',
    '散热不足，或环境温度超出设计范围':'Insufficient cooling, or an ambient temperature outside the design range',
    '下游响应慢或不可达、网络抖动、连接池耗尽':'A slow or unreachable downstream, network jitter, or an exhausted connection pool',
    '目标未监听、端口错误或防火墙拦截':'Nothing listening, the wrong port, or a firewall rule',
    '账号或凭据无权限、证书过期':'The account or credential lacks permission, or a certificate expired',
    '需要结合前后日志与调用链定位':'Needs the surrounding logs and the call chain to locate',
    '未命中已知规则，需要人工判读（这不代表设备正常）':'No known rule matched; a human has to read it (this does not mean the device is healthy)'
  };
  // en 为假时原样返回：这条路径必须对默认的中文零影响，翻译表只在导出或切到英文时才被读到。
  // 三个表共用一次查表，因为「类别」「建议」「原因」在数据里以不同的键出现，而它们互不重名。
  function diagnostic(en,value){return en?(CATEGORY_EN[value]||ADVICE_EN[value]||CAUSES_EN[value]||value):value}
  // 反查表：英文 → 中文。报告对象在英文模式下流出去之后，右侧面板仍要把 diagnose() 的中文建议
  // 翻成英文；反过来，英文兜底句（diagnose 里那七条）在中文界面里也要落到中文。
  // 一张反查表放在这里，是为了让两个方向共用同一份词表——分开维护必然漂移。
  const REVERSE_EN={};
  for(const table of [CATEGORY_EN,ADVICE_EN,CAUSES_EN])for(const [zh,en] of Object.entries(table))REVERSE_EN[en]=zh;
  function translateDiagnostic(value,lang){return String(lang||'').toLowerCase()==='en'?diagnostic(true,value):(REVERSE_EN[value]||value)}

  // 报告对象的翻译在这一个地方做完，而不是散到四个渲染器里。
  //
  // 关键取舍：内部分析（聚类、分桶、按类别归并、查 CAUSES）全程用中文类别名，因为那是 RULES 和
  // hybrid/core/main.cpp 里同一张表的真值，也是 analysis.test.cjs 断言的键。翻译只发生在结果离开
  // 分析层之前——这样聚类不会因为语言不同而分裂，CAUSES 的查表也永远命中，而四条出口拿到的是同一
  // 份已经本地化的数据。代价是报告对象本身不再"原样"，所以它只在 buildReport 的返回值上存在。
  function localizeReport(report,en){
   if(!en)return report;
   const category=value=>diagnostic(true,value);
   return {
    ...report,
    clusters:report.clusters.map(cluster=>({...cluster,category:cluster.category?category(cluster.category):cluster.category,advice:cluster.advice||''})),
    timeline:{...report.timeline,events:report.timeline.events.map(event=>({...event,category:category(event.category)})),gaps:report.timeline.gaps.map(gap=>({...gap,explainedBy:gap.explainedBy?category(gap.explainedBy):gap.explainedBy}))},
    ranked:report.ranked.map(item=>({...item,category:category(item.category),cause:diagnostic(true,item.cause),action:diagnostic(true,item.action)}))
   };
  }

  function medianOf(values){
    if(!values.length)return 0;
    const sorted=[...values].sort((a,b)=>a-b),mid=sorted.length>>1;
    return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
  }
  function moduleOf(row){return String(row.fields?.module||row.fields?.logger||row.fields?.tag||'—')}
  function sampleOf(row){return (row.redacted||redact(row.text)).slice(0,200)}

  // Same class of message, counted once. The key is the normaliser above, so a line that differs only
  // in its timestamp, its address or its byte count lands in the same group as its siblings — which is
  // the whole point: one error that repeats 400 times is one finding, not 400.
  function clusterSignatures(rows,options={}){
    const levels=options.levels||['ERROR','WARN','EVENT'],limit=Math.max(1,options.limit||50);
    const groups=new Map();
    for(const row of rows){
      if(!levels.includes(row.level)&&!row.event)continue;
      const key=signature(row);
      let group=groups.get(key);
      if(!group){
        group={key,level:row.level,category:row.event?.category||'',severity:row.event?.severity||'',count:0,first:row.time||'',last:row.time||'',sample:sampleOf(row),modules:[],rows:[]};
        groups.set(key,group);
      }
      group.count++;
      // Buffers are appended in arrival order, but an imported file or a re-read recovery point is not
      // guaranteed to be sorted, so first/last are a comparison rather than a position.
      if(row.time&&(!group.first||String(row.time)<String(group.first)))group.first=row.time;
      if(row.time&&(!group.last||String(row.time)>String(group.last)))group.last=row.time;
      if(!group.advice)group.advice=row.event?.advice||row.analysis||'';
      const module=moduleOf(row);
      if(!group.modules.includes(module)&&group.modules.length<8)group.modules.push(module);
      if(group.rows.length<50)group.rows.push(row);
    }
    return [...groups.values()].sort((a,b)=>b.count-a.count||String(b.last).localeCompare(String(a.last))).slice(0,limit);
  }

  function rowTime(row){const ms=Date.parse(String(row.time||''));return Number.isFinite(ms)?ms:null}

  // What the device did (from the same category table the core uses) and when it went quiet. A gap is
  // measured against the median interval of this log rather than a fixed number of seconds, because
  // "silent for 30 s" means opposite things in a 10 Hz telemetry stream and a once-a-minute poller.
  function timeline(rows,options={}){
    const gapFactor=Math.max(2,options.gapFactor||4),minGapMs=Math.max(1000,options.minGapMs||30000);
    const events=[],timed=[],deltas=[];
    for(let index=0;index<rows.length;index++){
      const row=rows[index];
      if(row.event&&row.event.category)events.push({time:row.time||'',category:row.event.category,severity:row.event.severity||'',message:sampleOf(row),index});
      const ms=rowTime(row);
      if(ms===null)continue;
      if(timed.length){const delta=ms-timed[timed.length-1].ms;if(delta>0)deltas.push(delta)}
      timed.push({ms,index});
    }
    const medianMs=medianOf(deltas),thresholdMs=Math.max(minGapMs,medianMs*gapFactor),gaps=[];
    for(let i=1;i<timed.length;i++){
      const delta=timed[i].ms-timed[i-1].ms;
      if(delta<=thresholdMs)continue;
      // The rows inside the window, and the row that ends it, are what turns "there is a hole here"
      // into "and here is why": the line the log resumes with is very often the reboot or the
      // watchdog bite that caused the silence, so it belongs in the window rather than just outside it.
      const between=rows.slice(timed[i-1].index+1,timed[i].index+1);
      const explains=between.find(row=>row.event&&LIFECYCLE.has(row.event.category));
      gaps.push({from:rows[timed[i-1].index].time||'',to:rows[timed[i].index].time||'',ms:Math.round(delta),seconds:Math.round(delta/1000),explainedBy:explains?explains.event.category:'',rows:between.length});
    }
    return {events,gaps,medianMs:Math.round(medianMs),thresholdMs:Math.round(thresholdMs),timedRows:timed.length,untimedRows:rows.length-timed.length};
  }

  // Per-minute counts and the buckets that stand out.
  //
  // The burst test uses the median and the median absolute deviation, not the mean and the standard
  // deviation. The spike being tested is part of the series it is tested against, so a mean-and-σ
  // threshold is dragged upward by exactly the bucket it is meant to catch — and it is worse than
  // merely conservative: no point in an n-sample set can sit more than (n-1)/√n σ from its own mean,
  // so below nine buckets a 3σ rule can never fire at all. The median ignores the spike, and the MAD
  // is the scale that goes with it. "Bursty" is still only claimed once there are enough buckets to
  // have a shape at all — with three buckets the tallest is always an outlier, and calling that a
  // burst would be arithmetic rather than evidence.
  function trend(rows,options={}){
    const bucketMs=Math.max(1000,options.bucketMs||60000),buckets=new Map();
    let skipped=0;
    for(const row of rows){
      const key=String(row.time||'').slice(0,16);
      if(!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d$/.test(key)){skipped++;continue}
      let bucket=buckets.get(key);
      if(!bucket){bucket={bucket:key,counts:{},total:0};buckets.set(key,bucket)}
      bucket.counts[row.level]=(bucket.counts[row.level]||0)+1;bucket.total++;
    }
    const series=[...buckets.values()].sort((a,b)=>a.bucket.localeCompare(b.bucket)),totals=series.map(x=>x.total);
    const mean=totals.length?totals.reduce((a,b)=>a+b,0)/totals.length:0;
    const stdev=totals.length?Math.sqrt(totals.reduce((a,b)=>a+(b-mean)**2,0)/totals.length):0;
    const median=medianOf(totals),deviation=medianOf(totals.map(total=>Math.abs(total-median)));
    // A flat series has a MAD of zero, which would make any bucket holding one row more than the
    // median a "burst"; the fallback keeps the bar at twice the median instead.
    const threshold=deviation>0?median+3*deviation*1.4826:Math.max(median*2,median+1);
    const bursts=series.length>=8?series.filter(x=>x.total>threshold).map(x=>({bucket:x.bucket,total:x.total,ratio:Number((x.total/(median||1)).toFixed(1)),counts:x.counts})):[];
    const busiest=series.reduce((best,x)=>!best||x.total>best.total?x:best,null);
    return {bucketMs,series,mean:Number(mean.toFixed(2)),stdev:Number(stdev.toFixed(2)),median:Number(median.toFixed(2)),threshold:Number(threshold.toFixed(2)),bursts,busiest,buckets:series.length,skipped};
  }

  // The order to work in. Risk is a written-down formula rather than a verdict, so it can be argued
  // with instead of trusted:
  //   severity (critical 4 / error 3 / warn 2 / event 1)
  // × volume   (1 + log10 count)              — the tenth repeat matters, the hundredth does not
  // × spread   (1 + log10(span in minutes+1)/2) — every ten minutes for an hour is worse than a burst
  // with one floor: a critical event is never rated low, because a single brown-out or watchdog bite
  // is already a finding even if it never repeats. 12 and up is high, 6 and up medium, below that low.
  // Evidence first, then cause, then action: a ranking that cannot be checked against the rows is just
  // an opinion with a number on it.
  function rank(rows,options={}){
    const limit=Math.max(1,options.limit||10);
    const groups=new Map();
    for(const cluster of clusterSignatures(rows,{limit:500,levels:options.levels||['ERROR','WARN','EVENT']})){
      const category=cluster.category||'未分类',weight=SEVERITY_WEIGHT[cluster.severity]||(cluster.level==='ERROR'?3:cluster.level==='WARN'?2:1);
      let group=groups.get(category);
      if(!group){
        group={category,severity:cluster.severity||'',count:0,signatures:0,first:cluster.first,last:cluster.last,modules:[],evidence:[],weight,action:cluster.advice||'',cause:CAUSES[category]||''};
        groups.set(category,group);
      }
      group.count+=cluster.count;group.signatures++;
      if(cluster.first&&(!group.first||String(cluster.first)<String(group.first)))group.first=cluster.first;
      if(cluster.last&&(!group.last||String(cluster.last)>String(group.last)))group.last=cluster.last;
      for(const module of cluster.modules)if(!group.modules.includes(module)&&group.modules.length<8)group.modules.push(module);
      if(group.evidence.length<5&&!group.evidence.includes(cluster.sample))group.evidence.push(cluster.sample);
      if(cluster.severity&&(SEVERITY_WEIGHT[cluster.severity]||0)>weight){group.weight=SEVERITY_WEIGHT[cluster.severity];group.severity=cluster.severity}
      if(!group.action&&cluster.advice)group.action=cluster.advice;
    }
    const ranked=[...groups.values()].map(group=>{
      const from=Date.parse(String(group.first||'')),to=Date.parse(String(group.last||''));
      const spanMinutes=Number.isFinite(from)&&Number.isFinite(to)?Math.max(0,(to-from)/60000):0;
      const floor=group.weight>=4?6:group.weight>=3?3:0;
      const score=Math.max(floor,group.weight*(1+Math.log10(Math.max(1,group.count)))*(1+Math.log10(spanMinutes+1)/2));
      return {...group,spanMinutes:Number(spanMinutes.toFixed(1)),score:Number(score.toFixed(2)),risk:score>=12?'高':score>=6?'中':'低',riskLabel:score>=12?'high':score>=6?'medium':'low',advice:group.action||CAUSES[group.category]||''};
    }).sort((a,b)=>b.score-a.score||b.count-a.count);
    return ranked.slice(0,limit).map((group,index)=>({rank:index+1,...group}));
  }

  function buildReport(rows,options={}){
    const now=options.now||new Date().toISOString();
    // options.lang 决定报告的"数据语言"：'en' 时类别/原因/建议在离开分析层之前就被换成英文。默认不传
    // 就是中文，和以前完全一致——这条路径上有 22 个测试和 hybrid/core/main.cpp 的同类表在依赖它。
    return localizeReport({
      generatedAt:now,
      session:options.session||'',
      count:rows.length,
      summary:summarize(rows),
      clusters:clusterSignatures(rows,{limit:options.clusterLimit||20}),
      timeline:timeline(rows,options),
      trend:trend(rows,options),
      ranked:rank(rows,{limit:options.rankLimit||10}),
      // Stated in the report and not only in the docs: every number here comes from matching text
      // against rules. It finds candidates and orders them; it does not prove a cause.
      heuristic:true
    },/^en/i.test(String(options.lang||'')));
  }

  // One report, rendered once, shared by the Markdown export, the HTML export and the PDF export. The
  // three used to build their own strings from the same rows, which is how a report ends up saying
  // three different things depending on which button produced it.
  function renderReportMarkdown(report,options={}){
    const en=options.lang==='en',L=(zh,text)=>en?text:zh;
    const cell=value=>String(value??'').replace(/\|/g,'\\|').replace(/\r?\n/g,' ⏎ ').slice(0,300);
    const lines=[];
    lines.push('# '+L('LogScope 诊断报告','LogScope Diagnostic Report'),'');
    lines.push('- '+L('生成时间：','Generated: ')+report.generatedAt);
    if(report.session)lines.push('- '+L('会话：','Session: ')+cell(report.session));
    lines.push('- '+L('分析行数：','Rows analyzed: ')+report.count);
    lines.push('- '+L('级别统计：','Levels: ')+(Object.entries(report.summary.levels).map(([k,v])=>k+' '+v).join(' · ')||'—'),'');
    lines.push('## 1. '+L('异常签名聚类','Anomaly signatures'),'');
    if(!report.clusters.length)lines.push(L('未命中异常签名。','No anomaly signature matched.'),'');
    else{
      lines.push('| '+L('次数','Count')+' | '+L('级别','Level')+' | '+L('类别','Category')+' | '+L('首次','First')+' | '+L('最近','Last')+' | '+L('模块','Modules')+' | '+L('样例','Sample')+' |');
      lines.push('| ---: | --- | --- | --- | --- | --- | --- |');
      for(const cluster of report.clusters)lines.push(`| ${cluster.count} | ${cell(cluster.level)} | ${cell(cluster.category||'—')} | ${cell(cluster.first||'—')} | ${cell(cluster.last||'—')} | ${cell(cluster.modules.join(', ')||'—')} | ${cell(cluster.sample)} |`);
      lines.push('');
    }
    lines.push('## 2. '+L('生命周期与日志中断','Lifecycle and log gaps'),'');
    if(!report.timeline.events.length)lines.push(L('未发现设备生命周期事件。','No device lifecycle event found.'),'');
    else{
      lines.push('| '+L('时间','Time')+' | '+L('类别','Category')+' | '+L('级别','Severity')+' | '+L('内容','Message')+' |');
      lines.push('| --- | --- | --- | --- |');
      for(const event of report.timeline.events.slice(0,50))lines.push(`| ${cell(event.time||'—')} | ${cell(event.category)} | ${cell(event.severity||'—')} | ${cell(event.message)} |`);
      lines.push('');
    }
    if(report.timeline.gaps.length){
      lines.push(L('日志中断（大于本日志的正常间隔中位数 × 4，且不短于 30 秒）：','Log gaps (longer than 4× the median interval of this log, and at least 30 s):'),'');
      for(const gap of report.timeline.gaps)lines.push(`- ${cell(gap.from)} → ${cell(gap.to)} · ${gap.seconds} s${gap.explainedBy?' · '+L('同一窗口内出现「','explained by "')+cell(gap.explainedBy)+L('」','" in the same window'):''}`);
      lines.push('');
    }else lines.push(L('没有超过阈值的日志中断。','No gap exceeded the threshold.'),'');
    if(report.timeline.untimedRows)lines.push(L('注：','Note: ')+report.timeline.untimedRows+L(' 行没有可解析的时间戳，未参与中断判断。',' rows carry no parseable timestamp and were left out of gap detection.'),'');
    lines.push('');
    lines.push('## 3. '+L('趋势与突发','Trend and bursts'),'');
    lines.push(L('每分钟桶数 ','Buckets ')+report.trend.buckets+L('，均值 ',' · mean ')+report.trend.mean+L('，标准差 ',' · stdev ')+report.trend.stdev+L('，中位数 ',' · median ')+report.trend.median+L('，突发阈值（中位数 + 3×MAD）',' · burst threshold (median + 3×MAD) ')+report.trend.threshold+L('。',' .'),'');
    if(report.trend.busiest)lines.push(L('最忙的一分钟：','Busiest bucket: ')+cell(report.trend.busiest.bucket)+' · '+report.trend.busiest.total+L(' 行',' rows'),'');
    if(!report.trend.bursts.length)lines.push(L('没有超过阈值的突发（桶数不足 8 时不判定突发）。','No bucket exceeded the threshold (bursts are not claimed below 8 buckets).'),'');
    else for(const burst of report.trend.bursts)lines.push(`- ${cell(burst.bucket)} · ${burst.total} ${L('行','rows')} · ${L('均值','mean')} ${burst.ratio}×`);
    if(report.trend.skipped)lines.push(L('注：','Note: ')+report.trend.skipped+L(' 行的时间戳不是 YYYY-MM-DD HH:MM 形式（例如 syslog 风格），未参与分桶。',' rows use a timestamp that is not YYYY-MM-DD HH:MM (syslog style, for instance) and were not bucketed.'),'');
    lines.push('');
    lines.push('## 4. '+L('根因排序与处置','Ranked causes and actions'),'');
    if(!report.ranked.length)lines.push(L('未命中已知规则：这不代表设备一定正常。','No known rule matched; this does not prove the device is healthy.'),'');
    for(const item of report.ranked){
      lines.push(`### ${item.rank}. ${cell(item.category)} · ${L('风险','risk')} ${L(item.risk,item.riskLabel)} (${item.score})`);
      lines.push('- '+L('次数：','Count: ')+item.count+L(' 次 / ',' / ')+item.signatures+L(' 个签名',' signatures')+(item.spanMinutes?L('，跨 ',' , over ')+item.spanMinutes+L(' 分钟',' min'):''));
      lines.push('- '+L('首次 / 最近：','First / last: ')+cell(item.first||'—')+' / '+cell(item.last||'—'));
      if(item.modules.length)lines.push('- '+L('模块：','Modules: ')+cell(item.modules.join(', ')));
      lines.push('- '+L('可能原因：','Likely cause: ')+cell(item.cause||diagnostic(en,'未分类')));
      lines.push('- '+L('建议动作：','Suggested action: ')+cell(item.action||'—'));
      for(const evidence of item.evidence)lines.push('  - '+L('证据：','Evidence: ')+cell(evidence));
      lines.push('');
    }
    lines.push('---','');
    lines.push(L('本报告由本地规则匹配生成：它列出可疑项并排序，不构成因果结论。所有内容在生成时已按配置脱敏。','This report was produced by local rule matching: it lists and ranks candidates, and is not a causal conclusion. All content was redacted as configured when it was generated.'));
    return lines.join('\n');
  }

  const api={redact,parse,diagnose,classify,levelFor:levelOf,summarize,merge,ansi,isContinuation,signature,clusterSignatures,timeline,trend,rank,buildReport,renderReportMarkdown,translateDiagnostic,countLines,compareLines,formatCompare,analysisWindow,ANALYSIS_WINDOW,CAUSES,LIFECYCLE};
  if(typeof module!=='undefined')module.exports=api;else root.LogAnalysis=api;
})(globalThis);
