# Backslash 安全边界

## 适用部署

当前实现面向**可信管理员维护的单机或局域网服务**。Web 与 Socket.IO 可对受控网段开放；数据库、项目目录、TeX 临时目录、内部授权端口和内部事件端口不得直接暴露。

“关闭 shell escape”不等于把任意 TeX 源码变成安全内容。TeX 是复杂解释器，仍可能消耗大量 CPU/RAM/磁盘，并可能读取运行账户可读的 TeX 搜索路径或文件。需要接收不可信互联网用户源码时，应把整个服务或至少编译进程放入独立低权限账户、虚拟机/容器或其他操作系统级沙箱，并配置资源配额。

## 身份、会话与密钥

- `SESSION_SECRET` 和 `BACKSLASH_INTERNAL_SERVICE_KEY` 均要求至少 32 字符，且必须互不相同、长期稳定。
- 会话令牌只通过 HttpOnly cookie 使用；登录和注册响应不再返回令牌正文，普通 Web API 不接受 Bearer 会话令牌。
- API key 只保存哈希；使用计数在内存聚合后批量持久化，进程退出前尽力 flush。
- 密码重置令牌通过条件更新原子消费；修改密码会撤销该用户的既有会话。
- 登录、注册、忘记密码、重置密码和 AI 修复接口有进程内限流。多实例部署需要把限流迁移到共享存储。
- 只有在可信反向代理会删除并重写客户端转发头时才设置 `TRUST_PROXY_HEADERS=true`。
- HTTPS 部署设置 `SECURE_COOKIES=true`，并把 `APP_URL` 设为唯一外部来源。

## 实时服务

- Web 授权服务绑定 `127.0.0.1:${WEB_INTERNAL_PORT}`，只接受 `POST /authorize`。
- WS 事件服务绑定 `127.0.0.1:${WS_INTERNAL_PORT}`，只接受 `POST /events`。
- 内部请求使用共享密钥并通过常量时间比较校验；请求体上限为 64 KiB。
- Socket.IO 默认只接受 `CORS_ORIGIN`/`APP_URL` 指定的来源，消息缓冲限制为 512 KiB，并对聊天、光标、选区和文档变更做大小/频率限制。
- `WS_HOST` 默认 `0.0.0.0`；通过主机防火墙限制可访问网段。

## 路径、上传与下载

- 项目相对路径通过 `path.resolve`/`path.relative` 约束在项目根目录。
- 文件读写和上传拒绝绝对路径、`..`、隐藏路径片段和已有 symlink/junction 路径。
- 上传先检查 `Content-Length`，再校验文件数、单文件、批次和项目总容量；写入使用临时文件加原子 rename。
- Next.js `request.formData()` 仍会缓冲 multipart 请求。没有 `Content-Length` 的分块大请求不能在解析前完全阻断，因此应在反向代理同时配置请求体上限。
- PDF、图片和 ZIP 使用流式响应；公开 API 不返回服务器绝对路径。

## 编译进程

- 使用 `child_process.spawn` 且 `shell:false`；用户不能注入原始命令行。
- 所有 `latexmk` 调用强制 `-norc`，不执行系统、用户或项目里的 `latexmkrc` Perl 配置。
- `LATEX_ALLOW_SHELL_ESCAPE=false` 时显式传递 `-no-shell-escape`。
- 编译环境把 `HOME`、`TEXMFOUTPUT` 指向隔离目录，并设置更严格的 `openin_any/openout_any`；这仍不是完整沙箱。
- 每次项目编译复制到独立工作目录；超时/取消会终止进程树，完成后删除工作目录。
- 等待队列有硬上限；日志内存、数据库日志、项目大小、PDF 大小、超时、历史记录和产物保留均有边界。
- 建议以专用非管理员系统账户运行，限制其文件权限，并用 OS/job/container 级 CPU、内存、进程数和磁盘配额防止资源耗尽。

## AI 出站请求

- AI endpoint 只允许 HTTP/HTTPS，不允许 URL 内嵌凭据。
- 默认解析 DNS 并拒绝 loopback、私网、链路本地、文档网段和保留地址；响应体限制 2 MiB，超时 45 秒，HTTP 重定向被禁止。
- 局域网 AI 服务必须由管理员显式设置 `AI_ALLOW_PRIVATE_ENDPOINTS=true`。这会扩大 SSRF 风险，应配合出站防火墙/允许列表。
- DNS 校验与实际连接之间仍存在理论上的 DNS rebinding 时间窗；高风险部署应通过网络出口策略把 Web 进程只能访问明确允许的 AI 主机。

## 公开分享

公开分享令牌等同于项目访问凭据。分享响应可包含项目文件和构建日志，但不会包含服务器绝对路径。撤销分享后旧令牌失效；不要把分享链接发布到不可信场所。

## 发布配置保护

- `CORS_ORIGIN=*` 默认拒绝启动；只有同时设置 `CORS_ALLOW_ANY_ORIGIN_ACKNOWLEDGE_RISK=true` 才会接受。局域网部署仍应填写浏览器实际访问的精确 Origin。
- `LATEX_ALLOW_SHELL_ESCAPE=true` 默认拒绝启动；只有同时设置 `LATEX_SHELL_ESCAPE_ACKNOWLEDGE_RISK=true` 才会接受。该确认变量不是安全措施，只是防止误配置。
- Web→WS 内部构建事件默认允许 4 MiB，以容纳有界构建日志；可通过 `WS_INTERNAL_MAX_BODY_BYTES` 调整，范围为 64 KiB–16 MiB。内部端口必须保持在 loopback。
- 协作者权限、公开链接设置或项目删除发生变化时，Web 会要求 WS 立即重新鉴权；WS 也按 `WS_ACCESS_REVALIDATE_INTERVAL_MS`（默认 60 秒）周期性复核已连接客户端，以处理权限到期和遗漏事件。Web 内部鉴权暂时不可用时保留连接并在下一周期重试，明确返回无权限时立即断开。
- 同一 Socket.IO 连接只能维持一种身份模式。登录账户、其他账户与匿名分享访问之间切换时必须重连，防止身份跨项目泄露。
