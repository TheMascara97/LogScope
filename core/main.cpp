// Native bounded log acquisition core. JSON-lines over a local Windows pipe.
#include "pty_process.h"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <psapi.h>
#include <QDateTime>
#include <QFile>
#include <QDir>
#include <QUuid>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QProcess>
#include <QRegularExpression>
#include <QSerialPort>
#include <QSerialPortInfo>
#include <QTcpSocket>
#include <QTimer>
#include <utility>
#include "telnet_decoder.h"
#include "async_log_writer.h"
#include <QStringDecoder>
#include <memory>
constexpr int MAX_QUEUE_LINES=20000; constexpr qint64 ROLL_BYTES=50LL*1024*1024;
static QString redact(QString s){static const QList<QPair<QRegularExpression,QString>> r{{QRegularExpression("\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b"),"<IP>"},{QRegularExpression("\\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\\b",QRegularExpression::CaseInsensitiveOption),"<MAC>"},{QRegularExpression("(?i)\\b(bearer\\s+)[^\\s,;]+"),"\\1<TOKEN>"},{QRegularExpression("(?i)\\b(password|passwd|token|api[_-]?key|secret)\\s*([=:])\\s*[^\\s,;]+"),"\\1\\2<REDACTED>"},{QRegularExpression("(?i)\\b(device(?:_?id)?|serial|sn|imei|imsi|iccid|vin|signal(?:_?id|_?value)?)\\s*([=:])\\s*[A-Za-z0-9._:/+-]+"),"\\1\\2<DEVICE_REDACTED>"}};for(auto &x:r)s.replace(x.first,x.second);return s;}
// Device lifecycle is part of the analysis, not a footnote: a reboot, a watchdog bite or a
// brown-out is what an engineer opens the log to find, and none of them is spelled ERROR.
// Every rule therefore carries the category it belongs to and the severity to treat it with;
// the first match wins, so the specific lifecycle rules sit above the generic "looks severe".
struct Finding{QString category,severity,advice;bool ok()const{return !category.isEmpty();}};
struct Rule{QRegularExpression re;QString category,severity,advice;};
static QString levelFor(const QString& severity){return severity=="critical"||severity=="error"?"ERROR":severity=="warn"?"WARN":"EVENT";}
// A finding only takes over the row's level when the log is announcing a fault. Anything less
// than that (a watchdog the device printed at WARN and the diagnoser read as critical is a fault;
// an inferred "no answer" timeout is not) is left to the level the line itself carries, which the
// UI derives from the text — so a live session and an imported file classify identically.
static bool promotes(const QString& severity){return severity=="critical"||severity=="error";}
static Finding diagnose(const QString&s){static const QList<Rule> rules{
 {QRegularExpression("watchdog|\\bwdt\\b|watch dog|feed(?:ing)? the dog|\\biwdg\\b|\\bwwdg\\b",QRegularExpression::CaseInsensitiveOption),QStringLiteral("看门狗"),QStringLiteral("critical"),QStringLiteral("看门狗触发：核对喂狗任务是否被阻塞、复位原因寄存器与复位计数")},
 {QRegularExpression("\\bpanic\\b|kernel oops|hard ?fault|segmentation fault|\\bsegfault\\b|stack overflow|assert(?:ion)? (?:failed|failure)|\\babort(?:ed)?\\b|double free|core dump|unhandled exception",QRegularExpression::CaseInsensitiveOption),QStringLiteral("异常复位"),QStringLiteral("critical"),QStringLiteral("固件异常复位：保留复位前后日志，核对调用栈与断言位置")},
 {QRegularExpression("brown ?out|under ?voltage|low voltage|power(?: supply)? (?:fail|loss)|power loss|\\bvbat\\b|voltage (?:drop|dip|below)",QRegularExpression::CaseInsensitiveOption),QStringLiteral("掉电欠压"),QStringLiteral("critical"),QStringLiteral("供电异常：检查掉电/欠压阈值、电源纹波与线束接触")},
 {QRegularExpression("\\breboot(?:ed|ing)?\\b|\\brestart(?:ed|ing)?\\b|system reset|software reset|hard reset|reset (?:reason|cause|source|by)|power[ -]?on|power[ -]?up|booting up|\\bbooted\\b",QRegularExpression::CaseInsensitiveOption),QStringLiteral("设备重启"),QStringLiteral("event"),QStringLiteral("设备重启：记录重启时刻与复位原因，并核对重启前后的日志中断时间")},
 {QRegularExpression("out of memory|\\boom\\b|heap exhausted|alloc(?:ation)? fail(?:ed|ure)?|memory leak",QRegularExpression::CaseInsensitiveOption),QStringLiteral("内存不足"),QStringLiteral("critical"),QStringLiteral("内存不足：检查内存水位、泄漏和容器限制")},
 {QRegularExpression("no space left|disk full|read-only file system|bad block|\\bfsck\\b|mount (?:fail|error)|(?:sd ?card|emmc|nand|flash)[^.]{0,24}(?:error|fail|timeout|full|corrupt)",QRegularExpression::CaseInsensitiveOption),QStringLiteral("存储异常"),QStringLiteral("error"),QStringLiteral("存储异常：检查剩余空间、坏块与文件系统挂载")},
 {QRegularExpression("link (?:down|up)|carrier lost|disconnect(?:ed|ing)?|reconnect(?:ed|ing)?|connection (?:lost|reset)|bus ?off|\\bcan ?bus\\b",QRegularExpression::CaseInsensitiveOption),QStringLiteral("链路变化"),QStringLiteral("event"),QStringLiteral("通信链路变化：核对断开与恢复时刻、对端状态和线束")},
 {QRegularExpression("\\bota\\b|firmware|bootloader|flash (?:write|erase|error)|upgrade|downgrade",QRegularExpression::CaseInsensitiveOption),QStringLiteral("固件升级"),QStringLiteral("event"),QStringLiteral("固件与升级：确认版本、升级结果以及是否发生回滚")},
 {QRegularExpression("over ?temp|thermal|throttl|temperature .{0,20}(?:high|critical)",QRegularExpression::CaseInsensitiveOption),QStringLiteral("温度"),QStringLiteral("error"),QStringLiteral("温度异常：检查散热、风扇与降频策略")},
 {QRegularExpression("timeout|timed out|no response",QRegularExpression::CaseInsensitiveOption),QStringLiteral("超时"),QStringLiteral("warn"),QStringLiteral("请求超时：检查下游可用性、网络延迟与连接池")},
 {QRegularExpression("connection refused",QRegularExpression::CaseInsensitiveOption),QStringLiteral("连接被拒绝"),QStringLiteral("error"),QStringLiteral("连接被拒绝：确认目标服务监听、防火墙和服务状态")},
 {QRegularExpression("permission denied|access denied|authentication fail",QRegularExpression::CaseInsensitiveOption),QStringLiteral("权限"),QStringLiteral("error"),QStringLiteral("权限失败：检查账号、资源权限与凭据")},
 {QRegularExpression("\\b(ERROR|FATAL|CRITICAL|EXCEPTION|TRACEBACK)\\b",QRegularExpression::CaseInsensitiveOption),QStringLiteral("严重异常"),QStringLiteral("error"),QStringLiteral("严重异常：请结合前后日志和调用链排查")}
 };for(const auto& rule:rules)if(rule.re.match(s).hasMatch())return{rule.category,rule.severity,rule.advice};return{};}
// The whole-text pass behind local.analyze: what categories appear in this block, and how often.
static QString diagnoseAll(const QString& text,QString* topAdvice=nullptr){QHash<QString,int> counts;QStringList order;QString advice;for(const auto& line:text.split('\n')){const auto f=diagnose(line);if(!f.ok())continue;if(!counts.contains(f.category)){order<<f.category;if(advice.isEmpty())advice=f.advice;}counts[f.category]++;}if(topAdvice)*topAdvice=advice;QStringList out;for(const auto& category:order)out<<QStringLiteral("%1 ×%2").arg(category).arg(counts[category]);return out.join(QStringLiteral("；"));}

// Crash forensics. An access violation in the field would otherwise leave nothing
// behind but a WER offset, so record the faulting instruction, the registers and
// the failing thread's return addresses. Everything is stack-buffer based: the
// heap may already be damaged when this runs.
static void writeCrashLog(const char* text,int len){wchar_t path[MAX_PATH]{};if(GetModuleFileNameW(nullptr,path,MAX_PATH)){wchar_t* slash=wcsrchr(path,L'\\');if(slash&&size_t(slash-path)<MAX_PATH-32){slash[1]=0;wcscat_s(path,MAX_PATH,L"LogScopeCore-crash.log");}else path[0]=0;}HANDLE file=INVALID_HANDLE_VALUE;if(path[0])file=CreateFileW(path,GENERIC_WRITE,FILE_SHARE_READ,nullptr,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);if(file==INVALID_HANDLE_VALUE){wchar_t temp[MAX_PATH]{};if(GetTempPathW(MAX_PATH,temp)){wcscat_s(temp,MAX_PATH,L"LogScopeCore-crash.log");file=CreateFileW(temp,GENERIC_WRITE,FILE_SHARE_READ,nullptr,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);}}if(file==INVALID_HANDLE_VALUE)return;SetFilePointer(file,0,nullptr,FILE_END);DWORD written=0;WriteFile(file,text,DWORD(len),&written,nullptr);CloseHandle(file);}
static LONG WINAPI crashFilter(EXCEPTION_POINTERS* info){const auto* record=info->ExceptionRecord;if(record->ExceptionCode!=EXCEPTION_ACCESS_VIOLATION)return EXCEPTION_CONTINUE_SEARCH;char text[8192];int n=0;const auto base=reinterpret_cast<quintptr>(GetModuleHandleW(nullptr));const auto* ctx=info->ContextRecord;n+=sprintf_s(text+n,sizeof(text)-n,"LogScopeCore access violation read=%d address=%p rip=%p rva=%llx base=%p thread=%lu\r\n",int(record->ExceptionInformation[0]),reinterpret_cast<void*>(record->ExceptionInformation[1]),record->ExceptionAddress,(unsigned long long)(reinterpret_cast<quintptr>(record->ExceptionAddress)-base),reinterpret_cast<void*>(base),GetCurrentThreadId());n+=sprintf_s(text+n,sizeof(text)-n,"  rax=%p rbx=%p rcx=%p rdx=%p rsi=%p rdi=%p rbp=%p rsp=%p r8=%p r9=%p r10=%p r11=%p\r\n",reinterpret_cast<void*>(ctx->Rax),reinterpret_cast<void*>(ctx->Rbx),reinterpret_cast<void*>(ctx->Rcx),reinterpret_cast<void*>(ctx->Rdx),reinterpret_cast<void*>(ctx->Rsi),reinterpret_cast<void*>(ctx->Rdi),reinterpret_cast<void*>(ctx->Rbp),reinterpret_cast<void*>(ctx->Rsp),reinterpret_cast<void*>(ctx->R8),reinterpret_cast<void*>(ctx->R9),reinterpret_cast<void*>(ctx->R10),reinterpret_cast<void*>(ctx->R11));void* frames[64]{};const USHORT got=CaptureStackBackTrace(0,64,frames,nullptr);for(USHORT i=0;i<got&&n<int(sizeof(text))-48;i++)n+=sprintf_s(text+n,sizeof(text)-n,"  #%02u rva=%08llx\r\n",unsigned(i),(unsigned long long)(reinterpret_cast<quintptr>(frames[i])-base));const auto* stack=reinterpret_cast<const quintptr*>(ctx->Rsp);for(int i=0;i<24&&n<int(sizeof(text))-40;i++)n+=sprintf_s(text+n,sizeof(text)-n,"  rsp+%03x %p\r\n",i*8,reinterpret_cast<void*>(stack[i]));writeCrashLog(text,n);return EXCEPTION_CONTINUE_SEARCH;}

class Core final:public QObject{struct Source{TelnetDecoder telnet;QString id,kind,pending;std::shared_ptr<QStringDecoder> decoder=std::make_shared<QStringDecoder>(QStringDecoder::Utf8);QJsonObject cfg;QSerialPort*serial=nullptr;QTcpSocket*tcp=nullptr;QProcess*process=nullptr;PtyProcess*pty=nullptr;std::shared_ptr<AsyncLogWriter> writer;QTimer*retry=nullptr;bool desired=true;int attempts=0;qint64 roll=ROLL_BYTES;
 // Out-of-band command channel: a log-only stream (ssh tail -F, adb logcat, cmd /C) accepts
 // no useful stdin, so a command typed in the UI is run as a separate one-shot child and its
 // output is merged into this session's stream. One at a time; the rest queue.
 QProcess*chan=nullptr;QStringList chanQueue;bool chanBusy=false;};
 QLocalServer server_; QList<QLocalSocket*> clients_; QHash<QLocalSocket*,QByteArray> buffers_; QHash<QString,Source> sources_; QList<QJsonObject> queue_; int dropped_=0;qint64 queueBytes_=0,storageRoll_=ROLL_BYTES;int storageKeep_=2;quint64 receivedBytes_=0,totalDropped_=0;QHash<QLocalSocket*,quint64> ipcDropped_; QTimer flush_;QTimer orphan_;
 void send(QLocalSocket*s,const QJsonObject&o){if(!s||!clients_.contains(s)||s->state()!=QLocalSocket::ConnectedState)return;if(s->bytesToWrite()>=4*1024*1024){++ipcDropped_[s];return;}if(ipcDropped_.value(s)){const QJsonObject warning{{"type","warning"},{"message",QString("UI transport overloaded: skipped %1 messages; check raw log file").arg(ipcDropped_.take(s))}};s->write(QJsonDocument(warning).toJson(QJsonDocument::Compact)+"\n");}s->write(QJsonDocument(o).toJson(QJsonDocument::Compact)+"\n");} void broadcast(const QJsonObject&o){const auto clients=clients_;for(auto*s:clients)send(s,o);} void state(Source&x,const QString&v,const QString&m={}){broadcast({{"type","session.state"},{"id",x.id},{"state",v},{"message",m}});}
 void log(const QString&id,const QByteArray&raw){if(!sources_.contains(id)||raw.isEmpty())return;auto&x=sources_[id];receivedBytes_+=raw.size();broadcast({{"type","terminal"},{"session",id},{"data",QString::fromLatin1(raw.toBase64())}});if(x.writer)x.writer->append(raw);x.pending+=x.cfg["encoding"].toString()=="hex"?QString::fromLatin1(raw.toHex(' '))+"\n":(*x.decoder)(raw);QStringList completed;int at;while((at=x.pending.indexOf('\n'))>=0){completed<<x.pending.left(at);x.pending.remove(0,at+1);}while(x.pending.size()>65536){completed<<x.pending.left(65536);x.pending.remove(0,65536);}for(auto line:completed){if(line.size()>65536)line=line.left(65536)+" [UI line truncated; check raw file]";if(queue_.size()>=MAX_QUEUE_LINES||queueBytes_+line.size()*2>8*1024*1024){++dropped_;++totalDropped_;continue;}queueBytes_+=line.size()*2;const auto f=diagnose(line);QJsonObject o{{"type","log"},{"session",id},{"text",line},{"time",QDateTime::currentDateTime().toString(Qt::ISODateWithMs)}};if(f.ok()){if(promotes(f.severity))o["level"]=levelFor(f.severity);o["analysis"]=f.advice;o["redacted"]=redact(line);o["event"]=QJsonObject{{"category",f.category},{"severity",f.severity}};}queue_<<o;}}
 bool saveTo(Source& x,const QString& path,qint64 roll=0){if(!x.writer)x.writer=std::make_shared<AsyncLogWriter>([this,id=x.id](const QString& error){QMetaObject::invokeMethod(this,[this,id,error]{broadcast({{"type","error"},{"session",id},{"message",error}});},Qt::QueuedConnection);});return x.writer->setPath(path,roll>0?roll:storageRoll_,storageKeep_);}
 void flushTail(Source& x){if(!x.pending.isEmpty()){const auto text=std::exchange(x.pending,{});if(queue_.size()<MAX_QUEUE_LINES&&queueBytes_+text.size()*2<=8*1024*1024){queueBytes_+=text.size()*2;QJsonObject row{{"type","log"},{"session",x.id},{"text",text},{"time",QDateTime::currentDateTime().toString(Qt::ISODateWithMs)}};const auto f=diagnose(text);if(f.ok()){if(promotes(f.severity))row["level"]=levelFor(f.severity);row["analysis"]=f.advice;row["redacted"]=redact(text);row["event"]=QJsonObject{{"category",f.category},{"severity",f.severity}};}queue_<<row;}else {++dropped_;++totalDropped_;}}if(x.writer)x.writer->flush();}
 void reconnect(Source&x,const QString&why){if(!x.desired||x.retry->isActive())return;if(x.kind=="serial"){x.desired=false;x.serial->close();flushTail(x);state(x,"error",why+"; confirm serial reconnect manually");return;}state(x,"reconnecting",why);x.retry->start(qMin(30000,1000*(1<<qMin(5,++x.attempts))));}
 void attachProcess(Source&x){if(x.process)return;x.process=new QProcess(this);
connect(x.process,&QProcess::started,this,[this,id=x.id]{state(sources_[id],"connected");});
connect(x.process,&QProcess::errorOccurred,this,[this,id=x.id](QProcess::ProcessError){state(sources_[id],"error",sources_[id].process->errorString());});
connect(x.process,&QProcess::readyReadStandardOutput,this,[this,id=x.id]{if(sources_.contains(id))log(id,sources_[id].process->readAllStandardOutput());});connect(x.process,&QProcess::readyReadStandardError,this,[this,id=x.id]{if(sources_.contains(id))log(id,sources_[id].process->readAllStandardError());});connect(x.process,qOverload<int,QProcess::ExitStatus>(&QProcess::finished),this,[this,id=x.id](int,QProcess::ExitStatus){if(sources_.contains(id)){auto&x=sources_[id];flushTail(x);if(x.kind=="cmd"||x.kind=="adb"){x.desired=false;state(x,"closed","进程已退出");}else if(x.desired)reconnect(x,"进程已退出");}});}
 void start(Source&x){if((x.kind=="cmd"&&x.cfg["command"].toString().isEmpty())||(x.kind=="ssh"&&x.cfg["interactive"].toBool())||x.kind=="powershell"||x.kind=="wsl"){if(!x.pty){x.pty=new PtyProcess(this);x.pty->onOverflow=[this,id=x.id](quint64 lost){broadcast({{"type","warning"},{"session",id},{"message",QString("Terminal acquisition overflow: %1 raw bytes lost before saving").arg(lost)}});};x.pty->onOutput=[this,id=x.id](const QByteArray& b){log(id,b);};x.pty->onExit=[this,id=x.id]{flushTail(sources_[id]);sources_[id].desired=false;state(sources_[id],"closed");};x.pty->onError=[this,id=x.id](const QString& e){state(sources_[id],"error",e);};
   // An input-side failure must not move the session into error: the UI refuses every later
   // send while the tab is in that state, so one oversized paste used to lock the box for good.
   x.pty->onInputError=[this,id=x.id](const QString& e){broadcast({{"type","warning"},{"session",id},{"message",e}});};}QString executable="cmd.exe";QStringList args{"/D"};if(x.kind=="powershell"){executable="powershell.exe";args={"-NoLogo","-NoProfile"};if(!x.cfg["command"].toString().isEmpty())args<<"-Command"<<x.cfg["command"].toString();}else if(x.kind=="wsl"){executable="wsl.exe";args.clear();if(!x.cfg["command"].toString().isEmpty())args<<"-e"<<"sh"<<"-lc"<<x.cfg["command"].toString();}if(x.kind=="ssh"){executable="ssh.exe";args={"-tt","-o","ServerAliveInterval=20","-p",QString::number(x.cfg["port"].toInt(22))};if(!x.cfg["key"].toString().isEmpty())args<<"-i"<<x.cfg["key"].toString();if(!x.cfg["jump"].toString().isEmpty())args<<"-J"<<x.cfg["jump"].toString();if(!x.cfg["forward"].toString().isEmpty())args<<"-L"<<x.cfg["forward"].toString();args<<x.cfg["user"].toString()+"@"+x.cfg["host"].toString();if(!x.cfg["command"].toString().isEmpty())args<<x.cfg["command"].toString();}if(!x.pty->running()&&x.pty->start(executable,args))state(x,"connected");return;}if(x.process&&x.process->state()!=QProcess::NotRunning)return;if(x.kind=="serial"){if(!x.serial){x.serial=new QSerialPort(this);connect(x.serial,&QSerialPort::readyRead,this,[this,id=x.id]{log(id,sources_[id].serial->readAll());});connect(x.serial,&QSerialPort::errorOccurred,this,[this,id=x.id](auto e){if(e!=QSerialPort::NoError&&sources_.contains(id))reconnect(sources_[id],sources_[id].serial->errorString());});}if(x.serial->isOpen())return;
x.serial->setDataBits(static_cast<QSerialPort::DataBits>(x.cfg["dataBits"].toInt(8)));
x.serial->setStopBits(x.cfg["stopBits"].toInt(1)==2?QSerialPort::TwoStop:QSerialPort::OneStop);
x.serial->setParity(x.cfg["parity"].toString()=="even"?QSerialPort::EvenParity:x.cfg["parity"].toString()=="odd"?QSerialPort::OddParity:QSerialPort::NoParity);
x.serial->setFlowControl(x.cfg["flow"].toString()=="hardware"?QSerialPort::HardwareControl:x.cfg["flow"].toString()=="software"?QSerialPort::SoftwareControl:QSerialPort::NoFlowControl);
x.serial->setPortName(x.cfg["port"].toString());x.serial->setBaudRate(x.cfg["baud"].toInt(115200));if(x.serial->open(QIODevice::ReadWrite)){x.attempts=0;state(x,"connected");
   // The settings a session is really using, written into its own tab: "the device does not
   // answer" is usually a baud/parity/flow mismatch, and the dialog the user typed into is long
   // gone by the time they ask.
   channelLog(x.id,QStringLiteral("--- 串口 %1 已打开 / serial open · %2 %3%4%5 · 流控 %6 · 读写 · 行尾 CR ---").arg(x.cfg["port"].toString()).arg(x.cfg["baud"].toInt(115200)).arg(x.cfg["dataBits"].toInt(8)).arg(x.cfg["parity"].toString()=="even"?"E":x.cfg["parity"].toString()=="odd"?"O":"N").arg(x.cfg["stopBits"].toInt(1)).arg(x.cfg["flow"].toString()=="hardware"?QStringLiteral("硬件"):x.cfg["flow"].toString()=="software"?QStringLiteral("软件"):QStringLiteral("无")));}else reconnect(x,x.serial->errorString());return;}if(x.kind=="tcp"||x.kind=="telnet"){if(!x.tcp){x.tcp=new QTcpSocket(this);x.tcp->setReadBufferSize(1024*1024);connect(x.tcp,&QTcpSocket::readyRead,this,[this,id=x.id]{auto&y=sources_[id];auto data=y.tcp->readAll();if(y.kind=="telnet"){QByteArray reply;data=y.telnet.decode(data,reply);if(!reply.isEmpty())y.tcp->write(reply);}log(id,data);});connect(x.tcp,&QTcpSocket::connected,this,[this,id=x.id]{auto&y=sources_[id];y.attempts=0;state(y,"connected");});connect(x.tcp,&QTcpSocket::disconnected,this,[this,id=x.id]{if(sources_.contains(id)){flushTail(sources_[id]);reconnect(sources_[id],"连接已断开");}});connect(x.tcp,&QTcpSocket::errorOccurred,this,[this,id=x.id](auto){if(sources_.contains(id))reconnect(sources_[id],sources_[id].tcp->errorString());});}x.tcp->connectToHost(x.cfg["host"].toString(),quint16(x.cfg["port"].toInt(23)));state(x,"connecting");return;}attachProcess(x);if(x.kind=="ssh"){QStringList a{"-o","BatchMode=yes","-o","ServerAliveInterval=20","-o","ServerAliveCountMax=3","-p",QString::number(x.cfg["port"].toInt(22))};if(!x.cfg["key"].toString().isEmpty())a<<"-i"<<x.cfg["key"].toString();if(!x.cfg["jump"].toString().isEmpty())a<<"-J"<<x.cfg["jump"].toString();if(!x.cfg["forward"].toString().isEmpty())a<<"-L"<<x.cfg["forward"].toString();a<<(x.cfg["user"].toString()+"@"+x.cfg["host"].toString())<<x.cfg["command"].toString("tail -F /var/log/syslog");x.process->start("ssh",a);}else if(x.kind=="cmd"){auto c=x.cfg["command"].toString();if(c.isEmpty())x.process->start("cmd.exe");else x.process->start("cmd.exe",{"/C",c});}else{QStringList a;if(!x.cfg["adbSerial"].toString().isEmpty())a<<"-s"<<x.cfg["adbSerial"].toString();auto c=x.cfg["command"].toString();a<<(c.isEmpty()?QStringList{"logcat"}:QProcess::splitCommand(c));x.process->start("adb",a);}state(x,"connecting");}
 void create(const QString&kind,const QJsonObject&cfg){if(kind=="ssh"||kind=="tcp"||kind=="telnet"){const auto host=cfg["host"].toString();const auto port=cfg["port"].toInt(kind=="ssh"?22:kind=="telnet"?23:80);if(host.isEmpty()||host.startsWith('-')||!QRegularExpression("^[A-Za-z0-9_.:%\\[\\]-]+$").match(host).hasMatch()||port<1||port>65535){broadcast({{"type","error"},{"message","Invalid host or port (1-65535)"}});return;}}if(kind=="ssh"){const auto user=cfg["user"].toString();if(user.isEmpty()||user.startsWith('-')||!QRegularExpression("^[A-Za-z0-9_.-]+$").match(user).hasMatch()||(!cfg["jump"].toString().isEmpty()&&!QRegularExpression("^[A-Za-z0-9_.@:%\\[\\],-]+$").match(cfg["jump"].toString()).hasMatch())||(!cfg["forward"].toString().isEmpty()&&!QRegularExpression("^[A-Za-z0-9_.:%\\[\\]-]+$").match(cfg["forward"].toString()).hasMatch())){broadcast({{"type","error"},{"message","Invalid SSH user, jump host or forwarding specification"}});return;}}auto id=kind+":"+(kind=="serial"?cfg["port"].toString():(kind=="cmd"||kind=="adb"||kind=="powershell"||kind=="wsl"?QUuid::createUuid().toString(QUuid::WithoutBraces):cfg["host"].toString()+":"+QString::number(cfg["port"].toInt(kind=="ssh"?22:23))));if(kind=="ssh"){QJsonObject identity{{"user",cfg["user"]},{"command",cfg["command"]},{"interactive",cfg["interactive"]},{"jump",cfg["jump"]},{"forward",cfg["forward"]}};id+=":"+QString::fromLatin1(QCryptographicHash::hash(QJsonDocument(identity).toJson(QJsonDocument::Compact),QCryptographicHash::Sha256).toHex().left(16));}if(!sources_.contains(id)){if(sources_.size()>=128){broadcast({{"type","error"},{"message","Session resource limit reached; close unused tabs"}});return;}Source x;x.id=id;x.kind=kind;x.cfg=cfg;if(cfg["encoding"].toString()=="latin1")x.decoder=std::make_shared<QStringDecoder>(QStringDecoder::Latin1);x.retry=new QTimer(this);x.retry->setSingleShot(true);connect(x.retry,&QTimer::timeout,this,[this,id]{if(sources_.contains(id)&&sources_[id].desired)start(sources_[id]);});if(!cfg["logDirectory"].toString().isEmpty()){auto name=id;name.replace(QRegularExpression("[^A-Za-z0-9_.-]"),"_");saveTo(x,QDir(cfg["logDirectory"].toString()).filePath(name+"-"+QString::number(QDateTime::currentMSecsSinceEpoch())+".log"));}sources_.insert(id,x);}if(!sources_[id].desired){auto& existing=sources_[id];existing.retry->stop();if(!cfg["logDirectory"].toString().isEmpty()&&cfg["logDirectory"]!=existing.cfg["logDirectory"]){auto name=id;name.replace(QRegularExpression("[^A-Za-z0-9_.-]"),"_");saveTo(existing,QDir(cfg["logDirectory"].toString()).filePath(name+"-"+QString::number(QDateTime::currentMSecsSinceEpoch())+".log"));}existing.cfg=cfg;existing.attempts=0;existing.pending.clear();existing.decoder=std::make_shared<QStringDecoder>(cfg["encoding"].toString()=="latin1"?QStringDecoder::Latin1:QStringDecoder::Utf8);existing.telnet=TelnetDecoder();}
  // One physical serial port is one sheet: a second serial.connect reuses this session instead of
  // opening the port a second time (the id is serial:<port>). If the framing differs, the open
  // port has to be reopened — silently keeping 9600 while the dialog says 115200 is exactly how a
  // "the device does not answer" session is born.
  if(sources_[id].kind=="serial"&&sources_[id].desired&&sources_[id].serial&&sources_[id].serial->isOpen()){auto&y=sources_[id];const bool changed=y.cfg["baud"].toInt(115200)!=cfg["baud"].toInt(115200)||y.cfg["dataBits"].toInt(8)!=cfg["dataBits"].toInt(8)||y.cfg["stopBits"].toInt(1)!=cfg["stopBits"].toInt(1)||y.cfg["parity"].toString()!=cfg["parity"].toString()||y.cfg["flow"].toString()!=cfg["flow"].toString();if(changed){y.serial->close();flushTail(y);y.cfg=cfg;channelLog(id,QStringLiteral("--- 串口参数已改变，正在重新打开 / serial settings changed, reopening ---"));}}
  sources_[id].desired=true;broadcast({{"type","session"},{"requestId",cfg["requestId"]},{"id",id},{"label",cfg["label"].toString().isEmpty()?id:cfg["label"].toString()},{"kind",kind},{"interactive",sources_[id].cfg["interactive"].toBool()},{"readOnly",readOnlyStream(sources_[id])},{"mode",transport(sources_[id])}});start(sources_[id]);}
 // A stream whose stdin is not a command interpreter. A command written into one is either
 // swallowed by the remote program (tail -F, logcat) or lands on a process that already
 // exited (cmd /C) — the send box then looked dead with nothing reported. Those sessions get
 // an out-of-band channel instead.
 bool readOnlyStream(const Source& x)const{if(x.kind=="ssh")return !x.cfg["interactive"].toBool();if(x.kind=="adb")return true;if(x.kind=="cmd"&&!x.cfg["command"].toString().isEmpty())return true;return false;}
 // A line ending named by the UI. Null means "no opinion" and the caller keeps looking; "none"
 // is an empty (non-null) array and means the bytes go out exactly as typed.
 static QByteArray eolBytes(const QString&e){if(e=="none")return QByteArray("");if(e=="cr")return"\r";if(e=="crlf")return"\r\n";if(e=="lf")return"\n";return QByteArray();}
 // Line ending: an explicit eol field wins, then the legacy newline flag, then the line ending
 // chosen for the session in the UI, then the transport. pty wants CR, telnet wants CRLF
 // (RFC 854), serial consoles and AT-style devices terminate on CR; a bare LF is the one form
 // a device is least likely to act on.
 QByteArray eolFor(const Source& x,const QJsonObject& o)const{
  if(o.contains("eol")){const auto e=eolBytes(o["eol"].toString());if(!e.isNull())return e;}
  if(!o["newline"].toBool(true))return{};
  if(x.cfg.contains("eol")){const auto e=eolBytes(x.cfg["eol"].toString());if(!e.isNull())return e;}
  if(x.pty)return"\r";
  if(x.kind=="telnet")return"\r\n";
  if(x.kind=="serial")return"\r";
  return"\n";
 }
 QString transport(const Source& x)const{if(x.pty&&x.pty->running())return"terminal";if(x.kind=="serial")return x.serial&&x.serial->isOpen()?"serial":"serial-closed";if(x.kind=="tcp"||x.kind=="telnet")return"stream";if(readOnlyStream(x))return"exec";if(x.process&&x.process->state()==QProcess::Running)return"stdio";return"offline";}
 void channelLog(const QString& id,const QString& text){if(!sources_.contains(id))return;log(id,(text+"\n").toUtf8());}
 void runChannel(const QString& id,const QString& command){
  if(!sources_.contains(id))return;
  auto&x=sources_[id];
  if(x.chanBusy){if(x.chanQueue.size()>=32){broadcast({{"type","error"},{"session",id},{"code","queue-full"},{"message","命令队列已满（32 条），请等当前命令结束 / command queue full"}});return;}x.chanQueue<<command;broadcast({{"type","session.exec"},{"session",id},{"state","queued"},{"queued",x.chanQueue.size()}});return;}
  QString program;QStringList args;
  if(x.kind=="ssh"){
   program="ssh";args={"-n","-T","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=20","-o","ServerAliveCountMax=1","-p",QString::number(x.cfg["port"].toInt(22))};
   if(!x.cfg["key"].toString().isEmpty())args<<"-i"<<x.cfg["key"].toString();
   if(!x.cfg["jump"].toString().isEmpty())args<<"-J"<<x.cfg["jump"].toString();
   args<<(x.cfg["user"].toString()+"@"+x.cfg["host"].toString())<<command;
  }else if(x.kind=="adb"){program="adb";if(!x.cfg["adbSerial"].toString().isEmpty())args<<"-s"<<x.cfg["adbSerial"].toString();args<<"shell"<<command;}
  else if(x.kind=="cmd"){program="cmd.exe";args={"/C",command};}
  else{broadcast({{"type","error"},{"session",id},{"code","no-channel"},{"message","该会话不支持带外执行 / this session cannot run out-of-band commands"}});return;}
  if(!x.chan){
   x.chan=new QProcess(this);
   connect(x.chan,&QProcess::readyReadStandardOutput,this,[this,id]{if(sources_.contains(id))log(id,sources_[id].chan->readAllStandardOutput());});
   connect(x.chan,&QProcess::readyReadStandardError,this,[this,id]{if(sources_.contains(id))log(id,sources_[id].chan->readAllStandardError());});
   connect(x.chan,&QProcess::errorOccurred,this,[this,id](QProcess::ProcessError error){
    if(!sources_.contains(id))return;
    auto&y=sources_[id];
    const auto detail=y.chan?y.chan->errorString():QStringLiteral("unknown");
    broadcast({{"type","error"},{"session",id},{"code","channel-failed"},{"message",QString("命令执行失败：%1 / command channel failed").arg(detail)}});
    channelLog(id,QStringLiteral("--- 命令通道失败 / channel failed: ")+detail+QStringLiteral(" ---"));
    // A start failure emits only errorOccurred, so the queue has to be released here or the
    // channel stays busy forever. A crash also emits finished, which releases it there.
    if(error!=QProcess::Crashed){
     y.chanBusy=false;
     auto*used=y.chan;y.chan=nullptr;
     if(!y.chanQueue.isEmpty())runChannel(id,y.chanQueue.takeFirst());
     if(used)used->deleteLater();
    }
   });
   connect(x.chan,qOverload<int,QProcess::ExitStatus>(&QProcess::finished),this,[this,id](int code,QProcess::ExitStatus status){
    if(!sources_.contains(id))return;
    auto&y=sources_[id];
    channelLog(id,QString("--- exit %1%2 ---").arg(code).arg(status==QProcess::CrashExit?QStringLiteral(" (crashed)"):QString()));
    broadcast({{"type","session.exec"},{"session",id},{"state","done"},{"exitCode",code},{"ok",status==QProcess::NormalExit&&code==0}});
    y.chanBusy=false;
    auto*used=y.chan;y.chan=nullptr;
    if(!y.chanQueue.isEmpty())runChannel(id,y.chanQueue.takeFirst());
    if(used)used->deleteLater();
   });
  }
  x.chanBusy=true;
  channelLog(id,"$ "+command);
  broadcast({{"type","session.exec"},{"session",id},{"state","running"},{"command",command}});
  x.chan->start(program,args);
 }
 // flush() only asks the driver to take the bytes; bytesToWrite() reports what it has not taken
 // yet, and immediately after a write that number is non-zero on a perfectly healthy port, so
 // sampling it once says nothing about whether the command left the PC. Sampling it again once the
 // write has had time to complete does: a queue that has not drained means the port is holding the
 // data, which is what flow control wanting CTS, an adapter that stopped, or a missing cable look
 // like — and a device that never received the bytes cannot report that itself.
 void watchQueue(const QString& id){QTimer::singleShot(600,this,[this,id]{auto it=sources_.find(id);if(it==sources_.end())return;auto&x=*it;if(!x.serial||!x.serial->isOpen())return;const auto queued=x.serial->bytesToWrite();if(queued<=0)return;broadcast({{"type","session.queued"},{"session",id},{"queued",double(queued)},{"port",x.cfg.value("port").toString()},{"error",x.serial->error()!=QSerialPort::NoError?x.serial->errorString():QString()},{"waited",600}});});}
 void sendTo(QLocalSocket*s,const QJsonObject&o){
  const auto id=o["session"].toString();
  if(!sources_.contains(id)){send(s,{{"type","error"},{"session",id},{"code","no-session"},{"message",QString("会话 %1 不存在或已关闭，命令没有发送 / session not found").arg(id)}});return;}
  auto&x=sources_[id];
  const auto text=o["data"].toString();
  // An empty payload is not the same thing as an empty write. Pressing Enter on an empty box has
  // to send the terminator alone: that is how a serial console is woken and how a shell prints its
  // next prompt, and it is the one send a user cannot express any other way. It is refused only
  // when nothing at all would reach the wire — no text and no terminator (the session's line
  // ending is "none"), or a stream that has no stdin to take a line.
  // Raw mode is for binary transports (X/Y/ZMODEM): the payload is a whole protocol frame, so no
  // line terminator may be appended — a stray CR sits in the middle of a block and the receiver
  // NAKs every frame. It is only refused when the session has nowhere to write bytes at all.
  const bool rawMode=o["raw"].toBool();
  if(text.isEmpty()&&(readOnlyStream(x)||(!rawMode&&eolFor(x,o).isEmpty()))){send(s,{{"type","error"},{"session",id},{"code","empty"},{"message","命令为空 / empty command"}});return;}
  if(readOnlyStream(x)){
   if(!o["exec"].toBool(true)){send(s,{{"type","error"},{"session",id},{"code","read-only"},{"message","该会话是只读日志流，没有交互输入 / read-only stream has no interactive input"}});return;}
   runChannel(id,text);return;
  }
  QByteArray d;
  if(o["hex"].toBool()){auto hex=text;hex.remove(QRegularExpression("\\s+"));if(!QRegularExpression("^(?:[0-9A-Fa-f]{2})+$").match(hex).hasMatch()){send(s,{{"type","error"},{"session",id},{"code","hex"},{"message","Invalid HEX bytes"}});return;}d=QByteArray::fromHex(hex.toLatin1());}
  else d=text.toUtf8();
  if(!rawMode)d+=eolFor(x,o);
  qint64 wrote=-1;QString why;
  if(x.pty){if(x.pty->running())wrote=x.pty->write(d);else why=QStringLiteral("终端进程已结束 / terminal has exited");}
  else if(x.serial){if(x.serial->isOpen())wrote=x.serial->write(d);else why=QStringLiteral("串口未打开 / serial port is closed");}
  else if(x.tcp){if(x.tcp->state()==QAbstractSocket::ConnectedState)wrote=x.tcp->write(d);else why=QStringLiteral("网络连接已断开 / socket is not connected");}
  else if(x.process){if(x.process->state()==QProcess::Running)wrote=x.process->write(d);else why=QStringLiteral("进程已退出 / process has exited");}
  else why=QStringLiteral("会话没有可写入的通道 / no writable channel");
  if(wrote<0||wrote!=d.size()){
   send(s,{{"type","error"},{"session",id},{"code","write-failed"},{"message",QString("命令没有写入：%1").arg(why.isEmpty()?QString("仅写入 %1/%2 字节").arg(wrote).arg(d.size()):why)}});
   return;
  }
  QJsonObject sent{{"type","session.sent"},{"session",id},{"mode",transport(x)},{"bytes",double(d.size())},{"echo",text}};
  // What exactly went on the wire, including the terminator, so the UI can show it instead of
  // guessing: a serial console that answers CRLF and a device that wants CR differ by nothing
  // visible in the box the user typed into.
  // A raw frame is binary protocol data, not something to echo into the log tab: the UI only needs
  // the byte count. Sending an empty `eol` would also make the UI read the payload as text.
  if(rawMode)sent["raw"]=true;
  else if(o["hex"].toBool())sent["payload"]=QString::fromLatin1(d.toHex(' ').constData());
  else{sent["payload"]=text;sent["eol"]=eolFor(x,o).toHex(' ').constData();}
  // When the device then stays silent the user needs to know which half failed. The driver is
  // the one that can say: flush hands the bytes over, bytesToWrite() counts what the driver has
  // not taken yet (a stalled value means flow control is holding it), and error() reports a
  // framing/parity/hardware fault that the write itself does not raise.
  if(x.serial){x.serial->flush();sent["port"]=x.cfg["port"].toString();sent["framing"]=QString("%1 %2%3%4").arg(x.cfg["baud"].toInt(115200)).arg(x.cfg["dataBits"].toInt(8)).arg(x.cfg["parity"].toString()=="even"?"E":x.cfg["parity"].toString()=="odd"?"O":"N").arg(x.cfg["stopBits"].toInt(1));sent["flow"]=x.cfg["flow"].toString();sent["open"]=x.serial->isOpen();sent["queued"]=double(x.serial->bytesToWrite());if(x.serial->error()!=QSerialPort::NoError)sent["portError"]=x.serial->errorString();}
  else if(x.tcp)sent["queued"]=double(x.tcp->bytesToWrite());
  if(x.serial&&sent["queued"].toDouble()>0)watchQueue(id);
  send(s,sent);
 }
 void handle(QLocalSocket*s,const QJsonObject&o){auto t=o["type"].toString();if(t=="storage.configure"){const qint64 max=o["maxBytes"].toVariant().toLongLong();const int keep=o["retainFiles"].toInt();if(max<1024*1024||max>2LL*1024*1024*1024||keep<1||keep>20){send(s,{{"type","error"},{"message","Storage policy requires 1-2048 MiB and 1-20 retained files"}});return;}storageRoll_=max;storageKeep_=keep;for(auto&x:sources_)if(x.writer)x.writer->configure(max,keep);send(s,{{"type","storage.configured"},{"maxBytes",double(max)},{"retainFiles",keep}});return;}if(t=="session.dispose"){const auto id=o["session"].toString();if(!sources_.contains(id))return;auto &x=sources_[id];x.desired=false;x.retry->stop();x.retry->deleteLater();if(x.serial){QObject::disconnect(x.serial,nullptr,this,nullptr);x.serial->close();x.serial->deleteLater();}if(x.tcp){QObject::disconnect(x.tcp,nullptr,this,nullptr);x.tcp->abort();x.tcp->deleteLater();}if(x.process){QObject::disconnect(x.process,nullptr,this,nullptr);x.process->kill();x.process->deleteLater();}if(x.pty){x.pty->onExit=nullptr;x.pty->onError=nullptr;x.pty->onInputError=nullptr;x.pty->close();x.pty->onOutput=nullptr;x.pty->onOverflow=nullptr;x.pty->deleteLater();}if(x.chan){QObject::disconnect(x.chan,nullptr,this,nullptr);x.chan->kill();x.chan->deleteLater();}flushTail(x);if(x.writer)x.writer->shutdown();sources_.remove(id);return;}if(t=="core.metrics"){PROCESS_MEMORY_COUNTERS memory{};GetProcessMemoryInfo(GetCurrentProcess(),&memory,sizeof(memory));QJsonArray metrics;for(const auto&x:sources_)if(x.writer){auto m=x.writer->metrics();m["session"]=x.id;metrics<<m;}send(s,{{"type","core.metrics"},{"writers",metrics},{"queuedLines",queue_.size()},{"queuedBytes",double(queueBytes_)},{"receivedBytes",double(receivedBytes_)},{"residentBytes",double(memory.WorkingSetSize)},{"droppedLines",double(totalDropped_)}});return;}if(t=="core.shutdown"){for(auto&x:sources_){x.desired=false;x.retry->stop();if(x.serial)x.serial->close();if(x.tcp)x.tcp->abort();if(x.process)x.process->kill();if(x.pty)x.pty->close();if(x.chan){QObject::disconnect(x.chan,nullptr,this,nullptr);x.chan->kill();}flushTail(x);if(x.writer)x.writer->shutdown();}send(s,{{"type","core.shutdown.ready"}});s->flush();QTimer::singleShot(100,qApp,&QCoreApplication::quit);return;}if(t=="session.resize"){auto id=o["session"].toString();if(sources_.contains(id)&&sources_[id].pty)sources_[id].pty->resize(o["cols"].toInt(120),o["rows"].toInt(30));return;}if(t=="serial.connect")create("serial",o);else if(t=="ssh.connect")create("ssh",o);else if(t=="tcp.connect")create(o["telnet"].toBool()?"telnet":"tcp",o);else if(t=="cmd.connect")create("cmd",o);else if(t=="adb.connect")create("adb",o);else if(t=="powershell.connect")create("powershell",o);else if(t=="wsl.connect")create("wsl",o);else if(t=="serial.list"){QJsonArray a,devices;for(auto&p:QSerialPortInfo::availablePorts()){a<<p.portName();QJsonObject device{{"port",p.portName()},{"description",p.description()},{"manufacturer",p.manufacturer()},{"serialNumber",p.serialNumber()}};if(p.hasVendorIdentifier())device["vid"]=QString("%1").arg(p.vendorIdentifier(),4,16,QChar('0'));if(p.hasProductIdentifier())device["pid"]=QString("%1").arg(p.productIdentifier(),4,16,QChar('0'));devices<<device;}send(s,{{"type","serial.list"},{"ports",a},{"devices",devices}});}else if(t=="session.send")sendTo(s,o);else if(t=="session.mode"){
  const auto id=o["session"].toString();
  if(!sources_.contains(id)){send(s,{{"type","error"},{"session",id},{"code","no-session"},{"message","会话不存在 / session not found"}});return;}
  auto&x=sources_[id];
  if(x.kind!="ssh"){send(s,{{"type","error"},{"session",id},{"code","not-ssh"},{"message","只有 SSH 会话可以在交互终端与日志流之间切换 / only SSH sessions switch mode"}});return;}
  const bool interactive=o["interactive"].toBool();
  if(x.cfg["interactive"].toBool()==interactive){send(s,{{"type","session.mode"},{"session",id},{"interactive",interactive},{"readOnly",readOnlyStream(x)},{"mode",transport(x)}});return;}
  x.retry->stop();
  if(x.process){QObject::disconnect(x.process,nullptr,this,nullptr);x.process->kill();x.process->deleteLater();x.process=nullptr;}
  if(x.pty){x.pty->onExit=nullptr;x.pty->onError=nullptr;x.pty->onInputError=nullptr;x.pty->onOutput=nullptr;x.pty->onOverflow=nullptr;x.pty->close();x.pty->deleteLater();x.pty=nullptr;}
  if(x.chan){QObject::disconnect(x.chan,nullptr,this,nullptr);x.chan->kill();x.chan->deleteLater();x.chan=nullptr;x.chanBusy=false;x.chanQueue.clear();}
  x.cfg["interactive"]=interactive;
  if(interactive)x.cfg["command"]="";
  else if(x.cfg["command"].toString().isEmpty())x.cfg["command"]="tail -F /var/log/syslog";
  x.desired=true;x.attempts=0;
  channelLog(id,interactive?QStringLiteral("--- 已切换为交互终端 / switched to interactive shell ---"):QStringLiteral("--- 已切换为日志流 / switched to log stream ---"));
  start(x);
  broadcast({{"type","session.mode"},{"session",id},{"interactive",interactive},{"readOnly",readOnlyStream(x)},{"mode",transport(x)}});
}else if(t=="session.eol"){
  const auto id=o["session"].toString();
  if(!sources_.contains(id)){send(s,{{"type","error"},{"session",id},{"code","no-session"},{"message","会话不存在 / session not found"}});return;}
  const auto eol=o["eol"].toString();
  if(eol!="auto"&&eol!="cr"&&eol!="lf"&&eol!="crlf"&&eol!="none"){send(s,{{"type","error"},{"session",id},{"code","bad-eol"},{"message","行尾只能是 auto/cr/lf/crlf/none / eol must be auto, cr, lf, crlf or none"}});return;}
  auto&x=sources_[id];
  // Kept in cfg so the choice survives a reconnect: reconnect reuses this same Source.
  if(eol=="auto")x.cfg.remove("eol");else x.cfg["eol"]=eol;
  channelLog(id,QStringLiteral("--- 发送行尾 / line ending: ")+eol+QStringLiteral(" ---"));
  broadcast({{"type","session.eol"},{"session",id},{"eol",eol}});
}else if(t=="session.close"&&sources_.contains(o["session"].toString())){auto&x=sources_[o["session"].toString()];x.desired=false;x.retry->stop();if(x.serial)x.serial->close();if(x.tcp)x.tcp->disconnectFromHost();if(x.process)x.process->kill();if(x.pty)x.pty->close();if(x.chan){QObject::disconnect(x.chan,nullptr,this,nullptr);x.chan->kill();x.chan->deleteLater();x.chan=nullptr;x.chanBusy=false;x.chanQueue.clear();}flushTail(x);state(x,"closed");}else if(t=="save.start"&&sources_.contains(o["session"].toString())){auto&x=sources_[o["session"].toString()];const auto requested=o["maxBytes"].toVariant().toLongLong();saveTo(x,o["path"].toString(),requested>0?requested:ROLL_BYTES);}else if(t=="local.analyze"){auto q=redact(o["text"].toString());QString advice;const auto found=diagnoseAll(q,&advice);send(s,{{"type","local.analysis"},{"result",found.isEmpty()?"未命中内置规则；请检查错误频次、上下文与关联会话。":QStringLiteral("事件/异常命中（类别 × 次数）：")+found+(advice.isEmpty()?"":QStringLiteral("\n")+advice)},{"redacted",q}});}}
 public:~Core(){
  // A QLocalSocket emits disconnected() from its own destructor, and QProcess/QTimer emit
  // on the way out too. Qt deletes those children only after this object's members are gone,
  // so a handler left connected would look itself up in a freed sources_ or remove itself
  // from a freed buffers_. Retire the transport and every session signal while the
  // containers are still valid.
  for(auto*s:clients_)QObject::disconnect(s,nullptr,this,nullptr);
  for(auto&x:sources_){QObject::disconnect(x.retry,nullptr,this,nullptr);QObject::disconnect(x.serial,nullptr,this,nullptr);QObject::disconnect(x.tcp,nullptr,this,nullptr);QObject::disconnect(x.process,nullptr,this,nullptr);QObject::disconnect(x.chan,nullptr,this,nullptr);if(x.pty){x.pty->onExit=nullptr;x.pty->onError=nullptr;x.pty->onInputError=nullptr;x.pty->close();x.pty->onOutput=nullptr;x.pty->onOverflow=nullptr;}if(x.writer)x.writer->shutdown();}
  for(auto*s:clients_)delete s;
  clients_.clear();buffers_.clear();ipcDropped_.clear();
 }
 Core(){const auto pipe=qEnvironmentVariable("LOGSCOPE_PIPE","LogScopeCore");server_.setSocketOptions(QLocalServer::UserAccessOption);if(!server_.listen(pipe)){QTimer::singleShot(0,qApp,&QCoreApplication::quit);return;}connect(&server_,&QLocalServer::newConnection,this,[this]{while(server_.hasPendingConnections()){auto*s=server_.nextPendingConnection();clients_<<s;orphan_.stop();auto consume=[this,s]{if(!clients_.contains(s))return;auto&b=buffers_[s];b+=s->readAll();if(b.size()>1024*1024){s->disconnectFromServer();return;}for(;;){const auto n=b.indexOf('\n');if(n<0)break;auto line=b.left(n);b.remove(0,n+1);auto d=QJsonDocument::fromJson(line);if(d.isObject())handle(s,d.object());if(!clients_.contains(s))return;}};connect(s,&QLocalSocket::readyRead,this,consume);consume();QTimer::singleShot(0,s,consume);connect(s,&QLocalSocket::disconnected,this,[this,s]{clients_.removeAll(s);buffers_.remove(s);ipcDropped_.remove(s);s->deleteLater();if(clients_.isEmpty())orphan_.start();});send(s,{{"type","status"},{"message","C++ 采集核心已连接"}});}});flush_.setInterval(40);connect(&flush_,&QTimer::timeout,this,[this]{if(!queue_.isEmpty()){auto b=std::exchange(queue_,{});queueBytes_=0;for(auto&o:b)broadcast(o);}if(dropped_){broadcast({{"type","warning"},{"message",QString("采集队列已满，丢弃 %1 行").arg(dropped_)}});dropped_=0;}});flush_.start();orphan_.setSingleShot(true);orphan_.setInterval(12000);connect(&orphan_,&QTimer::timeout,this,[this]{if(clients_.isEmpty())QCoreApplication::quit();});}};
int main(int argc,char**argv){
 AddVectoredExceptionHandler(1,&crashFilter);
 // Keep children in a kill-on-close job so a crashed desktop cannot orphan shells.
 HANDLE job=CreateJobObjectW(nullptr,nullptr);if(job){JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))||!AssignProcessToJobObject(job,GetCurrentProcess())){CloseHandle(job);job=nullptr;}}
 QCoreApplication a(argc,argv);Core c;return a.exec();
}
