# mist

A small Anthropic API relay on Cloudflare Workers. Clients use a proxy key; upstream credentials stay in Worker secrets. Streaming responses are forwarded without buffering.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wusaki0723/mist)

## Routes

| Path | Behavior |
|---|---|
| `/v1/*` | Forward to `https://api.anthropic.com/v1/*` |
| `/proxy/v1/*` | Alias of `/v1/*` |
| `/health` | Public liveness check; a valid proxy key also reveals the active configuration |

## Request handling

**`CLOAK=false` preserves request body bytes** and adds no defaults for `user-agent`, `x-app`, `anthropic-version`, `accept`, or `anthropic-beta`. Authentication is still replaced; hop-by-hop headers, `cf-*`, `x-forwarded-*`, `x-real-ip`, `true-client-ip`, and other recognized forwarding headers are still stripped. This is body preservation, not an identical HTTP request or a guarantee of anonymity.

With `CLOAK` unset, legacy compatibility behavior stays enabled: missing default headers are filled, and beta flags and the Claude Code system prefix are added only on `/v1/messages` and `/v1/messages/count_tokens`. Existing recognized client system blocks are kept without JSON re-serialization. Compressed bodies and batch bodies are never rewritten.

Bodies that must be buffered for compatibility rewriting or a possible OAuth-to-API-key retry have a **16 MiB** limit; larger bodies return `413`. With one upstream credential, bodies that need no rewriting stream through without this buffer limit. With both credentials, retryable bodies are buffered as bytes.

## Compatibility defaults

Checked on 2026-11-04 with Claude Code **2.1.318**, isolated configuration, fake credentials, and a localhost API, across Sonnet, Opus, and Haiku in API-key and OAuth modes:

| Header | Default |
|---|---|
| `user-agent` | `claude-cli/2.1.318 (external, sdk-cli)` |
| `x-app` | `cli` |
| `anthropic-version` | `2023-06-01` |
| `accept` | `application/json` |
| `anthropic-beta` | The observed common flags below; OAuth also adds `oauth-2025-04-20` and `extended-cache-ttl-2025-04-11` |

```text
claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,effort-2025-11-24
```

Client headers take priority. Session IDs, `x-stainless-*` platform/runtime fields, integrity headers, and billing blocks are preserved when supplied, never fabricated. The local test checks emitted requests, not upstream acceptance or account permissions.

## Setup

### 1. Deploy

Use the button above, or:

```bash
git clone https://github.com/wusaki0723/mist
cd mist
npm ci
npx wrangler login
npm run deploy
```

### 2. Configure secrets

In Cloudflare → Workers & Pages → your Worker → Settings → Variables and Secrets, add:

| Name | Value |
|---|---|
| `PROXY_API_KEY` | A long random key for clients to authenticate to mist |
| `ANTHROPIC_API_KEY` | Your Claude Console API key; the standard official path for third-party API access |
| `CLAUDE_OAUTH_TOKEN` | Optional existing Claude setup-token; takes precedence when set |
| `CLOAK` | Set to `false` for body preservation and no added default headers; unset keeps legacy compatibility |
| `CLIENT_UA` | Optional default UA override in compatibility mode; never overrides a client's own UA |

The CLI equivalent is `npx wrangler secret put <NAME>` and entering the value at the prompt. Never commit real credentials.

**When both upstream credentials are set, an OAuth `401` automatically retries once with the API key.** That retry uses the API key's billing account, not Claude subscription usage credits.

For an authorized OAuth use case, run `claude setup-token` yourself and save the printed token as `CLAUDE_OAUTH_TOKEN`. It lasts about a year; repeat the command and replace the secret when it expires. mist provides no OAuth login or refresh flow, no extra-usage-only billing control, and no guarantee of upstream authorization or protection from account restrictions. See Anthropic's [authentication and credential rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

### 3. Verify and connect

```bash
curl https://<your-worker>/health
curl -H "x-api-key: $PROXY_API_KEY" https://<your-worker>/health

export ANTHROPIC_BASE_URL="https://<your-worker>"
export ANTHROPIC_API_KEY="<PROXY_API_KEY>"
```

For SDKs or another Anthropic-compatible client, use the Worker URL as `baseURL` (without `/v1`) and `PROXY_API_KEY` as the API key. The health endpoint checks liveness/configuration, not whether the upstream credential can make model requests.

## Logs and location

mist's error logs contain only event, time, HTTP method, path, ray ID, status, and auth mode where applicable. They do not include request/response bodies, credentials, user-agent, or raw exception messages. Proxy exceptions return a generic `502`; logging does not read upstream error bodies.

Workers use default nearby execution unless configured otherwise. The commented placement example in [wrangler.jsonc](wrangler.jsonc) can target Singapore with `region: "aws:ap-southeast-1"`. [Placement hints](https://developers.cloudflare.com/workers/configuration/placement/) do not guarantee a fixed IP, a particular data center, or access through upstream region restrictions. No runtime region switch is provided.

Keep the proxy key private: anyone holding it can use the configured upstream account. mist does not remove identifiers inside prompts or all client headers, and cannot guarantee anonymity or account safety.

---

# 中文说明

mist 是跑在 Cloudflare Workers 上的 Anthropic API 小型中继。客户端使用代理密钥，上游凭据保存在 Worker secrets 中；流式响应不做完整缓冲。

## 路径

| 路径 | 行为 |
|---|---|
| `/v1/*` | 转发到 `https://api.anthropic.com/v1/*` |
| `/proxy/v1/*` | `/v1/*` 的别名 |
| `/health` | 公开存活检查；带对代理密钥后也展示当前配置 |

## 请求处理

**`CLOAK=false` 保留请求体原始字节**，不补 `user-agent`、`x-app`、`anthropic-version`、`accept` 或 `anthropic-beta` 默认值。认证头仍会替换，hop-by-hop、`cf-*`、`x-forwarded-*`、`x-real-ip`、`true-client-ip` 等代理转发头仍会剥离。这只保证请求体不被改写，不表示整个 HTTP 请求一致，也不保证匿名。

未设置 `CLOAK` 时保留旧兼容默认：补齐缺失的默认头，但只对 `/v1/messages` 和 `/v1/messages/count_tokens` 补 beta 与 Claude Code system 前缀。已识别的客户端 system 块不做 JSON 重序列化。压缩正文和 batch 正文均不改写。

为兼容改写或 OAuth 失败回退而必须缓冲的正文，上限为 **16 MiB**，超过返回 `413`。只有一套上游凭据且无需改写时直接流式转发，不加此缓冲上限；两套凭据都在时，为重试按原始字节缓冲正文。

## 兼容模式默认头

2026-11-04 使用 Claude Code **2.1.318**、隔离配置、假凭据和本机假 API，核对了 Sonnet、Opus、Haiku 的 API key 与 OAuth 两种模式：

| 请求头 | 默认值 |
|---|---|
| `user-agent` | `claude-cli/2.1.318 (external, sdk-cli)` |
| `x-app` | `cli` |
| `anthropic-version` | `2023-06-01` |
| `accept` | `application/json` |
| `anthropic-beta` | 以下实测公共标记；OAuth 另加 `oauth-2025-04-20` 和 `extended-cache-ttl-2025-04-11` |

```text
claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,effort-2025-11-24
```

客户端已有头优先。会话 ID、`x-stainless-*` 平台和运行时字段、完整性头与计费块均在客户端提供时保留，不代为伪造。本机测试验证的是请求形状，不验证上游接受情况或账户权限。

## 上手

### 1. 部署

点击顶部部署按钮，或执行：

```bash
git clone https://github.com/wusaki0723/mist
cd mist
npm ci
npx wrangler login
npm run deploy
```

### 2. 配置 secrets

Cloudflare → Workers & Pages → 你的 Worker → Settings → Variables and Secrets：

| 名称 | 值 |
|---|---|
| `PROXY_API_KEY` | 客户端访问 mist 使用的长随机密钥 |
| `ANTHROPIC_API_KEY` | Claude Console API key，第三方 API 接入的正常官方路径 |
| `CLAUDE_OAUTH_TOKEN` | 可选的既有 Claude setup-token，设置后优先使用 |
| `CLOAK` | 设为 `false` 保留请求体字节且不补默认头；未设置则保留旧兼容行为 |
| `CLIENT_UA` | 可选，兼容模式下的默认 UA；不会覆盖客户端已有 UA |

命令行可执行 `npx wrangler secret put <名称>`，在提示中输入值。不要提交真实凭据。

**两套上游凭据都在时，OAuth 返回 `401` 会自动用 API key 重试一次。** 重试使用 API key 对应账户计费，不消耗 Claude 订阅 usage credits。

已获授权的 OAuth 使用场景中，可自行运行 `claude setup-token`，把输出保存为 `CLAUDE_OAUTH_TOKEN`。有效期约一年，到期后重新生成并替换 secret。mist 不提供 OAuth 登录、刷新或仅扣 extra 的计费控制，不保证获得上游授权或避免账号限制。接入前请核对 Anthropic 的[认证与凭据规则](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)。

### 3. 验证与连接

```bash
curl https://<你的Worker>/health
curl -H "x-api-key: $PROXY_API_KEY" https://<你的Worker>/health

export ANTHROPIC_BASE_URL="https://<你的Worker>"
export ANTHROPIC_API_KEY="<PROXY_API_KEY>"
```

SDK 或其他 Anthropic 兼容客户端的 `baseURL` 填 Worker 地址，不带 `/v1`；API key 填 `PROXY_API_KEY`。健康检查只检查存活与配置，不验证上游凭据能否调用模型。

## 日志与地区

mist 的错误日志只包含事件、时间、HTTP method、路径、ray ID，以及适用时的状态码和认证模式；不记录请求或响应正文、凭据、UA 或原始异常信息。代理异常统一返回通用 `502`，日志不读取上游错误正文。

默认使用 Workers 就近执行。[wrangler.jsonc](wrangler.jsonc) 中保留了可选 placement 注释示例，可用 `region: "aws:ap-southeast-1"` 指向新加坡附近执行。[位置提示](https://developers.cloudflare.com/workers/configuration/placement/)不保证固定 IP、指定机房或解除上游地区限制；没有运行时地区切换。

妥善保管代理密钥，持有者可以使用你配置的上游账户。mist 不会清除提示词中的标识或所有客户端头，不能保证匿名或账号安全。

## License

[MIT](LICENSE)
