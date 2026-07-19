# mist

A privacy passthrough relay for the Anthropic API, on Cloudflare Workers.

Your requests leave from a clean, fixed edge egress — not from your device.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wusaki0723/mist)

---

## Why

Official OAuth login flows collect client-side device and environment signals. mist sits in between as a transparent relay: your client talks to mist, mist talks to `api.anthropic.com`. Upstream sees a uniform, minimal request shape from a consistent edge location — your device fingerprint and network environment stay out of the picture.

mist **stores nothing, logs nothing, and inspects nothing** beyond what is required to normalize auth headers in flight. It is a pipe, not a product.

## What it is

- **Pure passthrough** — streaming, tool use, vision: whatever the Messages API supports, mist forwards untouched
- **Long-lived token, zero state** — one ~1-year token held in Cloudflare's secret store; no refresh flow, no KV, no database. Clients authenticate to mist with your own `PROXY_API_KEY`; the real token never leaves the edge
- **Request normalization** — outgoing requests are shaped to match the official client, preserving full model compatibility (optional, can be disabled)
- **One-click deploy** — no resources to provision

## Recommended use

mist is meant for **Claude Code and official Claude SDKs only**, via their standard custom-endpoint settings (`ANTHROPIC_BASE_URL` / SDK `baseURL`). It is not a general-purpose API gateway and is shared at your own discretion within your own circle.

## ⚠️ Use at your own risk

mist is a personal networking tool. Whether routing your account's traffic through a relay complies with upstream terms of service is your own determination to make. Account restrictions are a possibility you accept by using this. Provided as-is, without warranty of any kind; the authors accept no liability for account actions or any other damages. If losing access to your account would hurt, don't use it.

## Setup

### 1. Get a long-lived token

Requires an active Claude subscription and Claude Code installed:

```bash
claude setup-token
```

Authorize in the browser; the terminal prints a token valid for ~1 year. **It is shown once — copy it immediately.**

### 2. Deploy

Click the button above, connect your GitHub account, and Cloudflare will fork and deploy the Worker for you.

Prefer the CLI?

```bash
git clone https://github.com/wusaki0723/mist
cd mist
npm install
npx wrangler login
npm run deploy
```

### 3. Add secrets

Cloudflare dashboard → **Workers & Pages → mist → Settings → Variables and Secrets → Add** (type: Secret):

| Secret | Value |
|---|---|
| `CLAUDE_OAUTH_TOKEN` | the token from step 1 |
| `PROXY_API_KEY` | a long random string you invent — this is the key your clients will use |

Saving a secret triggers a new deployment automatically.

### 4. Verify

```bash
curl https://<your-worker>.<subdomain>.workers.dev/health
# → { "hasToken": true, "looksLikeSetupToken": true, ... }
```

### 5. Connect your client

**Claude Code:**

```bash
export ANTHROPIC_BASE_URL="https://<your-worker>.<subdomain>.workers.dev"
export ANTHROPIC_API_KEY="<PROXY_API_KEY>"
claude
```

**Official SDKs:** set base URL to your worker address (no `/v1` suffix), API key to your `PROXY_API_KEY`, and use official model ids.

## Options

Request normalization is on by default. To disable it (model availability may be reduced):

```bash
npx wrangler secret put CLOAK   # enter: false
```

## When the token expires

Upstream starts returning 401 after ~1 year. Then:

```bash
claude setup-token                       # fresh token
npx wrangler secret put CLAUDE_OAUTH_TOKEN
```

No redeploy needed.

## Security notes

- `PROXY_API_KEY` is the only thing between the public internet and your account. Make it long and random.
- Never commit secrets; mist reads them from Cloudflare's secret store only.
- The `*.workers.dev` URL is publicly reachable. Rotate both secrets if you suspect leakage.

---

# 中文说明

Anthropic API 的隐私透传中继，跑在 Cloudflare Workers 上。

你的请求从一个干净、固定的边缘出口发出，而不是从你的设备。

## 为什么

官方 OAuth 登录流程会采集客户端的设备与环境信息。mist 夹在中间做透明中继：你的客户端连 mist，mist 连 `api.anthropic.com`。上游看到的只是一个来自固定边缘节点的、形态统一的干净请求——你的设备指纹和网络环境不会暴露。

mist **不存储、不记录、不窥探**任何请求内容，只在转发途中做必要的认证头归一化。它是一根管子，不是一个产品。

## 推荐使用

mist 仅推荐配合 **Claude Code 和官方 Claude SDK** 使用，走它们标准的自定义端点设置（`ANTHROPIC_BASE_URL` / SDK 的 `baseURL`）。它不是通用 API 网关，请在自己的小圈子里自行斟酌分享。

## ⚠️ 风险自担

mist 是个人网络工具。把账号流量经由中继转发是否符合上游服务条款，由你自己判断。使用即表示你接受账号可能被限制的风险。项目按原样提供，无任何担保；作者不对账号处置或其他损失负责。丢不起这个号，就别用。

## 上手

1. **拿 token**（需要有效订阅 + 本机 Claude Code）：`claude setup-token`，浏览器授权后终端打印一年期 token，**只显示一次，立刻复制**
2. **部署**：点上方按钮，或 `npm install && npx wrangler login && npm run deploy`
3. **加 secret**：CF 面板 → Workers & Pages → mist → Settings → Variables and Secrets，类型 Secret：
   - `CLAUDE_OAUTH_TOKEN`：第 1 步那串
   - `PROXY_API_KEY`：自编长随机串（客户端用它认证）
4. **验证**：`curl https://<你的worker>.<subdomain>.workers.dev/health` 看到 `hasToken: true`
5. **接客户端**：base URL 填 Worker 地址（不带 `/v1`），API key 填 `PROXY_API_KEY`

## License

[MIT](LICENSE)
