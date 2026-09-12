# Backslash 部署与协议配置

本文只说明 Backslash 的部署配置边界，不要求每个用户都启用 HTTPS 或自动申请证书。

## 一、先选择部署方式

### 方式 A：只使用 HTTP

适用于本机、局域网或已经由其他网关负责 HTTPS 的场景。

```env
BACKSLASH_PROTOCOL=http
APP_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
```

这种方式不需要域名、Caddy、证书、win-acme、ACME 账户或腾讯云 DNS API。项目会直接启动 Next.js 和 WebSocket 服务。

### 方式 B：使用已有证书

适用于证书已经由其他机构或其他系统签发的场景。只需要安装 Caddy，并把证书链和私钥路径配置好：

```env
BACKSLASH_PROTOCOL=https
BACKSLASH_HOST=editor.example.com
HTTPS_PORT=443
CADDY_PATH=
CADDY_CONFIG=
CADDY_ADAPTER=json
CERTIFICATE_FILE=./.certificates/production/editor.example.com-chain.pem
PRIVATE_KEY_FILE=./.certificates/production/editor.example.com-key.pem
```

`CERTIFICATE_FILE` 是证书链文件，`PRIVATE_KEY_FILE` 是对应的私钥文件。相对路径以项目根目录为基准；也可以填写当前主机上的绝对路径。`CADDY_PATH` 为空时，启动脚本会在 `PATH` 中查找 `caddy`。

这种方式不需要 win-acme、腾讯云 API 密钥、ACME DNS 插件或自动续期任务。证书更新由用户自己的证书系统负责，更新后可以执行 `scripts/reload-caddy.ps1`（需准备 `.acme.json` 中的 Caddy 配置）或按自己的方式重新加载 Caddy。

### 方式 C：由本项目配合 win-acme 自动申请和续期

只有在确实需要项目帮助申请证书、自动创建 DNS 验证记录和设置续期任务时，才使用这种方式。复制模板：

```text
config/acme.example.json → .acme.json
```

`.acme.json` 已被 `.gitignore` 忽略，不能提交。填写自己的：

| 字段 | 含义 |
|---|---|
| `wacsPath` | win-acme 的 `wacs.exe` 路径；为空时从 Windows `PATH` 查找 |
| `domains` | 需要写入证书的域名列表；通配符域名需要 DNS-01 |
| `commonName` | 证书的主名称 |
| `validation` | 当前脚本支持 `Tencent`，表示使用腾讯云 DNSPod 验证 |
| `tencent.apiId` | 腾讯云子用户的 SecretId |
| `tencent.apiKey` | 腾讯云子用户的 SecretKey；不能写入公共模板或日志 |
| `directory` | PEM 文件输出目录，支持相对项目根目录的路径 |
| `pemFileName` | PEM 文件的基础名称 |
| `staging` | `true` 时使用 Let’s Encrypt 测试环境，不计入正式签发额度 |
| `reloadScript` | 正式续期后执行的 Caddy reload 脚本 |
| `createRenewalTask` | 是否让 win-acme 创建 Windows 计划任务 |
| `caddyPath` | 续期 reload 使用的 Caddy 路径；为空时从 `PATH` 查找 |
| `caddyConfig` | 续期 reload 使用的 Caddy JSON 配置；为空时生成项目本地配置 |
| `caddyAdapter` | 配置格式，默认 `json` |
| `httpsPort` | 续期 reload 时的 HTTPS 监听端口 |
| `webUpstreamHost` / `webUpstreamPort` | Caddy 转发到 Next.js 的地址和端口 |
| `wsUpstreamHost` / `wsUpstreamPort` | Caddy 转发到 WebSocket 的地址和端口 |

执行申请脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\request-certificate.ps1
```

首次使用建议把 `staging` 设为 `true`，确认域名和 DNS 权限正确后再改为正式环境。脚本只在被主动执行时检查 win-acme 和腾讯云凭据；普通 HTTP 启动和已有证书 HTTPS 启动不会读取 `.acme.json`。

## 二、申请域名和配置 DNS

1. 先拥有一个可控制的域名，例如 `example.com`。域名可以在腾讯云或其他注册商处申请。
2. 确认域名的权威 DNS 托管商。域名注册商和 DNS 托管商可以不是同一家公司。
3. 将应用访问的主机名（例如 `editor.example.com`）解析到服务器或隧道入口。常见做法是添加 `A`/`AAAA` 记录，或者添加指向入口的 `CNAME` 记录。
4. 如果使用通配符证书，证书通常覆盖 `example.com` 和 `*.example.com`。通配符只覆盖一层子域名，不自动覆盖更深层的子域名。
5. 使用 DNS-01 时，ACME 客户端会临时创建 `_acme-challenge.example.com` 下的 `TXT` 记录。这个 TXT 记录不是应用访问用的 CNAME 记录，两者用途不同，不能互相替代。

## 三、ACME、HTTP-01 和 DNS-01

ACME 是证书客户端与证书颁发机构之间的自动化协议。它不会替用户购买域名，也不会自动改变用户的业务 DNS，除非用户明确配置了具备 DNS 写权限的插件。

- **HTTP-01**：证书机构访问网站上的验证地址。需要公网 HTTP 可达，通常不能用于通配符证书。
- **DNS-01**：证书机构检查 DNS 中的临时 TXT 记录。适合通配符证书，但需要 DNS API 或手工修改 DNS。
- 本项目当前的 `request-certificate.ps1` 仅实现腾讯云 DNSPod 的 DNS 验证参数。需要其他 DNS 服务商时，不应把其他服务商凭据硬塞进模板；可以使用该服务商自己的 ACME 客户端，随后按“已有证书”方式配置 Backslash。

## 四、腾讯云 DNSPod 的最小权限

如果域名 DNS 托管在 DNSPod，建议创建专用 CAM 子用户，不要使用主账号密钥。权限应限制为本项目验证所需的 DNSPod 查询、创建和删除临时记录操作，并把 SecretId、SecretKey 只保存在本机 `.acme.json` 或密码管理器中。

如果域名 DNS 不在 DNSPod，腾讯云 API 密钥不能管理它的 TXT 记录；这时应改用实际 DNS 托管商的 DNS-01 客户端，或者使用已有证书方式。

## 五、Caddy 在项目中的作用

HTTPS 模式下，Caddy 是本机 TLS 终止和反向代理。外部 HTTPS 请求先到 Caddy：

```text
HTTPS → Caddy → Next.js（网页）
              └→ WebSocket（/ws/*）
```

生产模式下，Next.js 和 WebSocket 上游默认绑定回环地址，避免绕过 TLS 代理暴露明文入口。Caddy 配置由 `scripts/create-caddy-config.mjs` 按环境变量生成到被忽略的 `.backslash-caddy.json`，因此仓库不包含任何人的真实域名、证书路径或主机安装目录。也可以通过 `CADDY_CONFIG` 指向用户自己的配置。

`https://127.0.0.1` 即使可以完成 TLS，也通常会出现浏览器名称不匹配警告，因为域名证书一般不包含 `127.0.0.1`。正常访问应使用证书中包含的域名。

## 六、缺少 HTTPS 条件时的行为

- `BACKSLASH_PROTOCOL=http`：完全跳过 Caddy、证书和 ACME 检查。
- `BACKSLASH_PROTOCOL=https` 且条件完整：启动 Caddy，并将请求转发到应用上游。
- `BACKSLASH_PROTOCOL=https` 但缺少 Caddy、配置、证书链或私钥：启动脚本输出 `WARN`，自动回退到 HTTP，不会因为可选 HTTPS 能力导致普通部署无法启动。

因此，用户不需要为了使用 Backslash 被迫申请域名、安装 win-acme、配置腾讯云 API 或建立自动续期流程。

## 七、安全注意事项

- 永远不要提交 `.env`、`.acme.json`、`.acme.env`、证书文件或私钥。
- 不要把 SecretKey 放进公共脚本、README、命令历史或错误日志。
- HTTPS 对外访问时，将 `APP_URL` 和 `CORS_ORIGIN` 设置为浏览器实际访问的完整来源，并按需启用 `SECURE_COOKIES=true`。
- 证书自动续期不是 HTTPS 的必要条件；它只是证书来源的一种自动化选择。
