/**
 * mist v2.1 — Anthropic 隐私透传中继（Cloudflare Workers）
 *
 * 路径布局：
 *   /health        状态自检（无需鉴权）
 *   /v1/*          → https://api.anthropic.com，按 Claude Agent SDK 形状归一化
 *   /proxy/v1/*    /v1/* 的别名（兼容把 /proxy 写进 base_url 的客户端）
 *
 * 客户端统一用 PROXY_API_KEY 鉴权（x-api-key 或 Authorization: Bearer 均可）。
 * 上游真实凭据只存在 Cloudflare secret store，从不下发到客户端。
 *
 * Anthropic 路径的上游认证（二选一，OAuth 优先）：
 *   CLAUDE_OAUTH_TOKEN   sk-ant-oat01-...，`claude setup-token` 产物（~1 年）
 *   ANTHROPIC_API_KEY    sk-ant-api03-...，官方 API key（SDK 形状可用）
 *
 * Cloak：Anthropic 对 OAuth token 的非 Haiku 模型有 Claude Code system 前缀
 * 门控，缺前缀时自动补上；Agent SDK 本身也携带该前缀，因此这与真实客户端
 * 形状一致。CLOAK=false 关闭。
 */

export interface Env {
  /** 客户端与 mist 之间的钥匙。 */
  PROXY_API_KEY: string;
  /** Claude OAuth setup-token（sk-ant-oat01-...）。 */
  CLAUDE_OAUTH_TOKEN?: string;
  /** 官方 API key（sk-ant-api03-...），OAuth 缺位时启用。 */
  ANTHROPIC_API_KEY?: string;
  /** "false" 关闭 Anthropic 路径的 system 前缀补全。默认开启。 */
  CLOAK?: string;
  /** 覆盖默认的客户端 UA（版本老去时改这一个旋钮，不用动代码）。 */
  CLIENT_UA?: string;
}

const UPSTREAM_ANTHROPIC = "https://api.anthropic.com";

const VERSION = "2.1.0";

/**
 * 指纹优先级（明规则）：客户端自己带的头一律透传，下面的默认值
 * 只补缺口。真实 Agent SDK 调进来时形状保持原样；裸客户端（curl、
 * Hana 等）才被补上这套实测签名。
 */
const DEFAULT_CLIENT_UA =
  "claude-cli/2.1.293 (external, sdk-ts, agent-sdk/0.3.293)";

/** 客户端 UA：CLIENT_UA 变量/密钥优先，其次内置默认。 */
function clientUA(env: Env): string {
  return env.CLIENT_UA?.trim() || DEFAULT_CLIENT_UA;
}

/**
 * 实测 Agent SDK 默认携带的 beta 全集（2026-10 抓包）。
 * oauth-2025-04-20 仅在使用 OAuth token 时附加，x-api-key 请求不掺这个。
 */
const BASE_BETAS =
  "interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01,thinking-display-updates-2026-08-18";
const OAUTH_BETA = "oauth-2025-04-20";

const CLAUDE_CODE_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * 边缘或前置反代注入的头（cf-* 来自 Cloudflare，x-real-ip / x-forwarded-*
 * 来自客户端侧的跳板）。官方客户端永远不会发这些：转发等于告诉上游
 * 真实客户端 IP 和链路层数，必须剥掉。
 * SDK 自报头（user-agent、x-stainless-*、x-app）刻意保留。
 */
const EDGE_INJECTED = new Set([
  "cdn-loop",
  "true-client-ip",
  "x-client-ip",
  "x-real-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-server",
]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function clientKey(req: Request): string {
  const x = req.headers.get("x-api-key")?.trim();
  if (x) return x;
  const auth = req.headers.get("authorization")?.trim() || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || "";
}

function assertProxyAuth(req: Request, env: Env): Response | null {
  const expected = env.PROXY_API_KEY?.trim();
  if (!expected) return json({ error: "PROXY_API_KEY secret is not configured" }, 500);
  if (clientKey(req) !== expected) return json({ error: "unauthorized" }, 401);
  return null;
}

function cloakEnabled(env: Env): boolean {
  return (env.CLOAK ?? "").trim().toLowerCase() !== "false";
}

function mergeBetas(incoming: string | null, withOAuth: boolean): string {
  const base = withOAuth ? `${BASE_BETAS},${OAUTH_BETA}` : BASE_BETAS;
  if (!incoming?.trim()) return base;
  const parts = new Set(
    `${base},${incoming}`
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return [...parts].join(",");
}

/** 透传客户端头，剥掉 hop-by-hop / 边缘注入 / 客户端认证三类。 */
function copyClientHeaders(req: Request): Headers {
  const out = new Headers();
  for (const [k, v] of req.headers) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "authorization" || lower === "x-api-key") continue;
    if (lower.startsWith("cf-")) continue;
    if (EDGE_INJECTED.has(lower)) continue;
    out.set(k, v);
  }
  return out;
}

function buildAnthropicHeaders(
  req: Request,
  env: Env,
  useOAuth: boolean,
  bodyRewritten: boolean,
  isMessages: boolean,
): Headers {
  const out = copyClientHeaders(req);

  if (useOAuth) {
    out.set("authorization", `Bearer ${env.CLAUDE_OAUTH_TOKEN!.trim()}`);
    out.delete("x-api-key");
  } else {
    out.set("x-api-key", env.ANTHROPIC_API_KEY!.trim());
    out.delete("authorization");
  }

  out.set("anthropic-version", req.headers.get("anthropic-version") || "2023-06-01");
  // beta 合并只发生在 /v1/messages 家族；其它路径原样透传客户端的 beta，避免上游 400
  if (isMessages) {
    out.set("anthropic-beta", mergeBetas(req.headers.get("anthropic-beta"), useOAuth));
  }
  // 只有被 cloak 真正缓冲改写过的 body 才能标 JSON；流式透传时保留客户端自己的 content-type
  if (bodyRewritten) out.set("content-type", "application/json");
  if (!out.has("accept")) out.set("accept", "application/json");
  if (!out.has("user-agent")) out.set("user-agent", clientUA(env));
  if (!out.has("x-app")) out.set("x-app", "cli");
  return out;
}

function anthropicUrl(req: Request): URL | null {
  const src = new URL(req.url);
  let path = src.pathname;
  if (path.startsWith("/proxy")) path = path.slice("/proxy".length);
  // 容忍客户端重复叠加版本前缀：/v1/v1/* -> /v1/*
  path = path.replace(/^(\/v1)+(?=\/)/, "/v1");
  // 折叠前导斜杠：防止 "//evil.com" 这类协议相对形式穿透 host
  path = path.replace(/^\/+/, "/");
  // 硬门：只服务 /v1/*，其余一律拒
  if (!path.startsWith("/v1/")) return null;
  const url = new URL(UPSTREAM_ANTHROPIC + path + src.search);
  // 保险：origin 必须等于写死的上游
  if (url.origin !== UPSTREAM_ANTHROPIC) return null;
  return url;
}

type TextBlock = { type?: string; text?: string };

/** 给 body.system 补上 Claude Code 前缀（已存在则不动）。 */
function cloakSystem(bodyText: string): string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return bodyText;

  const sys = data.system;
  if (typeof sys === "string") {
    if (!sys.startsWith(CLAUDE_CODE_PREFIX)) {
      data.system = `${CLAUDE_CODE_PREFIX}\n\n${sys}`;
    }
    return JSON.stringify(data);
  }
  if (Array.isArray(sys)) {
    const first = sys[0] as TextBlock | undefined;
    const already =
      first && typeof first.text === "string" && first.text.startsWith(CLAUDE_CODE_PREFIX);
    if (!already) sys.unshift({ type: "text", text: CLAUDE_CODE_PREFIX });
    return JSON.stringify(data);
  }
  data.system = CLAUDE_CODE_PREFIX;
  return JSON.stringify(data);
}

interface AnthropicBody {
  body?: BodyInit;
  /** 只有 cloak 真正改写过（输出 ≠ 输入）才算 rewritten，才能安全标 JSON。 */
  rewritten: boolean;
}

/** /v1/messages 家族判定：等于或以其为前缀（count_tokens、batches 等子接口都算）。 */
function isMessagesPath(path: string): boolean {
  return path === "/v1/messages" || path.startsWith("/v1/messages/");
}

/**
 * Anthropic 路径的出站 body：
 * - GET/HEAD：无 body
 * - /v1/messages 家族且 cloak 开：缓冲为文本、补前缀；只有真的被改写才标 rewritten
 * - 双凭据都在（可能 401 回退重试）：按字节缓冲（arrayBuffer，不损二进制）
 * - 其它一切：原样流式透传，不碰
 */
async function anthropicBody(
  req: Request,
  env: Env,
  normalizedPath: string,
): Promise<AnthropicBody> {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return { rewritten: false };

  if (isMessagesPath(normalizedPath) && cloakEnabled(env)) {
    const text = await req.text();
    if (!text) return { rewritten: false };
    const cloaked = cloakSystem(text);
    return { body: cloaked, rewritten: cloaked !== text };
  }

  const canFallback = Boolean(env.CLAUDE_OAUTH_TOKEN?.trim() && env.ANTHROPIC_API_KEY?.trim());
  if (canFallback) {
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return { rewritten: false };
    return { body: buf, rewritten: false };
  }
  return { body: req.body ?? undefined, rewritten: false };
}

/** 读上游错误体，最多 max 字节，读完就扔，不拖住流。 */
async function readBounded(res: Response, max = 2048): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= max) break;
    }
  } catch {
    /* 上游断了就算了 */
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(total, max));
  let off = 0;
  for (const c of chunks) {
    if (off >= max) break;
    const slice = c.subarray(0, Math.min(c.byteLength, max - off));
    buf.set(slice, off);
    off += slice.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * 出错可见性：上游失败或代理异常时向 Workers Logs 写一条结构化元数据。
 * 永不记录 token、API key 或请求体。
 */
function logError(event: string, req: Request, fields: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      event,
      ts: new Date().toISOString(),
      method: req.method,
      path: new URL(req.url).pathname,
      ray: req.headers.get("cf-ray"),
      ua: req.headers.get("user-agent"),
      ...fields,
    }),
  );
}

/** 把上游响应原样回传（流式不动），只加 CORS 与禁缓存。 */
function relayResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  // Workers 运行时会透明解压 body，原样转发头会弄坏客户端，删掉让运行时重算
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "*");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function callAnthropic(
  req: Request,
  env: Env,
  useOAuth: boolean,
  url: URL,
  bodyInfo: AnthropicBody,
): Promise<Response> {
  const isMessages = isMessagesPath(url.pathname);
  const init: RequestInit = {
    method: req.method,
    headers: buildAnthropicHeaders(req, env, useOAuth, bodyInfo.rewritten, isMessages),
    redirect: "manual",
  };
  if (bodyInfo.body !== undefined) init.body = bodyInfo.body;
  return fetch(url, init);
}

async function proxyAnthropic(req: Request, env: Env): Promise<Response> {
  const oauth = env.CLAUDE_OAUTH_TOKEN?.trim();
  const apikey = env.ANTHROPIC_API_KEY?.trim();
  if (!oauth && !apikey) {
    return json(
      { error: "no upstream credential: set CLAUDE_OAUTH_TOKEN or ANTHROPIC_API_KEY" },
      500,
    );
  }
  const url = anthropicUrl(req);
  if (!url) return json({ error: "only /v1/* is proxied" }, 404);

  const bodyInfo = await anthropicBody(req, env, url.pathname);

  let usedOAuth = Boolean(oauth);
  let upstream = await callAnthropic(req, env, usedOAuth, url, bodyInfo);

  // OAuth 过期/失效时，若备着 API key 就顶上去重试一次
  if (usedOAuth && upstream.status === 401 && apikey) {
    logError("oauth_fallback", req, { route: "anthropic", upstreamStatus: 401 });
    upstream.body?.cancel().catch(() => {});
    usedOAuth = false;
    upstream = await callAnthropic(req, env, false, url, bodyInfo);
  }

  if (!upstream.ok) {
    const detail = await readBounded(upstream.clone());
    logError("upstream_error", req, {
      route: "anthropic",
      upstreamStatus: upstream.status,
      auth: usedOAuth ? "oauth" : "api-key",
      detail,
    });
  }
  return relayResponse(upstream);
}

function handleHealth(env: Env): Response {
  const oauth = env.CLAUDE_OAUTH_TOKEN?.trim() || "";
  return json({
    ok: true,
    service: "mist",
    version: VERSION,
    routes: {
      anthropic: {
        path: "/v1/*",
        auth: oauth ? "oauth-setup-token" : env.ANTHROPIC_API_KEY?.trim() ? "api-key" : null,
        hasOAuthToken: Boolean(oauth),
        looksLikeSetupToken: oauth.startsWith("sk-ant-oat01-"),
        hasApiKey: Boolean(env.ANTHROPIC_API_KEY?.trim()),
        cloak: cloakEnabled(env),
        signature: "claude-agent-sdk",
        clientUA: clientUA(env),
        clientUAOverridden: Boolean(env.CLIENT_UA?.trim()),
      },
    },
  });
}

// 供回归测试使用的内部实现（不改变 Worker 的默认导出行为）
export { anthropicUrl, anthropicBody, buildAnthropicHeaders, cloakSystem, mergeBetas, clientUA };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname === "/health" || url.pathname === "/") {
      return handleHealth(env);
    }

    const denied = assertProxyAuth(req, env);
    if (denied) return denied;

    const path = url.pathname;
    try {
      if (path.startsWith("/v1/") || path.startsWith("/proxy/")) {
        return await proxyAnthropic(req, env);
      }
      return json(
        {
          error: "unknown route",
          hint: "Anthropic: base_url = https://<worker> (call /v1/messages; /proxy/v1/* also accepted)",
        },
        404,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logError("proxy_exception", req, { error: message });
      return json({ error: message }, 502);
    }
  },
};
