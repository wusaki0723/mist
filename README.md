# claude-oauth-worker

Expose your Claude Pro/Max subscription as a private, Anthropic-compatible API endpoint — backed by a Cloudflare Worker and the 1-year `setup-token`. No refresh tokens, no KV, no servers.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wusaki0723/claude-oauth-worker)

---

## ⚠️ Disclaimer — read this first

This project routes your Claude **subscription** OAuth token (from `claude setup-token`) through a proxy so that arbitrary Anthropic-API clients can use it.

- Anthropic's terms restrict subscription OAuth tokens to the **official Claude Code** product. Routing them to other clients may violate Anthropic's Terms of Service.
- This Worker prepends the Claude Code system-prompt prefix ("cloak") to satisfy a server-side check that otherwise limits OAuth tokens to Haiku-class models. That is a deliberate workaround of an upstream restriction.
- **Using this project may get your Claude account rate-limited, suspended, or banned.**

Provided strictly as-is, for educational and personal use. **You assume all risk.** The authors accept no liability for account actions, lost subscriptions, or any other damages. If losing your Claude account would hurt, don't use this.

---

## Features

- **setup-token only** — one long-lived (~1 year) token, no refresh flow, no KV, zero state
- **Your token never leaves the Worker** — clients authenticate with your own `PROXY_API_KEY`
- **Cloak built in** — Sonnet/Opus work out of the box; disable if you want
- **Pure passthrough** — streaming, tool use, vision: whatever the Messages API supports
- **One-click deploy** — no KV namespaces or other resources to provision

## Quick start

### 1. Get your setup token

Requires an active Claude Pro/Max subscription and Claude Code installed:

```bash
claude setup-token
```

Authorize in the browser; the terminal prints a `sk-ant-oat01-...` token valid for ~1 year. **It is shown once — copy it immediately.**

### 2. Deploy

Click the button above, connect your GitHub account, and Cloudflare will fork and deploy the Worker for you.

Prefer the CLI?

```bash
git clone https://github.com/wusaki0723/claude-oauth-worker
cd claude-oauth-worker
npm install
npx wrangler login
npm run deploy
```

### 3. Add secrets

Cloudflare dashboard → **Workers & Pages → claude-oauth-worker → Settings → Variables and Secrets → Add** (type: Secret):

| Secret | Value |
|---|---|
| `CLAUDE_OAUTH_TOKEN` | your `sk-ant-oat01-...` setup token |
| `PROXY_API_KEY` | a long random string you invent — this is the key your clients will use |

Saving a secret triggers a new deployment automatically; no redeploy needed.

### 4. Verify

```bash
curl https://<your-worker>.<subdomain>.workers.dev/health
# → { "hasToken": true, "looksLikeSetupToken": true, "cloak": true, ... }
```

### 5. Point your client at it

**Claude Code:**

```bash
export ANTHROPIC_BASE_URL="https://<your-worker>.<subdomain>.workers.dev"
export ANTHROPIC_API_KEY="<PROXY_API_KEY>"
claude
```

**Any Anthropic SDK / compatible app:** set base URL to `https://<your-worker>.<subdomain>.workers.dev` (no `/v1` suffix — clients append `/v1/messages` themselves), API key to your `PROXY_API_KEY`, and use official model ids (e.g. `claude-sonnet-4-6`).

## The cloak

Anthropic gates non-Haiku models behind a system-prompt check for OAuth tokens. The Worker therefore prepends:

```
You are Claude Code, Anthropic's official CLI for Claude.
```

to `system` on every request (skipped if the client already sent it, e.g. real Claude Code). Trade-off: the model may lean slightly toward coding-assistant mannerisms.

To disable (you'll likely be limited to Haiku):

```bash
npx wrangler secret put CLOAK   # enter: false
```

## When the token expires

Upstream starts returning 401 after ~1 year. Then:

```bash
claude setup-token                       # generate a fresh token
npx wrangler secret put CLAUDE_OAUTH_TOKEN
```

No redeploy needed.

## Security notes

- `PROXY_API_KEY` is the only thing standing between the public internet and your subscription. Make it long and random.
- Never commit secrets; the Worker reads them from Cloudflare's secret store only.
- The `*.workers.dev` URL is publicly reachable. Rotate both secrets if you suspect leakage.

---

# 中文说明

把你的 Claude Pro/Max 订阅变成一个私有的、Anthropic 兼容的 API 端点——基于 Cloudflare Worker 和一年期的 `setup-token`。没有 refresh token，没有 KV，没有服务器。

## ⚠️ 风险声明——先看这个

本项目把 Claude **订阅**的 OAuth token（`claude setup-token` 生成）通过反代给任意 Anthropic API 客户端使用。

- Anthropic 的条款限定订阅 OAuth token 只能用于**官方 Claude Code**。把它接给别的客户端可能违反 Anthropic 服务条款。
- Worker 默认开启 cloak：给每个请求的 system 前面补 Claude Code 前缀，以通过服务端检测（否则只能用 Haiku 档模型）。这是对上游限制的主动规避。
- **使用本项目可能导致你的 Claude 账号被限流、暂停或封禁。**

项目按原样提供，仅供学习研究和个人使用。**一切风险自负。**作者不对封号、订阅损失或任何其他损害负责。丢不起这个号，就别用。

## 快速上手

1. **拿 token**（需要 Pro/Max 订阅 + 本机有 Claude Code）：
   ```bash
   claude setup-token
   ```
   浏览器授权后终端打印 `sk-ant-oat01-...`，一年有效，**只显示一次，立刻复制**。

2. **部署**：点上面的 Deploy 按钮，连 GitHub，Cloudflare 自动 fork 并部署。
   命令行党：`npm install && npx wrangler login && npm run deploy`。

3. **加 secret**：CF 面板 → Workers & Pages → claude-oauth-worker → Settings → Variables and Secrets，类型选 Secret：
   - `CLAUDE_OAUTH_TOKEN`：刚才那串 `sk-ant-oat01-...`
   - `PROXY_API_KEY`：自己编一个长随机串（这就是客户端要用的 key）

4. **验证**：`curl https://<你的worker>.<subdomain>.workers.dev/health`，看到 `hasToken: true` 即可。

5. **客户端**：base URL 填 Worker 地址（**不要带 `/v1`**），API key 填 `PROXY_API_KEY`，模型用官方 id（如 `claude-sonnet-4-6`）。

## Cloak 开关

OAuth token 的服务端策略：system 不以 Claude Code 前缀开头时，Sonnet/Opus 返回 `rate_limit_error`，只有 Haiku 能用。Worker 默认自动补前缀（客户端已带则跳过）。代价是模型可能略微偏编程助手人设。

想关：`npx wrangler secret put CLOAK`，输入 `false`。但关了大概率只剩 Haiku。

## Token 到期

一年到期后上游返回 401。重跑 `claude setup-token` 拿新 token，`wrangler secret put CLAUDE_OAUTH_TOKEN` 换上即可，不用重新部署。

## License

[MIT](LICENSE)
