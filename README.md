# LogScope

LogScope 是一个面向设备日志采集与分析的 Windows 桌面工具。它由 C++/Qt 6 采集核心和 Electron 前端组成，核心通过本机命名管道与界面通信。

## 功能

- SSH、Telnet、TCP、串口、本地命令行和 ADB 日志采集
- 原始日志落盘、断线恢复、写入队列和磁盘状态监控
- 虚拟滚动、搜索、正则过滤、书签和跨会话关联
- 结构化日志解析、超长行有界解析、规则处理和异常聚合
- 多会话、分屏、离线回放、时间轴和证据定位
- SFTP 文件管理，以及 XMODEM、YMODEM、ZMODEM 传输
- 日志对比、报告导出和本地知识库检索
- 可配置的云端 AI 服务商，以及免费的本地 Ollama 模型入口

## AI 服务配置

界面支持 OpenAI、DeepSeek、Moonshot、智谱 GLM、阿里云通义千问、硅基流动和任意 OpenAI 兼容接口。智谱 GLM 预设提供免费模型候选，硅基流动预设列出部分免费候选；免费额度和模型可用性以服务商公开政策为准。

云端分析默认关闭。发送前需要同时启用云端 AI 和脱敏出网，并确认脱敏预览。API 密钥经 Electron `safeStorage` 加密保存，仅主进程读取；请求使用 HTTPS、`store:false` 和 60 秒超时。

如果不想使用云端服务，可在“本机模型”中配置 Ollama。应用只接受 `127.0.0.1` 或 `[::1]` 上的 `/api/generate` 接口。应用不会安装模型，也不会代替用户确认 Ollama 自身的联网策略。

## 目录

```text
.
├── core/                 C++/Qt 6 采集核心
├── ui/                   Electron 前端
│   ├── assets/           应用图标与图标生成脚本
│   ├── package.json      前端依赖与打包配置
│   └── package-lock.json 依赖锁定文件
└── README.md
```

## 构建

环境要求：

- Windows 10 1809+ 或 Windows 11，x64
- Visual Studio 2022 的 MSVC C++ 工具链
- CMake 3.21+
- Qt 6.5+，包含 Core、Network、SerialPort 和对应的 MSVC 64 位组件
- Node.js 20+

构建采集核心：

```powershell
cmake -S core -B core/build -G "Visual Studio 17 2022" -A x64 -DCMAKE_PREFIX_PATH=C:/Qt/6.8.3/msvc2022_64
cmake --build core/build --config Release
```

启动前端：

```powershell
cd ui
npm ci
npm run dev
```

前端开发模式会从 `core/build/Release/LogScopeCore.exe` 启动采集核心。

生成 Windows 安装包：

```powershell
cd ui
npm run package
```

SSH 和 SFTP 使用系统 OpenSSH 客户端，ADB 会话使用 `PATH` 中的 `adb.exe`。这两项没有随应用捆绑。

## 数据说明

原始日志和本地缓存可能包含敏感信息，不会全部自动脱敏。请自行选择可信的保存目录，并在接入第三方模型前检查脱敏预览和服务商的数据处理政策。
