# Backslash 编译与实时架构

## 组件边界

`apps/web` 是 SQLite 唯一读写者，负责项目 API、文件系统、编译调度、构建记录和产物保留。`apps/ws` 是独立 Socket.IO 服务，提供 presence、cursor、chat 和协作事件；它不访问数据库文件。

```text
Browser
  ├─ HTTP → apps/web (Next.js、better-sqlite3/WAL、文件、编译)
  └─ Socket.IO → apps/ws (协作事件)

apps/ws ── POST 127.0.0.1:WEB_INTERNAL_PORT/authorize ──→ apps/web
apps/web ── POST 127.0.0.1:WS_INTERNAL_PORT/events ─────→ apps/ws
```

WS 暂时不可用时，Web API 和编译仍可工作，编辑器通过构建轮询收敛状态。

## 项目编译流

```text
POST /api/projects/:projectId/compile
  → 鉴权并创建 queued build
  → CompileRunner.addJob()
  → CompileTaskManager 有界排队、同项目等待任务去重
  → 复制项目到独立工作目录
  → spawn latexmk -norc ... (shell:false)
  → 有界收集日志、解析错误、校验 PDF 大小
  → 原子替换项目 PDF、更新 build、广播事件
  → 删除工作目录
```

队列满时路由返回 HTTP 429。被同项目新请求替换的等待任务、主动取消的等待任务以及队列拒绝任务都会落库为 `canceled`，不会永久停留在 `queued`。

一次性 `/api/v1/compile` 使用同一个任务管理器和进程执行器，但不按项目去重；其任务 ID、元数据文件和产物路径由服务器生成并校验。

## 资源边界

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `MAX_CONCURRENT_COMPILATIONS` | 2 | 同时运行的 TeX 进程 |
| `MAX_QUEUED_COMPILATIONS` | 200 | 等待任务硬上限 |
| `MAX_CONCURRENT_CLEAN_TASKS` | 2 | 绕过编译队列的清理进程上限 |
| `COMPILE_TIMEOUT_MS` | 120000 | 单任务超时 |
| `COMPILE_LOG_MAX_BYTES` | 10485760 | 子进程日志内存上限 |
| `BUILD_LOG_DB_MAX_BYTES` | 1048576 | 构建日志持久化上限 |
| `LATEX_MAX_PROJECT_SIZE_MB` | 200 | 编译前项目总大小上限 |
| `LATEX_MAX_OUTPUT_SIZE_MB` | 200 | PDF 产物上限 |
| `COMPILE_TASK_HISTORY_LIMIT` | 200 | 内存终态摘要数量 |
| `COMPILE_TASK_HISTORY_TTL_MINUTES` | 60 | 终态摘要寿命 |
| `BUILD_RETENTION_DAYS` | 30 | 构建记录最长保留 |
| `BUILD_RETENTION_MAX_PER_PROJECT` | 50 | 每项目终态构建上限 |

并发值不是越大越好。XeLaTeX/复杂宏包单进程可能占用数百 MiB；应按典型文档测量峰值 RSS 后设置。

## SQLite 持久化

Web 直接使用 `better-sqlite3` 打开 `backslash.db`，Drizzle 查询层保持不变。数据库启用外键、WAL、`synchronous=NORMAL`、有界 `busy_timeout` 和自动 checkpoint；已有 `sql.js` 生成的标准 SQLite 文件可直接打开，不需要数据导出/导入。

该设计消除了整库驻留 Web 堆内存和每次持久化导出完整数据库的写放大，同时保留单文件部署。仍需遵守以下边界：

- Web 是唯一数据库读写服务；WS 不直接打开数据库。
- 使用 `better-sqlite3` 同步 API，超大查询或长事务仍会阻塞 Web 事件循环；路由必须保持查询有索引、结果有界。
- WAL 提高读写并行度，但单个 SQLite 文件不是多主机数据库；需要多个 Web 写实例时迁移 PostgreSQL。
- API key 使用计数继续批量更新，降低认证热路径上的写事务数量。

`SQLITE_BUSY_TIMEOUT_MS` 控制锁竞争等待，`SQLITE_WAL_AUTOCHECKPOINT_PAGES` 控制 WAL 自动 checkpoint 阈值。运维脚本或测试可调用被动 checkpoint，但正常写入不依赖手工 flush。

## PDF 前端

PDF.js worker 从本地依赖加载，不依赖外部 CDN。预览只渲染当前页附近的窗口（默认前后两页），其余页面使用占位元素；设备像素比封顶为 2，避免长文档一次性创建大量高分辨率 canvas。
