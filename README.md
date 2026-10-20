# mist

A privacy passthrough relay for the Anthropic API, on Cloudflare Workers.

Your requests leave from a clean, fixed edge egress — not from your device.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wusaki0723/mist)

---

## Why

Official OAuth login flows collect client-side device and environment signals. mist sits in between as a transparent relay: your client talks to mist, mist talks to `api.anthropic.com`. Upstream sees a uniform, minimal request shape from a consistent edge location — your device fingerprint and network environment stay out of the picture.

mist **stores nothing and inspects nothing** beyond what is required to normalize auth headers in flight. It is a pipe, not a product. The one exception: when the upstream returns an error or the proxy itself throws, mist writes a single structured line to Cloudflare Workers Logs (path, ray id, upstream status, a short excerpt of the upstream error) so failures can be diagnosed. Credentials, API keys, and request bodies are never logged.

## Routes

| Path | Upstream | Behavior |
|---|---|---|
| `/v1/*` | `api.anthropic.com` | Shaped to match the Claude Agent SDK. UA and `x-app` fill gaps only; beta flags merge on `/v1/messages*` alone; the Claude Code system prefix is added there when missing. Both OAuth setup-tokens and plain API keys work |
| `/proxy/v1/*` | `api.anthropic.com` | Alias of `/v1/*`, for clients that bake `/proxy` into their base URL |
| `/health` | — | Unauthenticated status check: which auth mode is live |

## What it is

- **Pure passthrough** — streaming, tool use, vision: whatever the upstream supports, mist forwards untouched
- **Long-lived token, zero state** — one ~1-year token held in Cloudflare's secret store; no refresh flow, no KV, no database. Clients authenticate to mist with your own `PROXY_API_KEY`; the real token never leaves the edge
- **Agent SDK signature** — outgoing Anthropic requests are shaped to match the Claude Agent SDK, preserving full model compatibility (optional, can be disabled)
- **Header hygiene** — edge- and proxy-injected headers (`cf-*`, `x-real-ip`, `x-forwarded-*`, `true-client-ip`) are stripped before forwarding, so the upstream never sees your real client IP or hop chain
- **One-click deploy** — no resources to provision

## Recommended use

mist is meant for **Claude Code and official Claude SDKs only**, via their standard custom-endpoint settings (`ANTHROPIC_BASE_URL` / SDK `baseURL`). It is not a general-purpose API gateway and is shared at your own discretion within your own circle.

## Known limitation: egress geography

Anthropic region-gates by the IP it sees — which is the Worker's egress, not your client's. A Worker runs in the Cloudflare colo closest to the client, and its subrequests leave from that same colo. A client connecting from an unsupported region without its own routing (mainland China typically lands in the Hong Kong colo, and Hong Kong is not a supported region) will still be rejected by Anthropic — relay or no relay. That is geography, not a bug: Workers offers no knob for choosing egress region. If it matters, the last hop has to leave from a supported region (your own small relay box, for example).

## When you don't need mist

If all you want is multi-model access with your own keys, skip the relay: **OpenRouter**, **Vercel AI Gateway**, and **Cloudflare AI Gateway** all support BYOK and can be called directly. **Kilo Gateway** (`https://api.kilo.ai/api/gateway`, OpenAI-compatible) supports BYOK too, and additionally carries free models (`kilo-auto/free`, `:free` variants) that need no credits at all. None of these need a middleman — mist exists only for the narrow case of "my Anthropic subscription, from a clean fixed egress".

## Claude Code 2.1.x: billing header, cc_gateway, wiggly-dove

Verified against a real Claude Code 2.1.304 install behind a capture proxy:

- The `x-anthropic-billing-header` attribution string is carried **inside `system[0]` of the request body** (not an HTTP header): `cc_version=…; cc_entrypoint=…;` plus optional `cc_workload`, `cc_project`, etc.
- `cc_gateway` is appended only in gateway mode (`CLAUDE_CODE_USE_GATEWAY`) when the base URL is not exempt. The exemption list is `*.anthropic.com`, private/loopback ranges, and `host.docker.internal` — nothing else, and notably **not** `gateway.ai.cloudflare.com`. An explicit `hostVerdict: { vouched: … }` from server-side config can also exempt a host.
- `x-claude-code-wiggly-dove` (gate `tengu_wiggly_dove`) exists in the binary but is still gated; it was not emitted in our tests. It is described as an environment report with an integrity check.

Since 2.1.1, mist skips JSON re-serialization when the system string starts with the Claude Code prefix, or a system array contains a block starting with that prefix or the billing marker. The client beta header is preserved as received only when it already includes all required betas; otherwise missing values are appended. Authentication headers are still replaced, proxy headers stripped, and missing defaults filled in. These behaviors do not make the entire request byte-identical. **Compatibility with the gated integrity check has not been verified.**

### Not getting marked: a local reverse proxy

Loopback and private ranges are on the exemption list (they have to be — local router tools like claude-code-router live there), so the clean way to avoid the `cc_gateway` marker is a tiny local proxy in front of mist:

```bash
# local proxy listens on localhost:<port>, forwards to https://<your-worker>.<subdomain>.workers.dev
export ANTHROPIC_BASE_URL="http://localhost:<port>"
```

Claude Code sees an exempt localhost URL and appends no `cc_gateway` marker — the request shape is identical to a local router tool. As a bonus, the proxy is a single choke point: every client goes through it, so routing policy lives in exactly one place. Two conditions: the proxy must forward the body **byte-for-byte** (any mutation is what integrity checks look for), and remember this is marker avoidance, not invisibility — if upstream ever cross-checks posture server-side, claim and reality need to match.

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
| `PROXY_API_KEY` | a long random string you invent — this is the key your clients will use |
| `CLAUDE_OAUTH_TOKEN` | the token from step 1 (preferred when set) |
| `ANTHROPIC_API_KEY` | optional: a regular `sk-ant-api03-...` key. Used when no OAuth token is set, and as an automatic one-time fallback when OAuth returns 401 |

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

**Hana:** add an Anthropic provider with base URL = worker address and key = `PROXY_API_KEY`.

## Options

Request normalization (Anthropic path) is on by default. To disable it (model availability may be reduced):

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

## 路径

| 路径 | 上游 | 行为 |
|---|---|---|
| `/v1/*` | `api.anthropic.com` | 出站形状对齐 Claude Agent SDK：UA 与 `x-app` 只补缺口；beta 标记只在 `/v1/messages*` 合并；Claude Code system 前缀缺了才补。OAuth setup-token 与普通 API key 都能用 |
| `/proxy/v1/*` | `api.anthropic.com` | `/v1/*` 的别名，兼容把 `/proxy` 写进 base_url 的客户端 |
| `/health` | — | 无需鉴权的自检：认证模式一目了然 |

## 为什么

官方 OAuth 登录流程会采集客户端的设备与环境信息。mist 夹在中间做透明中继：你的客户端连 mist，mist 连 `api.anthropic.com`。上游看到的只是一个来自固定边缘节点的、形态统一的干净请求——你的设备指纹和网络环境不会暴露。

mist **不存储、不窥探**任何请求内容，只在转发途中做必要的认证头归一化。它是一根管子，不是一个产品。唯一的例外：当上游返回错误或代理自身抛异常时，mist 会向 Cloudflare Workers Logs 写一条结构化日志（路径、ray id、上游状态码、错误摘要），方便排查问题。凭据、API key 和请求体永远不会被记录。

## 推荐使用

mist 仅推荐配合 **Claude Code 和官方 Claude SDK** 使用，走它们标准的自定义端点设置（`ANTHROPIC_BASE_URL` / SDK 的 `baseURL`）。它不是通用 API 网关，请在自己的小圈子里自行斟酌分享。

## 已知限制：出口地理

Anthropic 按它看到的 IP 做地区门控，而那个 IP 是 Worker 的出口，不是你客户端的。Worker 在离客户端最近的 Cloudflare 机房执行，子请求也从那个机房出去。客户端从不支持区直连进来（国内流量通常落香港机房，而香港不在支持列表里），照样会被 Anthropic 拒——有没有中继都一样。这是地理问题不是 bug：Workers 没有选出口地区的旋钮。真在意这个，最后一棒得从支持区出去（比如自己加一台小中继机）。

## 不需要 mist 的场景

如果你只是想用自己的 key 调各家模型，别过中继：**OpenRouter**、**Vercel AI Gateway**、**Cloudflare AI Gateway** 都支持 BYOK，直连就行。**Kilo Gateway**（`https://api.kilo.ai/api/gateway`，OpenAI 兼容）同样支持 BYOK，还自带不要额度的免费模型（`kilo-auto/free` 和各种 `:free` 变体）。这些都不需要中间人——mist 只为一种窄场景存在："我的 Anthropic 订阅，要从干净固定的出口出去"。

## Claude Code 2.1.x：billing 头、cc_gateway 与 wiggly-dove

以下是在真机 Claude Code 2.1.304 + 抓包代理后的实测：

- `x-anthropic-billing-header` 归属串**塞在请求体的 system[0] 里**（不是 HTTP 头）：`cc_version=…; cc_entrypoint=…;`，可附加 `cc_workload`、`cc_project` 等。
- `cc_gateway` 只在网关模式（`CLAUDE_CODE_USE_GATEWAY`）且 base URL 不在豁免名单时追加。豁免名单只有 `*.anthropic.com`、内网/回环网段和 `host.docker.internal`——**没有** `gateway.ai.cloudflare.com`。服务端下发的 `hostVerdict: { vouched: … }` 也可以豁免某个域名。
- `x-claude-code-wiggly-dove`（灰度门 `tengu_wiggly_dove`）在二进制里存在但仍被门控，实测未发出。据描述是带完整性校验的环境上报。

2.1.1 起，如果 system 字符串以 Claude Code 前缀开头，或 system 数组中存在以前缀或 billing 标记开头的文本块，mist 会跳过 JSON 重序列化。客户端 beta 头只有在已覆盖全部必需项时才按接收到的值保留，否则仍会追加缺项。认证头仍会替换，代理头仍会剥除，缺失的默认头仍会补齐，因此不能据此声称整个请求字节不变。**尚未验证与灰度完整性校验的兼容性。**

### 不被标记：本地反代

回环和内网网段在豁免名单里（不得不在——claude-code-router 这类本地路由工具全住在那），所以避开 `cc_gateway` 标记的干净做法是在 mist 前面套一个本地小反代：

```bash
# 本地反代监听 localhost:<port>，转发到 https://<你的worker>.<subdomain>.workers.dev
export ANTHROPIC_BASE_URL="http://localhost:<port>"
```

Claude Code 看到的是豁免的 localhost 地址，不追加 `cc_gateway` 标记——请求形状和本地路由工具完全一致。附带好处：反代是唯一的收口点，所有客户端都过它，路由策略只存在一个地方。两个条件：反代必须**逐字节**转发 body（任何改写都是完整性校验的目标）；并且记住这是标记规避不是隐身——上游哪天在服务端交叉验证出网姿态，声称和事实得对得上。

## ⚠️ 风险自担

mist 是个人网络工具。把账号流量经由中继转发是否符合上游服务条款，由你自己判断。使用即表示你接受账号可能被限制的风险。项目按原样提供，无任何担保；作者不对账号处置或其他损失负责。丢不起这个号，就别用。

## 上手

1. **拿 token**（需要有效订阅 + 本机 Claude Code）：`claude setup-token`，浏览器授权后终端打印一年期 token，**只显示一次，立刻复制**
2. **部署**：点上方按钮，或 `npm install && npx wrangler login && npm run deploy`
3. **加 secret**：CF 面板 → Workers & Pages → mist → Settings → Variables and Secrets，类型 Secret：
   - `PROXY_API_KEY`：自编长随机串（客户端用它认证）
   - `CLAUDE_OAUTH_TOKEN`：第 1 步那串（配了就优先用它）
   - `ANTHROPIC_API_KEY`：可选，普通 `sk-ant-api03-...` key。没配 OAuth token 时启用；OAuth 返回 401 时自动用它兜底重试一次
4. **验证**：`curl https://<你的worker>.<subdomain>.workers.dev/health` 看各路径状态
5. **接客户端**：
   - Claude 系：base URL 填 Worker 地址（不带 `/v1`），API key 填 `PROXY_API_KEY`
   - Hana：Anthropic provider 填 worker 地址，key 填 `PROXY_API_KEY`

## 可选旋钮

- `CLOAK=false`：关闭 Anthropic 路径的 system 前缀补全（可用模型范围可能缩小）
- `CLIENT_UA`：覆盖默认客户端 UA。内置默认是 `claude-cli/2.1.293 …`，版本老去时改它即可，不用动代码。`/health` 里能看到当前生效值

指纹优先级是硬规则：**客户端自己发的头原样透传，默认值只补缺口**。真 Agent SDK 调进来时形状端到端不变。

## License

[MIT](LICENSE)
