export interface Env {
  PROXY_API_KEY: string;
  CLAUDE_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  /** "false" 原样转发正文和客户端头，不补兼容默认值。 */
  CLOAK?: string;
  CLIENT_UA?: string;
}

const UPSTREAM_ANTHROPIC = "https://api.anthropic.com";
const VERSION = "2.2.0";
const MAX_BUFFERED_BODY = 16 * 1024 * 1024;
const DEFAULT_CLIENT_UA = "claude-cli/2.1.318 (external, sdk-cli)";

function clientUA(env: Env): string {
  return env.CLIENT_UA?.trim() || DEFAULT_CLIENT_UA;
}

const BASE_BETAS =
  "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,effort-2025-11-24";
const OAUTH_BETAS = "oauth-2025-04-20,extended-cache-ttl-2025-04-11";
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
  "via",
]);

const EDGE_INJECTED = new Set([
  "cdn-loop",
  "true-client-ip",
  "x-client-ip",
  "x-real-ip",
  "forwarded",
  "x-cluster-client-ip",
  "x-envoy-external-address",
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

/** 常量时间比较，挡时序旁路。长度不等直接判负（key 长度非秘密）。 */
function keysEqual(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.byteLength !== bb.byteLength) return false;
  // Workers 运行时的原生实现；Node 测试环境没有，降级为逐字节异或
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(ba, bb);
  }
  let diff = 0;
  for (let i = 0; i < ba.byteLength; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function assertProxyAuth(req: Request, env: Env): Response | null {
  const expected = env.PROXY_API_KEY?.trim();
  if (!expected) return json({ error: "PROXY_API_KEY secret is not configured" }, 500);
  if (!keysEqual(clientKey(req), expected)) return json({ error: "unauthorized" }, 401);
  return null;
}

function cloakEnabled(env: Env): boolean {
  return (env.CLOAK ?? "").trim().toLowerCase() !== "false";
}

function mergeBetas(incoming: string | null, withOAuth: boolean): string {
  const base = withOAuth ? `${BASE_BETAS},${OAUTH_BETAS}` : BASE_BETAS;
  if (!incoming?.trim()) return base;
  const required = base.split(",");
  const inParts = incoming
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const have = new Set(inParts);
  if (required.every((b) => have.has(b))) return incoming;
  // 缺啥补啥：保持客户端原有顺序，缺的追加在后
  return [...inParts, ...required.filter((b) => !have.has(b))].join(",");
}

/** 透传客户端头，剥掉 hop-by-hop / 边缘注入 / 客户端认证三类。 */
function copyClientHeaders(req: Request): Headers {
  const out = new Headers();
  for (const [k, v] of req.headers) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "authorization" || lower === "x-api-key") continue;
    if (lower.startsWith("cf-") || lower.startsWith("x-forwarded-")) continue;
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

  if (!cloakEnabled(env)) return out;

  out.set("anthropic-version", req.headers.get("anthropic-version") || "2023-06-01");
  // 兼容默认值只补缺口，批请求保留客户端自己的 beta。
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
  // new URL 会归一化点段（含 %2e 编码形式）：/v1/../x 会变成 /x。
  // 归一化后再查一次前缀，守住 /v1/* 硬门
  if (!url.pathname.startsWith("/v1/")) return null;
  return url;
}

type TextBlock = { type?: string; text?: string };

const BILLING_MARKER = "x-anthropic-billing-header:";

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
    if (sys.startsWith(CLAUDE_CODE_PREFIX)) return bodyText;
    data.system = `${CLAUDE_CODE_PREFIX}\n\n${sys}`;
    return JSON.stringify(data);
  }
  if (Array.isArray(sys)) {
    // 保留已有前缀与计费标记，不重序列化。
    const genuine = sys.some((b) => {
      const t = (b as TextBlock | undefined)?.text;
      return (
        typeof t === "string" &&
        (t.startsWith(CLAUDE_CODE_PREFIX) || t.startsWith(BILLING_MARKER))
      );
    });
    if (genuine) return bodyText;
    sys.unshift({ type: "text", text: CLAUDE_CODE_PREFIX });
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

function isMessagesPath(path: string): boolean {
  return path === "/v1/messages" || path === "/v1/messages/count_tokens";
}

class BodyTooLarge extends Error {}

async function readBody(body: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BUFFERED_BODY) {
        void reader.cancel().catch(() => {});
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function anthropicBody(
  req: Request,
  env: Env,
  normalizedPath: string,
): Promise<AnthropicBody> {
  if (req.method === "GET" || req.method === "HEAD" || !req.body) return { rewritten: false };
  const encoding = req.headers.get("content-encoding")?.trim().toLowerCase();
  const rewrite = isMessagesPath(normalizedPath) && cloakEnabled(env) && (!encoding || encoding === "identity");
  const canFallback = Boolean(env.CLAUDE_OAUTH_TOKEN?.trim() && env.ANTHROPIC_API_KEY?.trim());
  if (!rewrite && !canFallback) return { body: req.body, rewritten: false };

  const body = await readBody(req.body);
  if (!body.byteLength) return { rewritten: false };
  if (rewrite) {
    const text = new TextDecoder().decode(body);
    const cloaked = cloakSystem(text);
    if (cloaked !== text) return { body: cloaked, rewritten: true };
  }
  return { body, rewritten: false };
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
    logError("upstream_error", req, {
      route: "anthropic",
      upstreamStatus: upstream.status,
      auth: usedOAuth ? "oauth" : "api-key",
    });
  }
  return relayResponse(upstream);
}

function handleHealth(env: Env, authed: boolean): Response {
  // 公开健康检查只报活着；配置指纹要带对 PROXY_API_KEY 才给看
  if (!authed) return json({ ok: true, service: "mist", version: VERSION });
  const oauth = env.CLAUDE_OAUTH_TOKEN?.trim() || "";
  const apikey = env.ANTHROPIC_API_KEY?.trim() || "";
  return json({
    ok: true,
    service: "mist",
    version: VERSION,
    routes: {
      anthropic: {
        path: "/v1/*",
        auth: oauth ? "oauth-setup-token" : apikey ? "api-key" : null,
        hasOAuthToken: Boolean(oauth),
        looksLikeSetupToken: oauth.startsWith("sk-ant-oat01-"),
        hasApiKey: Boolean(apikey),
        cloak: cloakEnabled(env),
        signature: cloakEnabled(env) ? "claude-code-client" : null,
        clientUA: cloakEnabled(env) ? clientUA(env) : null,
        clientUAOverridden: cloakEnabled(env) && Boolean(env.CLIENT_UA?.trim()),
      },
    },
  });
}

// 供回归测试使用的内部实现（不改变 Worker 的默认导出行为）
export { anthropicUrl, anthropicBody, buildAnthropicHeaders, cloakSystem, mergeBetas, clientUA, handleHealth };

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
      // 无需鉴权的存活探测；带对 key 才返回配置指纹
      const expected = env.PROXY_API_KEY?.trim() || "";
      const authed = Boolean(expected) && keysEqual(clientKey(req), expected);
      return handleHealth(env, authed);
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
      if (e instanceof BodyTooLarge) return json({ error: "request body exceeds 16 MiB buffer limit" }, 413);
      logError("proxy_exception", req, {});
      return json({ error: "upstream request failed" }, 502);
    }
  },
};
