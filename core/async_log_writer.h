#pragma once
#include <QFile>
#include <QFileInfo>
#include <QStorageInfo>
#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <memory>
// QFile is created, used and destroyed exclusively by this writer's thread.
class AsyncLogWriter final {
 struct Task { enum Kind {Open,Data,Flush,Policy} kind; QByteArray bytes; QString path; qint64 roll=50LL*1024*1024; int keep=2; };
 std::mutex mutex_;std::condition_variable ready_;std::deque<Task> tasks_;bool stopping_=false;
 std::function<void(const QString&)> error_;std::unique_ptr<QFile> file_;QString marker_;qint64 roll_=50LL*1024*1024;int keep_=2;
 inline static std::atomic<quint64> globalQueued_{0};
 std::atomic<quint64> queued_{0},written_{0},dropped_{0};std::atomic<bool> failed_{false};std::thread thread_;
 void fail(const QString& text){failed_=true;if(error_)error_(text);}
 void removeMarker(){if(!marker_.isEmpty()){QFile::remove(marker_);marker_.clear();}}
 void flushFile(){if(file_&&file_->isOpen()&&!file_->flush())fail("Log flush failed: "+file_->errorString());}
 bool rotate(){const auto path=file_->fileName();flushFile();file_->close();for(int i=keep_+1;i<=20;i++){const auto extra=path+"."+QString::number(i);if(QFile::exists(extra)&&!QFile::remove(extra)){fail("Cannot remove expired rotated log: "+extra);file_->open(QIODevice::WriteOnly|QIODevice::Append);return false;}}const auto oldest=path+"."+QString::number(keep_);if(QFile::exists(oldest)&&!QFile::remove(oldest)){fail("Cannot remove oldest rotated log: "+oldest);file_->open(QIODevice::WriteOnly|QIODevice::Append);return false;}for(int i=keep_-1;i>=1;--i){const auto from=path+"."+QString::number(i);if(QFile::exists(from)&&!QFile::rename(from,path+"."+QString::number(i+1))){fail("Cannot rotate log: "+from);file_->open(QIODevice::WriteOnly|QIODevice::Append);return false;}}if(!QFile::rename(path,path+".1")||!file_->open(QIODevice::WriteOnly|QIODevice::Append)){fail("Cannot rotate active log: "+path);return false;}return true;}
 void open(const Task& task){if(file_&&file_->isOpen()&&file_->fileName()==task.path){roll_=task.roll;keep_=task.keep;return;}auto candidate=std::make_unique<QFile>(task.path);if(!candidate->open(QIODevice::WriteOnly|QIODevice::Append)){fail("Cannot change log file; previous recording retained: "+candidate->errorString());return;}flushFile();removeMarker();file_=std::move(candidate);roll_=task.roll;keep_=task.keep;failed_=false;marker_=task.path+".active";QFile marker(marker_);if(marker.open(QIODevice::WriteOnly)){marker.write(QJsonDocument(QJsonObject{{"path",task.path},{"started",QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)}}).toJson(QJsonDocument::Compact));marker.flush();}else fail("Cannot write recovery marker: "+marker.errorString());}
 void write(const QByteArray& bytes){if(!file_||!file_->isOpen()){dropped_+=bytes.size();return;}if(file_->size()+bytes.size()>roll_&&!rotate()){dropped_+=bytes.size();return;}qint64 at=0;while(at<bytes.size()){const auto n=file_->write(bytes.constData()+at,bytes.size()-at);if(n<=0){dropped_+=bytes.size()-at;fail("Log write failed (check disk space): "+file_->errorString());file_->close();return;}at+=n;written_+=n;}}
 void run(){auto lastFlush=std::chrono::steady_clock::now();for(;;){Task task;bool hasTask=false;{std::unique_lock lock(mutex_);ready_.wait_for(lock,std::chrono::milliseconds(250),[this]{return stopping_||!tasks_.empty();});if(!tasks_.empty()){task=std::move(tasks_.front());tasks_.pop_front();hasTask=true;}else if(stopping_)break;}if(hasTask){if(task.kind==Task::Open)open(task);else if(task.kind==Task::Data){write(task.bytes);queued_-=task.bytes.size();globalQueued_-=task.bytes.size();}else if(task.kind==Task::Policy){roll_=task.roll;keep_=task.keep;}else flushFile();}const auto now=std::chrono::steady_clock::now();if(now-lastFlush>=std::chrono::seconds(1)){flushFile();lastFlush=now;if(file_&&file_->isOpen()){QStorageInfo disk(QFileInfo(file_->fileName()).absolutePath());if(disk.isValid()&&disk.bytesAvailable()<16LL*1024*1024&&!failed_)fail("Log disk space is below 16 MiB; choose another save directory");}}}flushFile();if(!failed_)removeMarker();file_.reset();}
 bool enqueue(Task task){std::lock_guard lock(mutex_);if(stopping_||tasks_.size()>=4096||queued_+task.bytes.size()>16*1024*1024){if(task.kind==Task::Data)dropped_+=task.bytes.size();if(!failed_.exchange(true)&&error_)error_("Log writer queue full: raw bytes dropped; reduce capture rate or use faster storage");return false;}auto total=globalQueued_.load();do{if(total+task.bytes.size()>64*1024*1024){dropped_+=task.bytes.size();if(!failed_.exchange(true)&&error_)error_("Global raw writer queue full: bytes dropped; use faster storage or reduce capture rate");return false;}}while(!globalQueued_.compare_exchange_weak(total,total+task.bytes.size()));queued_+=task.bytes.size();tasks_.push_back(std::move(task));ready_.notify_one();return true;}
public:
 explicit AsyncLogWriter(std::function<void(const QString&)> error):error_(std::move(error)),thread_([this]{run();}){}
 ~AsyncLogWriter(){shutdown();}
 bool setPath(const QString& path,qint64 roll,int keep=2){return enqueue({Task::Open,{},path,qMax<qint64>(1024,roll),qBound(1,keep,20)});}
 void configure(qint64 roll,int keep){enqueue({Task::Policy,{},{},roll,keep});}
 void append(const QByteArray& bytes){enqueue({Task::Data,bytes});}
 void flush(){enqueue({Task::Flush});}
 void shutdown(){{std::lock_guard lock(mutex_);stopping_=true;}ready_.notify_one();if(thread_.joinable())thread_.join();}
 QJsonObject metrics()const{return {{"queuedBytes",double(queued_.load())},{"writtenBytes",double(written_.load())},{"droppedBytes",double(dropped_.load())},{"writeError",failed_.load()}};}
};
