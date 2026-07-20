/**
 * mist — Claude setup-token passthrough proxy (no refresh, no KV).
 *
 * Privacy relay: client → mist (PROXY_API_KEY) → api.anthropic.com (Bearer setup-token + beta)
 * Stores nothing, logs nothing; only auth headers are normalized in flight.
 *
 * Auth source: `claude setup-token` long-lived token (sk-ant-oat01-..., ~1 year).
 * When it expires, generate a new one and `wrangler secret put CLAUDE_OAUTH_TOKEN`.
 *
 * Cloak: Anthropic gates non-Haiku models behind a Claude Code system-prompt
 * check for OAuth tokens. We prepend the Claude Code prefix unless the client
 * already sent it. Disable with secret CLOAK=false.
 */

export interface Env {
  /** Client-facing key (Hana / Claude Code / scripts). */
  PROXY_API_KEY: string;
  /** Long-lived token from `claude setup-token` (sk-ant-oat01-...). */
  CLAUDE_OAUTH_TOKEN: string;
  /** Optional: "false" disables system-prefix injection. Default: enabled. */
  CLOAK?: string;
}

const UPSTREAM = "https://api.anthropic.com";
const BASE_BETAS = "claude-code-20250219,oauth-2025-04-20";
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

function mergeBetas(incoming: string | null): string {
  if (!incoming?.trim()) return BASE_BETAS;
  const parts = new Set(
    `${BASE_BETAS},${incoming}`
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return [...parts].join(",");
}

function buildUpstreamHeaders(req: Request, env: Env, cloaked: boolean): Headers {
  const out = new Headers();
  for (const [k, v] of req.headers) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "authorization" || lower === "x-api-key") continue;
    if (lower === "anthropic-beta") continue;
    out.set(k, v);
  }

  out.set("authorization", `Bearer ${env.CLAUDE_OAUTH_TOKEN.trim()}`);
  out.set("anthropic-version", req.headers.get("anthropic-version") || "2023-06-01");
  out.set("anthropic-beta", mergeBetas(req.headers.get("anthropic-beta")));
  if (cloaked) out.set("content-type", "application/json");
  if (!out.has("accept")) out.set("accept", "application/json");
  if (!out.has("user-agent")) {
    out.set("user-agent", "claude-cli/2.0 (mist)");
  }
  return out;
}

function upstreamUrl(req: Request): URL {
  const src = new URL(req.url);
  let path = src.pathname;
  if (path.startsWith("/proxy")) path = path.slice("/proxy".length) || "/";
  // Tolerate clients that double-prefix the API version: /v1/v1/* -> /v1/*
  path = path.replace(/^(\/v1)+(?=\/)/, "/v1");
  if (!path.startsWith("/")) path = `/${path}`;
  return new URL(path + src.search, UPSTREAM);
}

type TextBlock = { type?: string; text?: string };

/** Prepend the Claude Code prefix to body.system unless already present. */
function cloakSystem(bodyText: string): string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return bodyText; // not JSON: pass through untouched
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
    if (!already) {
      sys.unshift({ type: "text", text: CLAUDE_CODE_PREFIX });
    }
    return JSON.stringify(data);
  }

  // No system field at all.
  data.system = CLAUDE_CODE_PREFIX;
  return JSON.stringify(data);
}

/**
 * Returns the body to send upstream.
 * Cloak off or GET/HEAD: stream the original request body untouched.
 * Cloak on: buffer, rewrite system prefix, send modified JSON.
 */
async function upstreamBody(req: Request, env: Env): Promise<BodyInit | undefined> {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  if (!cloakEnabled(env)) return req.body ?? undefined;
  const text = await req.text();
  if (!text) return undefined;
  return cloakSystem(text);
}

async function proxyAnthropic(req: Request, env: Env): Promise<Response> {
  if (!env.CLAUDE_OAUTH_TOKEN?.trim()) {
    return json(
      { error: "CLAUDE_OAUTH_TOKEN secret is not configured (run `claude setup-token`)" },
      500,
    );
  }

  const body = await upstreamBody(req, env);
  const init: RequestInit = {
    method: req.method,
    headers: buildUpstreamHeaders(req, env, body !== undefined && cloakEnabled(env)),
    redirect: "manual",
  };
  if (body !== undefined) init.body = body;

  const upstream = await fetch(upstreamUrl(req), init);

  const headers = new Headers(upstream.headers);
  headers.set("cache-control", "no-store");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function handleHealth(env: Env): Response {
  const token = env.CLAUDE_OAUTH_TOKEN?.trim() || "";
  return json({
    ok: true,
    service: "mist",
    mode: "setup-token (no refresh)",
    hasToken: Boolean(token),
    tokenPrefix: token ? `${token.slice(0, 14)}...` : null,
    looksLikeSetupToken: token.startsWith("sk-ant-oat01-"),
    cloak: cloakEnabled(env),
  });
}

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

    const path = url.pathname.startsWith("/proxy")
      ? url.pathname.slice("/proxy".length)
      : url.pathname;
    if (!path.startsWith("/v1/")) {
      return json(
        {
          error: "only /v1/* (or /proxy/v1/*) is proxied",
          hint: "set base_url to https://<this-worker> and call /v1/messages",
        },
        404,
      );
    }

    try {
      return await proxyAnthropic(req, env);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  },
};
