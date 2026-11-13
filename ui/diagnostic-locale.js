'use strict';
const diagnosticTranslations={
 'Memory exhausted: inspect heap, allocation rate and limits.':'内存不足：检查堆内存、分配速率和资源限制。',
 'Timeout: inspect latency, downstream health and retry settings.':'请求超时：检查延迟、下游状态和重试设置。',
 'Connection refused: inspect listener, port and firewall.':'连接被拒绝：检查监听服务、端口和防火墙。',
 'Permission failure: inspect account, resource permissions and credentials.':'权限错误：检查账户、资源权限和凭据。',
 'Disk full: inspect free space, retention and rotation.':'磁盘空间不足：检查剩余容量、保留策略和日志轮转。',
 'Warning detected: inspect nearby events, retry counts and device state.':'检测到警告：检查邻近事件、重试次数和设备状态。',
 'Error detected: inspect surrounding logs and related sessions.':'检测到异常：检查上下文日志和相关会话。'
};
const diagnoseBeforeLocale=LogAnalysis.diagnose;LogAnalysis.diagnose=row=>{const text=diagnoseBeforeLocale(row);return enUI()?text:diagnosticTranslations[text]||text};
