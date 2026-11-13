'use strict';
// The analysis the workspace shows, and the report it exports, are the same four findings — which is
// the point of this file. "Smart analysis" used to produce a level tally, a few deduplicated advice
// sentences and a jump back to a line: it could tell you where something was, not what was going on.
// The four sections here are the four questions that were missing — which anomaly, how many times;
// what the device did and when it stopped talking; is the rate climbing; and what to fix first — and
// they are rendered from the same `LogAnalysis.buildReport` object the Markdown, HTML and PDF exports
// are rendered from, so a report and the panel can never disagree.
//
// All of it is a pure function of the rows in the analysis scope; nothing here needs the core.
const analysisSections=[],analysisScopeSelect=typeof scope!=='undefined'?scope:null;

// `createAnalysisSection`, not `analysisPanel`: `workstation.js` already owns a global of that name
// for the `.analysis` aside element, and two declarations of one identifier in the same global scope
// is a SyntaxError that takes this whole file down — analysis, report dialog and exports together.
function createAnalysisSection(id,titleZh,titleEn){
 const panel=document.createElement('details');panel.id=id;panel.open=true;panel.className='analysis-section';
 const summary=document.createElement('summary'),body=document.createElement('div');
 summary.textContent=uiText(titleZh,titleEn);
 body.className='analysis-body';
 panel.append(summary,body);$('#findings').before(panel);
 analysisSections.push({summary,titleZh,titleEn});
 return body;
}
const rankBody=createAnalysisSection('rankedCauses','根因排序与处置','Ranked causes and actions');
const signatureBody=createAnalysisSection('sigGroups','异常签名聚类','Anomaly signatures');
const timelineBody=createAnalysisSection('lifecycleTimeline','生命周期与日志中断','Lifecycle and log gaps');
const trendBody=createAnalysisSection('trendPanel','趋势与突发','Trend and bursts');

// The scope selector is the same control `#ai` already honours; reading it here rather than caching a
// copy means the four sections and the summary line always describe the same rows.
function analysisRows(){
 let selected=lines.get(active)||[];
 const mode=analysisScopeSelect?analysisScopeSelect.value:'current';
 if(mode==='error')selected=selected.filter(row=>['ERROR','WARN'].includes(row.level));
 else if(mode==='all')selected=[...lines.values()].flatMap(buffer=>buffer.slice(-500));
 else if(mode==='context'){const at=selected.findLastIndex(row=>['ERROR','WARN'].includes(row.level));selected=at<0?[]:selected.slice(Math.max(0,at-20),at+21)}
 return selected.slice(-2000);
}
function rowSession(row){
 for(const [session,buffer] of lines)if(buffer.includes(row))return session;
 return active;
}
// Every item in every section can be walked back to the line it came from. A finding you cannot check
// is a finding you have to take on faith, which is exactly what the old one-line summary was.
function locationButton(label,row){
 const button=document.createElement('button');button.type='button';button.className='evidence-jump';
 button.textContent=label;button.style.cssText='background:transparent;border:1px solid #3d5561;color:inherit;font:12px \'Cascadia Mono\',Consolas,monospace;padding:1px 7px;margin:2px 4px 2px 0';
 button.onclick=()=>{const session=rowSession(row);if(locateEvidence(session,row))$('#status').textContent=uiText('已定位到证据行','Jumped to the evidence row')};
 return button;
}
function sectionLine(parent,text){const line=document.createElement('div');line.textContent=text;parent.append(line);return line}

function renderAnalysisSections(built){
 const {report}=built;
 rankBody.replaceChildren();
 if(!report.ranked.length)sectionLine(rankBody,uiText('未命中已知规则：这不代表设备一定正常。','No known rule matched; this does not prove the device is healthy.'));
 for(const item of report.ranked){
  const head=document.createElement('div');
  head.textContent=`${item.rank}. ${item.category} · ${uiText('风险 ','risk ')}${uiText(item.risk,item.riskLabel)} (${item.score}) · ${item.count} ${uiText('次','×')} · ${item.signatures} ${uiText('个签名','signatures')}`;
  head.style.cssText='margin-top:6px;color:var(--warn,#f6c453)';
  rankBody.append(head);
  sectionLine(rankBody,uiText('可能原因：','Likely cause: ')+(item.cause||uiText(LogAnalysis.CAUSES['未分类'],'No known rule matched; a human has to read it (this does not mean the device is healthy)')));
  // item.category 已经由 buildReport({lang}) 按当前语言翻好，面板和 Markdown/HTML/PDF 三条导出
  // 拿到的是同一个名字；这里不再回查 LogAnalysis.CAUSES（那张表恒为中文，是聚类和断言的内部真值）。
  sectionLine(rankBody,uiText('建议动作：','Suggested action: ')+(item.action||'—'));
  if(item.spanMinutes)sectionLine(rankBody,uiText('时间跨度：','Spread: ')+item.spanMinutes+uiText(' 分钟',' min'));
  // 聚类和排序在英文模式下都已经被 buildReport({lang}) 翻过，所以这里的"没有类别"兜底也要
  // 跟着当前语言走，否则英文界面下这个兜底永远匹配不上（item.category 是 Uncategorised）。
  const uncategorised=LogAnalysis.translateDiagnostic('未分类',localStorage.lang);
  const anchor=report.clusters.find(cluster=>(cluster.category||uncategorised)===item.category&&cluster.rows.length);
  if(anchor)rankBody.append(locationButton(uiText('定位证据 · ','Locate evidence · ')+(anchor.first||'—'),anchor.rows[0]));
  for(const evidence of item.evidence.slice(0,3))sectionLine(rankBody,'  '+uiText('证据：','evidence: ')+evidence);
 }

 signatureBody.replaceChildren();
 if(!report.clusters.length)sectionLine(signatureBody,uiText('未命中异常签名。','No anomaly signature matched.'));
 for(const cluster of report.clusters){
  const head=document.createElement('div');
  head.textContent=`×${cluster.count} · ${cluster.level}${cluster.category?' · '+cluster.category:''} · ${cluster.first||'—'} → ${cluster.last||'—'}`;
  head.style.cssText='margin-top:6px';
  signatureBody.append(head);
  sectionLine(signatureBody,'  '+(cluster.modules.join(', ')||'—')+' · '+cluster.sample);
  if(cluster.rows.length)signatureBody.append(locationButton(uiText('定位原日志 · ','Locate source · ')+(cluster.first||'—'),cluster.rows[0]));
 }

 timelineBody.replaceChildren();
 if(!report.timeline.events.length)sectionLine(timelineBody,uiText('未发现设备生命周期事件。','No device lifecycle event found.'));
 else for(const event of report.timeline.events.slice(0,40)){
  const line=document.createElement('div');line.textContent=`${event.time||'—'} · ${event.category}${event.severity?' · '+event.severity:''} · ${event.message}`;
  timelineBody.append(line);
  const row=built.rows[event.index];
  if(row)timelineBody.append(locationButton(uiText('定位 · ','Locate · ')+(event.time||'—'),row));
 }
 if(report.timeline.gaps.length){
  sectionLine(timelineBody,'');
  sectionLine(timelineBody,uiText('日志中断（超过本日志正常间隔中位数 × 4 且不短于 30 秒）：','Log gaps (over 4× this log\'s median interval, and at least 30 s):'));
  for(const gap of report.timeline.gaps)sectionLine(timelineBody,`  ${gap.from} → ${gap.to} · ${gap.seconds} s${gap.explainedBy?uiText(' · 同一窗口出现「',' · explained by "')+gap.explainedBy+uiText('」','"'):''}`);
 }else sectionLine(timelineBody,uiText('没有超过阈值的日志中断。','No gap exceeded the threshold.'));
 if(report.timeline.untimedRows)sectionLine(timelineBody,uiText('注：','Note: ')+report.timeline.untimedRows+uiText(' 行没有可解析的时间戳。',' rows carry no parseable timestamp.'));

 trendBody.replaceChildren();
 sectionLine(trendBody,uiText('桶数 ','Buckets ')+report.trend.buckets+uiText(' · 均值 ',' · mean ')+report.trend.mean+uiText(' · 标准差 ',' · stdev ')+report.trend.stdev+uiText(' · 中位数 ',' · median ')+report.trend.median+uiText(' · 突发阈值（中位数+3×MAD）',' · burst threshold (median + 3×MAD) ')+report.trend.threshold);
 if(report.trend.busiest)sectionLine(trendBody,uiText('最忙的一分钟：','Busiest: ')+report.trend.busiest.bucket+' · '+report.trend.busiest.total+uiText(' 行',' rows'));
 if(!report.trend.bursts.length)sectionLine(trendBody,uiText('没有超过阈值的突发（桶数不足 8 时不判定突发）。','No bucket exceeded the threshold (no burst claim below 8 buckets).'));
 else for(const burst of report.trend.bursts)sectionLine(trendBody,`  ${burst.bucket} · ${burst.total} ${uiText('行','rows')} · ${uiText('均值','mean')} ${burst.ratio}×`);
 if(report.trend.skipped)sectionLine(trendBody,uiText('注：','Note: ')+report.trend.skipped+uiText(' 行的时间戳不是 YYYY-MM-DD HH:MM 形式，未参与分桶。',' rows use a timestamp that is not YYYY-MM-DD HH:MM and were not bucketed.'));
}

function buildDiagnosticReport(){
 const rows=analysisRows();
 // lang 要一起交给 buildReport：类别、可能原因和建议动作是随报告对象流动的数据，英文模式下必须
 // 在分析层就翻好，面板和后面的 Markdown/HTML/PDF 导出才会是同一份文案。
 const report=LogAnalysis.buildReport(rows,{session:sessions.get(active)||active||'',lang:localStorage.lang});
 return {rows,report,markdown:LogAnalysis.renderReportMarkdown(report,{lang:localStorage.lang})};
}

// diagnose() 恒返回中文建议（那是 analysis.js 与 hybrid/core/main.cpp 的共同真值）。英文界面下
// 右侧面板和"本地分析"结论要把它们翻过去；translateDiagnostic 用的是同一张词表，翻不过去时
// 原样返回中文——宁可露出中文，也不要造一个对不上来源的英文句子。
function localizedDiagnosis(row){const text=LogAnalysis.diagnose(row);return text?LogAnalysis.translateDiagnostic(text,localStorage.lang):text}

// ---------------------------------------------------------------------------------------------------
// One export path for Markdown, HTML and PDF. They used to build their own strings from the same
// rows, which is how the same session produces three reports that disagree with each other.
// ---------------------------------------------------------------------------------------------------
function exportDiagnosticReport(kind){
 const built=buildDiagnosticReport();
 if(!built.report.count){$('#status').textContent=uiText('当前范围没有日志，无法导出报告','No logs in the current scope; nothing to export');return}
 const name=sessions.get(active)||'LogScope';
 if(kind==='md'){download(`LogScope-${Date.now()}.md`,built.markdown,'text/markdown');$('#status').textContent=uiText('已导出 Markdown 报告','Markdown report exported');return}
 if(kind==='html'){
  const document_='<!doctype html><meta charset="utf-8"><title>LogScope</title><h1>'+esc(name)+'</h1><pre>'+esc(built.markdown)+'</pre>';
  download(`LogScope-${Date.now()}.html`,document_,'text/html');$('#status').textContent=uiText('已导出 HTML 报告','HTML report exported');return
 }
 // The PDF is rendered in the main process, which redacts the text again before it writes anything —
 // so the Markdown goes over as it is, not pre-escaped.
 return window.core.pdfReport(name,built.markdown).then(file=>{if(file)$('#status').textContent=file}).catch(error=>{$('#status').textContent=error.message});
}

const reportDialog=document.createElement('dialog');reportDialog.id='analysisReportDialog';reportDialog.className='manager-dialog';
const reportHead=document.createElement('h3'),reportSearch=document.createElement('input'),reportBody=document.createElement('pre'),reportActions=document.createElement('div');
const reportCopy=document.createElement('button'),reportMd=document.createElement('button'),reportHtml=document.createElement('button'),reportPdf=document.createElement('button'),reportClose=document.createElement('button');
reportSearch.placeholder=uiText('在报告中搜索','Search inside the report');reportBody.style.cssText='max-height:52vh;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#0c1115;padding:10px;border:1px solid #34444f;border-radius:4px';
reportActions.style.cssText='display:flex;gap:8px;flex-wrap:wrap;margin-top:10px';
let reportText='';
reportHead.textContent=uiText('完整分析报告','Full analysis report');
reportCopy.textContent=uiText('复制','Copy');reportMd.textContent=uiText('导出 Markdown','Export Markdown');reportHtml.textContent=uiText('导出 HTML','Export HTML');reportPdf.textContent=uiText('导出 PDF','Export PDF');reportClose.textContent=uiText('关闭','Close');
reportSearch.oninput=()=>{const needle=reportSearch.value.trim().toLowerCase();reportBody.textContent=needle?reportText.split('\n').filter(line=>line.toLowerCase().includes(needle)).join('\n'):reportText};
reportCopy.onclick=async()=>{await window.core.copyText(reportText);$('#status').textContent=uiText('报告已复制','Report copied')};
reportMd.onclick=()=>exportDiagnosticReport('md');
reportHtml.onclick=()=>exportDiagnosticReport('html');
reportPdf.onclick=()=>exportDiagnosticReport('pdf');
reportClose.onclick=()=>reportDialog.close();
reportActions.append(reportCopy,reportMd,reportHtml,reportPdf,reportClose);
reportDialog.append(reportHead,reportSearch,reportBody,reportActions);document.body.append(reportDialog);

const fullReportButton=document.createElement('button');fullReportButton.id='fullReport';fullReportButton.type='button';
fullReportButton.onclick=()=>{
 const built=buildDiagnosticReport();
 reportText=built.markdown;reportSearch.value='';reportBody.textContent=reportText;
 reportHead.textContent=uiText('完整分析报告','Full analysis report')+' · '+(sessions.get(active)||active||'—')+' · '+built.report.count+uiText(' 行',' rows');
 reportDialog.showModal();
};
const analysisTitle=document.querySelector('.analysis .side-title');
if(analysisTitle)analysisTitle.after(fullReportButton);else $('#findings').before(fullReportButton);

// The analysis button keeps its old obligations — the local summary, the evidence links, the local
// model, the cloud double switch and the redacted preview — and adds the four sections and the status
// sentence the end-to-end check looks for.
const analyzeButton=$('#ai');
if(analyzeButton)analyzeButton.onclick=async()=>{
 const title=uiText('本地分析结果','Local analysis');$('#status').textContent=uiText('正在分析…','Analyzing…');
 try{
  await new Promise(resolve=>setTimeout(resolve,0));
  const selected=analysisRows();
  if(!selected.length){const message=uiText('当前范围没有日志，请先连接设备、导入日志或修改分析范围。','No logs in this scope. Connect a session, import logs, or change the scope.');addFinding(title,message);$('#status').textContent=message;return}
  const built=buildDiagnosticReport();
  const diagnoses=[...new Set(selected.map(localizedDiagnosis).filter(Boolean))];
  addFinding(title,uiText('分析行数: ','Rows analyzed: ')+built.report.count+'\n'+JSON.stringify(built.report.summary.levels)+'\n'+(diagnoses.join('\n')||uiText('未命中已知异常规则；这不代表设备一定正常。','No known anomaly matched; this does not prove the device is healthy.')));
  renderAnalysisSections(built);
  const references=[];
  for(const row of selected.filter(x=>['ERROR','WARN'].includes(x.level)).slice(-10)){for(const [session,buffer] of lines){if(buffer.includes(row)){references.push({session,row});break}}}
  if(typeof appendEvidenceLinks==='function')appendEvidenceLinks($('#findings').firstElementChild,references);
  $('.analysis').scrollTop=0;$('#status').textContent=uiText('本地分析完成，结果见右侧','Local analysis complete; see results on the right');
  await analyzeLocalModel(selected);
  if(!$('#cloud').checked)return;
  if(!$('#outbound').checked){$('#status').textContent=uiText('本地分析完成；未允许出网，未调用云端','Local analysis complete; outbound disabled, cloud not called');return}
  // What leaves the machine is the same report the panel is showing, redacted by the same function —
  // never the raw rows.
  const preview=await editor(uiText('脱敏预览：确认后发送到云端','Redacted preview: apply to send to cloud'),redactAll(built.markdown.slice(-16000)));
  if(preview===null)return;
  $('#status').textContent=uiText('云端分析中…','Cloud analysis in progress…');
  const result=await window.core.analyze(null,redactAll(preview),{cloudEnabled:true,allowOutbound:true,...aiRequestOptions()});
  addFinding('AI',result);$('#status').textContent=uiText('分析完成','Analysis complete');
 }catch(error){addFinding(uiText('分析失败','Analysis failed'),error.message);$('#status').textContent=error.message}
};
const legacyReportButton=$('#report');
if(legacyReportButton)legacyReportButton.onclick=()=>exportDiagnosticReport('md');
// `tool()` appends a bare button and the localisation pass rewrites its text node, so the lookup has to
// accept either language — this file can load after the labels have already been translated.
const toolButton=(zh,en)=>[...bar.children].find(button=>{const text=button.textContent.trim();return text.startsWith(zh)||text.startsWith(en)});
for(const [zh,en,kind] of [['HTML 报告','HTML report','html'],['PDF 报告','PDF report','pdf']]){
 const button=toolButton(zh,en);if(button)button.onclick=()=>exportDiagnosticReport(kind);
}
const localizeBeforeReport=localize;
localize=()=>{
 localizeBeforeReport();
 for(const {summary,titleZh,titleEn} of analysisSections)summary.textContent=uiText(titleZh,titleEn);
 fullReportButton.textContent=uiText('完整报告','Full report');
 fullReportButton.title=uiText('在对话框里查看完整报告并导出 MD / HTML / PDF','Read the whole report in a dialog and export MD / HTML / PDF');
 reportSearch.placeholder=uiText('在报告中搜索','Search inside the report');
 reportCopy.textContent=uiText('复制','Copy');reportMd.textContent=uiText('导出 Markdown','Export Markdown');
 reportHtml.textContent=uiText('导出 HTML','Export HTML');reportPdf.textContent=uiText('导出 PDF','Export PDF');reportClose.textContent=uiText('关闭','Close');
};
fullReportButton.textContent=uiText('完整报告','Full report');
fullReportButton.title=uiText('在对话框里查看完整报告并导出 MD / HTML / PDF','Read the whole report in a dialog and export MD / HTML / PDF');
fullReportButton.style.cssText='font-size:12px;padding:3px 9px;margin:2px 0 10px';
