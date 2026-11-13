#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <QObject>
#include <QTimer>
#include <QByteArray>
#include <QStringList>
#include <thread>
#include <mutex>
#include <functional>
#include <vector>

class PtyProcess:public QObject {
 HPCON console_=nullptr;HANDLE input_=nullptr,output_=nullptr,process_=nullptr;
 std::thread reader_;std::mutex mutex_;QByteArray buffer_;QTimer poll_;bool running_=false;quint64 dropped_=0;
 static std::wstring quoted(const QString& value){
  std::wstring result=L"\"";int slashes=0;
  for(wchar_t c:value.toStdWString()){if(c==L'\\'){++slashes;continue;}
   if(c==L'"')result.append(slashes*2+1,L'\\');else result.append(slashes,L'\\');
   slashes=0;result+=c;}
  result.append(slashes*2,L'\\');return result+L"\"";
 }
 QByteArray drain(){std::lock_guard<std::mutex> guard(mutex_);QByteArray b;buffer_.swap(b);return b;}
public:
 std::function<void(const QByteArray&)> onOutput;
 std::function<void()> onExit;
 std::function<void(const QString&)> onError;
 // Input-side failures are separate from start failures: they must not be reported as a
 // session error, because the UI refuses further sends while a session is in that state.
 std::function<void(const QString&)> onInputError;
 std::function<void(quint64)> onOverflow;
 explicit PtyProcess(QObject* parent=nullptr):QObject(parent){
  poll_.setInterval(20);connect(&poll_,&QTimer::timeout,this,[this]{
   quint64 lost=0;{std::lock_guard<std::mutex> guard(mutex_);lost=dropped_;dropped_=0;}if(lost&&onOverflow)onOverflow(lost);
   auto b=drain();if(!b.isEmpty()&&onOutput)onOutput(b);
   if(process_&&WaitForSingleObject(process_,0)==WAIT_OBJECT_0){close();b=drain();if(!b.isEmpty()&&onOutput)onOutput(b);if(onExit)onExit();}
  });
 }
 ~PtyProcess(){close();}
 bool running()const{return running_;}
 bool start(const QString& executable,const QStringList& args){
  close();HANDLE inRead=nullptr,outWrite=nullptr;
  auto fail=[&](){const auto error=GetLastError();if(inRead)CloseHandle(inRead);if(outWrite)CloseHandle(outWrite);close();if(onError)onError(QString("ConPTY error %1").arg(error));return false;};
  if(!CreatePipe(&inRead,&input_,nullptr,0)||!CreatePipe(&output_,&outWrite,nullptr,0))return fail();
  if(FAILED(CreatePseudoConsole({120,30},inRead,outWrite,0,&console_)))return fail();
  STARTUPINFOEXW info{};info.StartupInfo.cb=sizeof(info);info.StartupInfo.dwFlags=STARTF_USESTDHANDLES;SIZE_T size=0;
  InitializeProcThreadAttributeList(nullptr,1,0,&size);std::vector<unsigned char> storage(size);
  info.lpAttributeList=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if(!InitializeProcThreadAttributeList(info.lpAttributeList,1,0,&size))return fail();
  if(!UpdateProcThreadAttribute(info.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,console_,sizeof(console_),nullptr,nullptr)){DeleteProcThreadAttributeList(info.lpAttributeList);return fail();}
  auto command=quoted(executable);for(const auto& a:args)command+=L" "+quoted(a);
  PROCESS_INFORMATION pi{};
  const BOOL result=CreateProcessW(nullptr,command.data(),nullptr,nullptr,FALSE,EXTENDED_STARTUPINFO_PRESENT,nullptr,nullptr,&info.StartupInfo,&pi);
  DeleteProcThreadAttributeList(info.lpAttributeList);
  CloseHandle(inRead);inRead=nullptr;CloseHandle(outWrite);outWrite=nullptr;
  if(!result)return fail();
  process_=pi.hProcess;CloseHandle(pi.hThread);running_=true;
  reader_=std::thread([this]{char bytes[16384];DWORD n;while(ReadFile(output_,bytes,sizeof(bytes),&n,nullptr)&&n){std::lock_guard<std::mutex> guard(mutex_);if(buffer_.size()+int(n)>4*1024*1024){const auto lost=buffer_.size()+int(n)-4*1024*1024;dropped_+=lost;buffer_.remove(0,lost);}buffer_.append(bytes,int(n));}});
  poll_.start();return true;
 }
 // ConPTY input goes out in bounded chunks. Rejecting anything over 4096 bytes used to lose
 // the whole paste and, through the old error path, disable the send box until a reconnect.
 qint64 write(const QByteArray& data){
  if(!input_||!running_)return -1;
  qint64 total=0;
  while(total<data.size()){
   const DWORD chunk=DWORD(qMin<qint64>(4096,data.size()-total));
   DWORD done=0;
   if(!WriteFile(input_,data.constData()+total,chunk,&done,nullptr)||done!=chunk){if(onInputError)onInputError(QStringLiteral("Terminal input could not be written completely"));return total>0?total:-1;}
   total+=done;
  }
  return total;
 }
 void resize(int cols,int rows){if(console_)ResizePseudoConsole(console_,{SHORT(qBound(20,cols,500)),SHORT(qBound(5,rows,200))});}
 void close(){
  poll_.stop();running_=false;
  if(process_){if(WaitForSingleObject(process_,0)==WAIT_TIMEOUT)TerminateProcess(process_,0);CloseHandle(process_);process_=nullptr;}
  if(console_){ClosePseudoConsole(console_);console_=nullptr;}
  if(input_){CloseHandle(input_);input_=nullptr;}
  if(reader_.joinable())reader_.join();
  if(output_){CloseHandle(output_);output_=nullptr;}
  auto remaining=drain();if(!remaining.isEmpty()&&onOutput)onOutput(remaining);
 }
};
