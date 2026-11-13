'use strict';
// 正则引擎：所有"用户输入的正则"都在一个 Worker 里跑，而不是在渲染进程里。
//
// 为什么必须隔离：`(a+)+$` 这类灾难性回溯会让正则引擎跑上几百万步，卡在渲染进程里就是整个界面冻住
// ——日志不再刷新、按钮点不动，用户只能杀进程。放进 Worker 后，超时就 terminate() 掉那个 worker，
// 界面只丢一次匹配结果，不会丢响应性。
//
// 两条调用路径，各自一个实例：
//   * 实时规则（rule-pipeline.js 的 liveRegex，persistent=true）：常驻 worker，每条日志都要过一遍；
//   * 查询过滤（rule-pipeline.js 的 filterRegex，一次性）：跑完就销毁，避免长会话里攒下一堆线程。
//
// 单飞约定：一个实例同时只跑一个任务（pending），并发调用直接拒绝。调用方要么像 filteredRowsAsync
// 那样按 signature 去重，要么自己排队——所以这里不需要任务队列。

// worker 脚本的位置。必须是绝对 URL 或 './' 开头的相对 URL：直接写 'regex-worker.js' 会抛
// ERR_WORKER_PATH，因为裸文件名无法相对任何 base 解析——而渲染进程里没有可用的 __dirname。
// 本文件与 regex-worker.js 同目录，因此以 document.baseURI 为基准相对定位最稳妥。
const REGEX_WORKER_URL=new URL('regex-worker.js',document.baseURI).href;
// 输入上限：这是"挡住误用"的边界，不是性能承诺。单次调用最多 51 条模式、每条 512 字符、
// 30 万条文本或 48 MiB 总字符数——超过就明确拒绝，而不是让 worker 吃掉几百 MB 内存。
// 文本上限与 log-files.cjs 的 preview 载入上限保持一致，保证整个导入缓冲区都能被搜索。
const REGEX_MAX_PATTERNS=51,REGEX_MAX_PATTERN_LENGTH=512,REGEX_MAX_TEXTS=300000,REGEX_MAX_TOTAL_CHARS=48*1024*1024;
// 默认超时。1 秒对正常正则是宽裕的；只有回溯爆炸才会走到这里，那时 terminate 才是正确结局。
const REGEX_DEFAULT_TIMEOUT=1000;

class RegexRunner{
  // persistent=true 时 worker 跑完不销毁，供实时规则复用（省掉每条日志都起线程的开销）。
  constructor(persistent=false){this.persistent=persistent;this.worker=null;this.pending=false}

  // patterns 与 texts 是并行的输入：返回一个二维数组，result[i] 是 texts[i] 命中的模式下标列表。
  // 失败一律走 reject，调用方必须处理——静默吞掉会变成"过滤后什么都不剩"，比报错更难查。
  // options（可选）原样并入 postMessage 载荷：{flags} 改大小写敏感性、{ranges:true} 让
  // worker 返回命中区间明细——见 regex-worker.js 顶部注释；不传时行为与旧版完全一致。
  run(patterns,texts,timeout=REGEX_DEFAULT_TIMEOUT,options=null){
    if(this.pending)return Promise.reject(Error('Regex worker is busy'));
    const totalChars=texts.reduce((sum,text)=>sum+text.length,0);
    if(patterns.length>REGEX_MAX_PATTERNS||patterns.some(pattern=>typeof pattern!=='string'||pattern.length>REGEX_MAX_PATTERN_LENGTH)||
       texts.length>REGEX_MAX_TEXTS||totalChars>REGEX_MAX_TOTAL_CHARS){
      return Promise.reject(Error('Regex input exceeds safety limit; narrow the scope or use full-file literal search'));
    }
    this.pending=true;
    return new Promise((resolve,reject)=>{
      const worker=this.worker||(this.worker=new Worker(REGEX_WORKER_URL));
      let settled=false;
      // 三条出口（消息回来、worker 报错、超时）都汇聚到这里：只结算一次，清除监听和定时器，
      // 并按需销毁 worker。worker 出错后状态不可信，必须销毁，下次 run() 会重新建一个。
      const finish=(error,result)=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        this.pending=false;
        worker.onmessage=worker.onerror=null;
        if(error){
          worker.terminate();
          this.worker=null;
          reject(error);
        }else{
          if(!this.persistent){worker.terminate();this.worker=null}
          resolve(result);
        }
      };
      // 超时是这套机制的核心：到点就终止，正则再疯狂也不会占着界面。
      const timer=setTimeout(()=>finish(Error('Regex timed out and was terminated; simplify the pattern')),timeout);
      worker.onmessage=event=>finish(event.data.error?Error(event.data.error):null,event.data.result);
      worker.onerror=event=>finish(Error(event.message));
      worker.postMessage(options?{patterns,texts,...options}:{patterns,texts});
    });
  }
}