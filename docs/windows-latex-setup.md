# Windows 原生 TeX Live 配置

## 前提条件

- Windows 11
- Node.js 24 LTS（最低 22.5）与 pnpm 10+
- TeX Live 2023，包含 `latexmk`、`xelatex`、`pdflatex`、`bibtex`、`biber` 与 `makeindex`

将 TeX Live 的 `bin/windows` 目录添加到 `PATH`，或在根目录 `.env` 中设置 `LATEXMK_PATH`。示例文件不包含机器绝对路径；使用实际安装位置替换该变量。

## 配置

复制 `.env.windows.example` 为 `.env`，至少设置：

```env
BACKSLASH_INTERNAL_SERVICE_KEY=<独立随机密钥>
SESSION_SECRET=<独立随机密钥>
LATEXMK_PATH=<latexmk.exe 的完整路径，或留空并使用 PATH>
STORAGE_PATH=./data
```

使用下面命令生成每个随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`STORAGE_PATH` 是 SQLite、项目文件、异步编译产物和默认编译目录的共同根目录。设置 `SQLITE_PATH`、`LATEX_TEMP_ROOT` 或 `LATEX_OUTPUT_ROOT` 时，它们可覆盖对应默认位置。

## 启动

生产模式要求预先构建 Web 和 WS：

```bash
pnpm install
pnpm --filter @backslash/web build
pnpm --filter @backslash/ws build
bash scripts/start.sh
```

开发模式使用 watch 进程：

```bash
BACKSLASH_MODE=development bash scripts/start.sh
```

运行与维护脚本统一存放在 `scripts/`，并根据脚本自身位置定位仓库根目录，所以不要求 PowerShell 或 Git Bash 当前正位于项目根目录。

`scripts/start.sh` 会校验 Node.js、pnpm、`latexmk`、内部共享密钥和四个端口；随后启动 Web，确认 loopback 授权端点可用，再启动 WS。PID 会写入 `.backslash-web.pid` 与 `.backslash-ws.pid`，`scripts/restart.sh` 会停止二者后重启。

## 局域网实时协作

Socket.IO 默认在 `WS_HOST=0.0.0.0` 和 `WS_PORT=3001` 监听。局域网客户端需要能够访问 Web 端口与 WS 端口。`WEB_INTERNAL_PORT` 和 `WS_INTERNAL_PORT` 只绑定 `127.0.0.1`，不得通过防火墙对外开放。

`NEXT_PUBLIC_WS_ENABLED` 默认启用实时协作。设置为 `false` 后，编辑器不创建 Socket.IO 连接；保存与编译 API 仍可使用，构建状态由轮询更新。

## 常见问题

| 问题 | 处理方式 |
|---|---|
| `latexmk is required` | 设置 `LATEXMK_PATH`，或将 TeX Live 的 bin 目录加入 `PATH`。 |
| Web internal authorization server did not start | 检查 `BACKSLASH_INTERNAL_SERVICE_KEY`、`WEB_INTERNAL_PORT` 和 Web 进程日志。 |
| WS 无法连接 | 检查 `WS_PORT` 防火墙规则、`NEXT_PUBLIC_WS_URL` 和浏览器访问地址。 |
| 编译超时 | 调整 `COMPILE_TIMEOUT_MS`，并确认 TeX Live 完整安装。 |
| 中文文档失败 | 使用 `xelatex` 和合适的 CJK 宏包。 |


## LuaLaTeX 安全说明

Backslash 不开放 LuaLaTeX。LuaTeX 的 Lua 与 TeX 文件读取能力在没有操作系统级沙箱时无法同时兼顾完整字体功能和服务器文件隔离；局域网多用户部署应使用 XeLaTeX 处理 Unicode 与系统字体。
