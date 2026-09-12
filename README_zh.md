# Backslash

一个可自托管的浏览器端 LaTeX 工作区，支持实时 PDF 预览、项目协作与 REST API。本版本直接使用主机上的 TeX Live 安装，应用数据存储在本地 SQLite 数据库中，无需 Docker。

## 功能特性

- 项目与模板管理、文件树、上传、重命名、删除以及 ZIP 导出。
- 使用主机原生 TeX Live 进行编译，支持 `auto`、`pdflatex`、`xelatex` 或 `latex`。
- 有界、可取消的进程内编译队列，提供结构化日志与构建历史。
- 懒加载 PDF 页面渲染、Range 请求，以及流式文件/PDF 下载。
- 基于 API 密钥的一次性 TeX 编译与项目 REST API（位于 `/api/v1`）。
- Socket.IO 协作功能：在线状态、光标、聊天、文件事件与构建更新。
- 会话认证、项目共享、公开分享链接、标签，以及可选的 AI 辅助构建修复与 LaTeX 写作。
- 通过 `better-sqlite3` 13.x 与 Drizzle 实现原生 SQLite 持久化，支持 WAL 模式与事务性 schema 升级。
- 对请求体、上传、项目存储、编译队列、日志、输出文件、会话与项目数量实施资源限制。

## 架构

```text
Browser
  ├─ HTTP       → apps/web (Next.js、SQLite、存储、编译调度)
  └─ Socket.IO  → apps/ws  (在线状态、光标、聊天、协作事件)

apps/ws  ── POST 127.0.0.1:WEB_INTERNAL_PORT/authorize ──→ apps/web
apps/web ── POST 127.0.0.1:WS_INTERNAL_PORT/events ──────→ apps/ws
```

只有 `apps/web` 进程被允许读写 `backslash.db`。`apps/ws` 不会打开数据库或修改项目文件。两个服务通过受 `BACKSLASH_INTERNAL_SERVICE_KEY` 保护的两个仅回环 HTTP 端点进行通信。

若 WebSocket 服务不可用，HTTP API 仍可正常工作，编辑器会回退到轮询以收敛构建状态。

### 部署模型

当前的持久化、锁定、限流、上传槽位与编译队列设计假定**只有一个可写的 Web 进程**。请勿对同一 SQLite 数据库与存储目录运行多个 Next.js 写进程、PM2 集群 worker 或多个主机。

本仓库未对生产环境容量做出任何声明。默认配置最多同时运行两个 TeX 进程，并在固定上限内对额外任务进行排队。在修改默认值之前，请先在目标主机上测量 Web 进程、SQLite/WAL 活动、TeX 子进程内存、队列延迟与磁盘 I/O。

## 系统要求

- Node.js `>=22.5.0`（推荐 Node.js 24 LTS）
- pnpm 10.x（CI 基线）
- 近期的 TeX Live 安装，并包含 `latexmk`
- `pdfLaTeX` 和/或 `XeLaTeX`
- 若文档使用基于 Biber 的参考文献，则需要 Biber
- 用于启动与验证脚本的 Bash

本原生主机版本有意不暴露 LuaLaTeX。在没有操作系统沙箱的情况下，LuaTeX 的文件访问无法像受支持的引擎那样可靠地隔离。Unicode 与系统字体工作流请使用 XeLaTeX。

## 快速开始

### 1. 创建环境文件

通用主机：

```bash
cp .env.example .env
```

Windows 主机使用 Windows 专用示例：

```bash
cp .env.windows.example .env
```

至少需要配置两个相互独立的高熵密钥：

```env
BACKSLASH_INTERNAL_SERVICE_KEY=<独立的随机值>
SESSION_SECRET=<另一个不同的独立随机值>

APP_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
STORAGE_PATH=./data

# 当 latexmk 已在 PATH 中可用时保持为空。
LATEXMK_PATH=
```

分别生成每个密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

若进行局域网部署，请将 `APP_URL` 与 `CORS_ORIGIN` 设置为浏览器可见的源，例如 `http://192.168.1.20:3000`。

### 2. 安装依赖

```bash
corepack enable
pnpm install --frozen-lockfile
```

### 3. 构建并启动

生产模式：

```bash
pnpm --filter @backslash/web build
pnpm --filter @backslash/ws build
bash scripts/start.sh
```

开发模式：

```bash
BACKSLASH_MODE=development bash scripts/start.sh
```

启动脚本会验证运行时、共享服务密钥与端口；启动 Web 服务；等待内部授权端点就绪；然后启动 WebSocket 服务。

### 部署协议与 HTTPS

默认部署协议为 HTTP。这是最简单的选项，不需要域名、Caddy、证书、win-acme 或 DNS 提供商：

```env
BACKSLASH_PROTOCOL=http
APP_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
```

仅在已配置 HTTPS 时才设置 `BACKSLASH_PROTOCOL=https`。本项目使用 Caddy 作为本地 TLS 反向代理：Caddy 终止 TLS，将 Web 请求转发到本地 Next.js 端口，将 `/ws/*` 转发到本地 WebSocket 端口。从 `.env.example` 或 `.env.windows.example` 复制相应值后，配置以下字段：

```env
BACKSLASH_PROTOCOL=https
BACKSLASH_HOST=your-domain.example
HTTPS_PORT=443
CADDY_PATH=/path/to/caddy
CADDY_CONFIG=
CADDY_ADAPTER=json
CERTIFICATE_FILE=./.certificates/production/your-domain.example-chain.pem
PRIVATE_KEY_FILE=./.certificates/production/your-domain.example-key.pem
```

以 `./` 开头的路径相对于项目根目录解析。当 `caddy` 已在 `PATH` 中时，`CADDY_PATH` 可留空。若请求 HTTPS 但 Caddy、其配置、证书链或私钥不可用，启动时会打印警告并回退到 HTTP；HTTP 部署不需要 HTTPS 相关依赖。

支持三种 HTTPS 边界：

1. **仅 HTTP：** 配置 `BACKSLASH_PROTOCOL=http`。无需证书或 ACME 工具。
2. **已有证书：** 配置 `BACKSLASH_PROTOCOL=https`、Caddy、`CERTIFICATE_FILE` 与 `PRIVATE_KEY_FILE`。无需 win-acme、腾讯云凭证或自动续期。
3. **自动 ACME 签发与续期：** 将 `config/acme.example.json` 复制为被忽略的本地文件 `.acme.json`，填入自己的域名、win-acme 路径、证书目录与 DNS 提供商字段，然后运行 `scripts/request-certificate.ps1`。此为可选项，不属于正常应用启动流程。

自动签发需要域名的 DNS 由所选提供商管理。普通证书可使用 HTTP-01 验证，而 `*.your-domain.example` 这类通配符证书需要 DNS-01 验证。DNS-01 会临时在 `_acme-challenge` 下创建 TXT 记录。附带的 ACME 脚本目前实现了腾讯 DNS 验证；若需要 HTTP-01 或其他 DNS 提供商，请在本项目外选择其他 ACME 客户端。请勿提交 `.acme.json`、API 密钥、证书文件或私钥。

ACME 模板还包含可选的 `caddyPath`、`caddyConfig`、`caddyAdapter`、`httpsPort` 以及用于续期重载的 upstream 字段。它说明了 `wacsPath`、`domains`、`commonName`、`validation`、`tencent.apiId`、`tencent.apiKey`、`directory`、`pemFileName`、`reloadScript` 与 `createRenewalTask`。除非你有意选择腾讯 DNS 验证，否则请保持腾讯相关字段未使用。若已有证书，直接配置其路径即可，不必仅为模板存在而安装 win-acme。

`https://127.0.0.1` 仅在配置的代理提供证书回退时才能建立 TLS，但域名的公共证书不会将 `127.0.0.1` 作为证书名称包含在内。因此浏览器会对主机名发出警告；正常访问请使用证书所覆盖的域名。

在 HTTP 模式下，局域网客户端在有意允许时可以访问 `WEB_PORT`（默认 `3000`）与 `WS_PORT`（默认 `3001`）。在 HTTPS 模式下，代理是外部入口点，Web/WS 上游应保持在回环地址；`WEB_INTERNAL_PORT` 与 `WS_INTERNAL_PORT` 绝不能对外公开。

## 配置

完整配置参考见 `.env.example` 与 `.env.windows.example`。常用设置包括：

| 变量 | 默认值 | 用途 |
|---|---:|---|
| `BACKSLASH_PROTOCOL` | `http` | 选择 HTTP 或可选的 HTTPS 反向代理模式 |
| `BACKSLASH_HOST` | `localhost` | HTTPS 代理站点地址使用的主机名 |
| `HTTPS_PORT` | `443` | Caddy HTTPS 监听端口 |
| `CADDY_PATH` | 空 | 可选的 Caddy 可执行文件路径；否则在 `PATH` 中搜索 |
| `CADDY_CONFIG` | 生成本地 JSON | 可选的 Caddy 配置路径，相对于项目根目录 |
| `CADDY_ADAPTER` | `json` | 生成配置使用 `json`，自定义配置可使用其他适配器 |
| `CERTIFICATE_FILE` | 空 | HTTPS 使用的现有 PEM 证书链路径 |
| `PRIVATE_KEY_FILE` | 空 | HTTPS 使用的现有 PEM 私钥路径 |
| `WEB_UPSTREAM_HOST` | `127.0.0.1` | Next.js 的 HTTPS 代理上游主机 |
| `WEB_UPSTREAM_PORT` | `3000` | Next.js 的 HTTPS 代理上游端口 |
| `WS_UPSTREAM_HOST` | `127.0.0.1` | WebSocket 的 HTTPS 代理上游主机 |
| `WS_UPSTREAM_PORT` | `3001` | WebSocket 的 HTTPS 代理上游端口 |
| `WEB_PORT` | `3000` | Next.js HTTP 端口 |
| `WS_PORT` | `3001` | 公共 Socket.IO 端口 |
| `WS_HOST` | `0.0.0.0` | Socket.IO 监听地址 |
| `WEB_INTERNAL_PORT` | `3010` | 回环 Web 授权端口 |
| `WS_INTERNAL_PORT` | `3011` | 回环 WS 事件投递端口 |
| `WS_INTERNAL_MAX_BODY_BYTES` | `4194304` | 经认证的内部实时事件载荷最大值 |
| `WS_ACCESS_REVALIDATE_INTERVAL_MS` | `60000` | 针对当前项目访问权限重新检查已连接客户端的间隔 |
| `APP_URL` | `http://localhost:3000` | 浏览器可见的应用源 |
| `CORS_ORIGIN` | `http://localhost:3000` | 允许的 Socket.IO 源，或多个源以逗号分隔 |
| `CORS_ALLOW_ANY_ORIGIN_ACKNOWLEDGE_RISK` | `false` | 使用 `CORS_ORIGIN=*` 时必须显式确认风险 |
| `BACKSLASH_INTERNAL_SERVICE_KEY` | — | 内部服务调用所需的共享密钥 |
| `SESSION_SECRET` | — | 会话签名与已保存 AI 密钥所需的密钥 |
| `SESSION_EXPIRY_DAYS` | `7` | 浏览器会话有效期（天） |
| `MAX_SESSIONS_PER_USER` | `10` | 每个用户保留的最大活跃会话数 |
| `BCRYPT_ROUNDS` | `12` | 密码哈希工作因子 |
| `STORAGE_PATH` | `./data` | SQLite、项目与生成产物的根目录 |
| `SQLITE_PATH` | `<STORAGE_PATH>/backslash.db` | 可选的显式 SQLite 文件路径 |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | SQLite 锁等待超时 |
| `SQLITE_WAL_AUTOCHECKPOINT_PAGES` | `1000` | WAL 自动检查点阈值 |
| `DEFAULT_LATEX_ENGINE` | `xelatex` | 默认具体引擎 |
| `COMPILE_TIMEOUT_MS` | `120000` | 单次编译超时（毫秒） |
| `MAX_CONCURRENT_COMPILATIONS` | `2` | 同时运行的最大 TeX 进程数 |
| `MAX_QUEUED_COMPILATIONS` | `200` | 最大等待编译任务数 |
| `MAX_CONCURRENT_CLEAN_TASKS` | `2` | 同时运行的最大 `latexmk` 清理任务数 |
| `COMPILE_LOG_MAX_BYTES` | `10485760` | 内存中编译器输出上限 |
| `BUILD_LOG_DB_MAX_BYTES` | `1048576` | 持久化构建日志上限 |
| `MAX_CONCURRENT_UPLOADS` | `2` | 同时进行的最大多部分解析任务数 |
| `MAX_UPLOAD_FILE_COUNT` | `100` | 一次多部分上传中的最大文件数 |
| `MAX_UPLOAD_BATCH_BYTES` | `104857600` | 一次多部分上传中缓冲的最大文件字节总数 |
| `MAX_PROJECTS_PER_USER` | `100` | 单个用户拥有的最大项目数 |
| `ASYNC_COMPILE_BASE64_PDF_MAX_BYTES` | `10485760` | 可进行 base64 API 输出的最大 PDF 大小 |
| `MAX_TEXT_CONTENT_BYTES` | `5242880` | 可编辑文本文件的最大大小 |
| `LATEX_ALLOW_SHELL_ESCAPE` | `false` | 启用 TeX shell escape；对不受信任的源文件不安全 |
| `LATEX_SHELL_ESCAPE_ACKNOWLEDGE_RISK` | `false` | 启用 shell escape 时必须显式确认风险 |
| `LATEX_MAX_PROJECT_SIZE_MB` | `200` | 接受编译的最大项目大小 |
| `LATEX_MAX_OUTPUT_SIZE_MB` | `200` | 生成的最大 PDF 大小 |
| `ASYNC_COMPILE_RESULT_TTL_MINUTES` | `60` | 一次性 API 结果保留时间 |
| `BUILD_RETENTION_DAYS` | `30` | 终态项目构建的最大保留天数 |
| `BUILD_RETENTION_MAX_PER_PROJECT` | `50` | 每个项目保留的最大终态构建数 |
| `NEXT_PUBLIC_WS_ENABLED` | `true` | 启用浏览器 Socket.IO 连接 |
| `TRUST_PROXY_HEADERS` | `false` | 显式启用时信任代理提供的客户端/协议头 |
| `HEALTH_DETAILS_ENABLED` | `false` | 包含详细健康诊断信息；仅在受信任网络上使用 |
| `AI_ALLOW_PRIVATE_ENDPOINTS` | `false` | 允许私有/局域网 AI 端点，并弱化默认 SSRF 边界 |
| `SECURE_COOKIES` | `false` | 使用安全会话 Cookie；在 HTTPS 后启用 |

## REST API

在 **仪表盘 → 开发者设置** 中创建 API 密钥，然后使用 Bearer 认证调用 `/api/v1`。

```bash
# 提交一次性编译
curl -X POST https://your-instance.example/api/v1/compile \
  -H "Authorization: Bearer bs_YOUR_API_KEY" \
  -F "file=@document.tex"

# 轮询任务
curl https://your-instance.example/api/v1/compile/JOB_ID \
  -H "Authorization: Bearer bs_YOUR_API_KEY"

# 流式获取生成的 PDF
curl "https://your-instance.example/api/v1/compile/JOB_ID/output?format=pdf" \
  -H "Authorization: Bearer bs_YOUR_API_KEY" \
  --output output.pdf
```

对于已完成的一次性任务，默认的 `format=json` 响应会返回元数据、日志、错误与 PDF URL。使用 `format=pdf` 可获取流式二进制输出。`format=base64` 仅在 PDF 大小处于配置的 base64 限制内时可用。

常用端点：

| 方法 | 端点 | 用途 |
|---|---|---|
| `POST` | `/api/v1/compile` | 提交一次性编译 |
| `GET` | `/api/v1/compile/:jobId` | 读取一次性编译状态 |
| `GET` | `/api/v1/compile/:jobId/output` | 读取 JSON 元数据、base64 或流式 PDF 输出 |
| `POST` | `/api/v1/compile/:jobId/cancel` | 取消一次性编译 |
| `GET` / `POST` | `/api/v1/projects` | 列出或创建项目 |
| `GET` / `PUT` / `DELETE` | `/api/v1/projects/:id` | 读取、更新或删除项目 |
| `POST` | `/api/v1/projects/:id/files/upload` | 上传项目文件 |
| `POST` | `/api/v1/projects/:id/compile` | 将项目编译加入队列 |
| `GET` | `/api/v1/projects/:id/pdf` | 流式获取最新项目 PDF |

运行中的应用开发者部分也提供交互式 API 文档。

## 开发与验证

```bash
pnpm test
pnpm --filter @backslash/web typecheck
pnpm --filter @backslash/ws typecheck
pnpm --filter @backslash/web build
pnpm --filter @backslash/ws build
bash scripts/validate.sh
```

相关文档：

- [部署与协议配置](docs/deployment.md)
- [Windows TeX Live 设置](docs/windows-latex-setup.md)
- [编译与实时架构](docs/compile-architecture.md)
- [安全边界](docs/security-boundary.md)
- [性能与容量](docs/performance-and-capacity.md)
- [测试矩阵](docs/test-matrix.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 安全说明

本项目直接在主机上执行 TeX 二进制文件。应用默认禁用 shell escape，使用 `-norc` 调用 `latexmk`，验证项目路径，应用 Kpathsea 限制，限制资源，并在取消或超时时终止进程树。这些控制降低了风险，但**并非操作系统级沙箱**。

对于接受不受信任源文件的部署：

- 在专用的低权限操作系统账户下运行服务。
- 确保该账户无法读取无关的机密或私有目录。
- 应用 CPU、内存、进程数、文件数、磁盘与出站网络限制。
- 保持 `LATEX_ALLOW_SHELL_ESCAPE=false`，除非所有作者与源文件均受信任。启用时还需设置 `LATEX_SHELL_ESCAPE_ACKNOWLEDGE_RISK=true`。
- 不要使用 `CORS_ORIGIN=*`。若特殊受信任部署需要，服务器还要求 `CORS_ALLOW_ANY_ORIGIN_ACKNOWLEDGE_RISK=true`。
- 使用 HTTPS 反向代理，配置精确的 `APP_URL` 与 `CORS_ORIGIN`，并设置 `SECURE_COOKIES=true`。
- 将内部 Web 与 WS 端口保持在仅回环地址。
- 已连接的实时客户端在共享变更后以及周期性会被重新验证；请将 `WS_ACCESS_REVALIDATE_INTERVAL_MS` 保持在适合部署的较短值。
- 在反向代理与应用中同时配置请求体与超时限制。
- 同时备份 SQLite 数据库与项目存储目录，并测试恢复。

请按照 [SECURITY.md](SECURITY.md) 中的说明私下报告可利用漏洞。

## 仓库卫生

在创建公共仓库前，请确认提交中不包含以下任何内容：`.env`、来自其他仓库的 `.git/`、PID 文件、SQLite 数据库或其 WAL/SHM 附属文件、项目存储、编译器输出、`.next`、`dist` 或 `node_modules`。附带的 `.gitignore` 会排除这些路径，但无法移除已经提交的文件。任何曾出现在归档、issue、日志或提交中的密钥都应轮换。

## 项目起源与致谢

本项目是 [Manan-Santoki/Backslash](https://github.com/Manan-Santoki/Backslash) 的大幅修改衍生版本，原作者为 Manan Santoki，以 MIT 许可证发布。

本版本经过大量重写，以支持直接主机部署、原生 TeX Live 编译、本地 SQLite 持久化、局域网访问、有界资源使用、事务性文件操作，以及强化的认证与编译工作流。

原始版权与 MIT 许可证声明已保留在本仓库中。本项目独立维护，与原作者无隶属、赞助或背书关系。

特别感谢 Manan Santoki 以及原 Backslash 项目的所有贡献者，感谢他们将工作开源给社区。

## 许可证

本项目以 [MIT 许可证](LICENSE) 分发。

仓库包含源自原 Backslash 项目的大量内容。上游版权与许可证声明必须保留在分发的源码中，以及包含该代码大量部分的副本中。完整声明与条款见 `LICENSE` 文件，署名细节见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
