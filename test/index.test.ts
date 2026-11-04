// mist 回归测试：node --experimental-strip-types --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import worker, {
  anthropicUrl,
  anthropicBody,
  buildAnthropicHeaders,
  cloakSystem,
  mergeBetas,
  clientUA,
  handleHealth,
} from '../src/index.ts';

const env = {
  PROXY_API_KEY: 'test-proxy-key',
  CLAUDE_OAUTH_TOKEN: 'sk-ant-oat01-fake',
  ANTHROPIC_API_KEY: 'sk-ant-api03-fake',
} as any;

function req(path: string, headers: Record<string, string> = {}, method = 'POST') {
  return new Request(`https://worker.example${path}`, { method, headers });
}

// ── 点段/编码点段逃逸：new URL 归一化后再守一次门 ──

test('点段与 %2e 编码逃逸被拒绝', () => {
  // 注意：new Request() 在 URL 解析层已归一化点段，所以这些请求到达
  // anthropicUrl 时已是归一化形态；'/v1/../../v1/models' 归一化后是合法的
  // /v1/models，自然放行。真正的防线是归一化后的第二道 /v1/ 前缀检查。
  assert.equal(anthropicUrl(req('/v1/../v1beta/models')), null);
  assert.equal(anthropicUrl(req('/v1/%2e%2e/v1beta/models')), null);
  assert.equal(anthropicUrl(req('/proxy/v1/../v1beta/models')), null);
  assert.equal(
    anthropicUrl(req('/v1/../../v1/models'))?.toString(),
    'https://api.anthropic.com/v1/models',
  );
  // 正常路径不受误伤
  assert.equal(
    anthropicUrl(req('/v1/messages/count_tokens'))?.toString(),
    'https://api.anthropic.com/v1/messages/count_tokens',
  );
});

// ── /health 分级：未鉴权只报活着 ──

test('/health 未鉴权不露配置指纹，鉴权后才给', async () => {
  const pub = (await handleHealth(env, false).json()) as any;
  assert.equal(pub.ok, true);
  assert.equal(pub.routes, undefined);
  const priv = (await handleHealth(env, true).json()) as any;
  assert.equal(priv.routes.anthropic.hasOAuthToken, true);
  assert.equal(priv.routes.anthropic.cloak, true);
});

test('端到端：匿名 /health 分级、带 key 给指纹、/v1 未鉴权 401', async () => {
  const { default: worker } = await import('../src/index.ts');
  const anon = await worker.fetch(req('/health', {}, 'GET'), env);
  const anonBody = (await anon.json()) as any;
  assert.equal(anonBody.ok, true);
  assert.equal(anonBody.routes, undefined);

  const authed = await worker.fetch(
    req('/health', { 'x-api-key': 'test-proxy-key' }, 'GET'),
    env,
  );
  const authedBody = (await authed.json()) as any;
  assert.equal(authedBody.routes.anthropic.hasOAuthToken, true);

  const denied = await worker.fetch(req('/v1/messages'), env);
  assert.equal(denied.status, 401);
});

// ── 开放代理逃逸（PR #1 评审主条）──

test('协议相对逃逸 /proxy//evil.com 被拒绝', () => {
  assert.equal(anthropicUrl(req('/proxy//evil.com/x')), null);
});

test('反斜杠形态 /proxy/\\@evil.com 被拒绝', () => {
  // WHATWG 会把 https URL path 里的 \ 规范成 /，变成 /proxy//@evil.com
  assert.equal(anthropicUrl(req('/proxy/\\@evil.com')), null);
});

test('/proxy 剥掉后非 /v1/ 路径被拒绝', () => {
  assert.equal(anthropicUrl(req('/proxy/v1beta/models')), null);
  assert.equal(anthropicUrl(req('/proxy/health')), null);
});

test('正常路径与双 /v1 前缀容错', () => {
  assert.equal(
    anthropicUrl(req('/v1/messages?beta=true'))?.toString(),
    'https://api.anthropic.com/v1/messages?beta=true',
  );
  assert.equal(
    anthropicUrl(req('/proxy/v1/v1/messages'))?.toString(),
    'https://api.anthropic.com/v1/messages',
  );
  assert.equal(anthropicUrl(req('/v1/messages'))?.origin, 'https://api.anthropic.com');
});

// ── content-type：只有改写过的 body 才标 JSON ──

test('cloak 改写过的 body 标 application/json', () => {
  const h = buildAnthropicHeaders(req('/v1/messages'), env, true, true, true);
  assert.equal(h.get('content-type'), 'application/json');
});

test('流式透传时保留客户端自己的 content-type', () => {
  const h = buildAnthropicHeaders(
    req('/v1/messages', { 'content-type': 'multipart/form-data; boundary=x' }),
    env,
    true,
    false,
    true,
  );
  assert.equal(h.get('content-type'), 'multipart/form-data; boundary=x');
});

test('流式透传且客户端没带 content-type 时不强加', () => {
  const h = buildAnthropicHeaders(req('/v1/messages'), env, true, false, true);
  assert.equal(h.get('content-type'), null);
});

test('GET /v1/models 不带 content-type', () => {
  const h = buildAnthropicHeaders(req('/v1/models', {}, 'GET'), env, true, false, false);
  assert.equal(h.get('content-type'), null);
});

// ── anthropic-beta：只在 /v1/messages 合并 ──

test('/v1/messages 合并 beta 全集（OAuth 含 oauth 标记）', () => {
  const h = buildAnthropicHeaders(req('/v1/messages'), env, true, true, true);
  const beta = h.get('anthropic-beta')!;
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(beta.includes('oauth-2025-04-20'));
});

test('x-api-key 模式不掺 oauth beta', () => {
  const h = buildAnthropicHeaders(req('/v1/messages'), env, false, true, true);
  const beta = h.get('anthropic-beta')!;
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(!beta.includes('oauth-2025-04-20'));
});

test('Claude Code 2.1.318 实测头不被追加旧 beta 或重排', () => {
  const apiBetas = 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,effort-2025-11-24';
  const oauthBetas = 'oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,claude-code-20250219,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,effort-2025-11-24,extended-cache-ttl-2025-04-11';
  for (const [useOAuth, beta] of [[false, apiBetas], [true, oauthBetas]] as const) {
    const incoming = {
      'user-agent': 'claude-cli/2.1.318 (external, sdk-cli)',
      'anthropic-beta': beta,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-app': 'cli',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v26.12.1',
      'x-claude-code-session-id': 'sample-session',
      'x-claude-code-wiggly-dove': 'client-integrity-value',
    };
    const h = buildAnthropicHeaders(req('/v1/messages', incoming), env, useOAuth, false, true);
    for (const [key, value] of Object.entries(incoming)) assert.equal(h.get(key), value, key);
  }
});

test('/v1/models 不动客户端的 beta，缺省不补', () => {
  const withBeta = buildAnthropicHeaders(
    req('/v1/models', { 'anthropic-beta': 'custom-beta-1' }, 'GET'),
    env, true, false, false,
  );
  assert.equal(withBeta.get('anthropic-beta'), 'custom-beta-1');
  const without = buildAnthropicHeaders(req('/v1/models', {}, 'GET'), env, true, false, false);
  assert.equal(without.get('anthropic-beta'), null);
});

// ── 认证头 ──

test('OAuth 用 Bearer 且清掉 x-api-key', () => {
  const h = buildAnthropicHeaders(req('/v1/messages', { 'x-api-key': 'client-key' }), env, true, true, true);
  assert.equal(h.get('authorization'), 'Bearer sk-ant-oat01-fake');
  assert.equal(h.get('x-api-key'), null);
});

test('API key 模式用 x-api-key 且清掉 authorization', () => {
  const h = buildAnthropicHeaders(req('/v1/messages', { authorization: 'Bearer x' }), env, false, true, true);
  assert.equal(h.get('x-api-key'), 'sk-ant-api03-fake');
  assert.equal(h.get('authorization'), null);
});

// ── 指纹优先级：客户端先，默认补缺口 ──

test('客户端自带 UA 透传，缺省时补默认/CLIENT_UA', () => {
  const own = buildAnthropicHeaders(req('/v1/messages', { 'user-agent': 'mine/1.0' }), env, true, true, true);
  assert.equal(own.get('user-agent'), 'mine/1.0');
  const filled = buildAnthropicHeaders(req('/v1/messages'), env, true, true, true);
  assert.ok(filled.get('user-agent')!.startsWith('claude-cli/'));
  assert.equal(clientUA({ CLIENT_UA: 'custom/9.9' } as any), 'custom/9.9');
});

// ── cloak 三种 system 形态 + 幂等 ──

const PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

test('cloak: 字符串 / 数组 / 缺省 / 幂等', () => {
  assert.ok(JSON.parse(cloakSystem('{"system":"原提示"}')).system.startsWith(PREFIX));
  const arr = JSON.parse(cloakSystem('{"system":[{"type":"text","text":"原提示"}]}'));
  assert.equal(arr.system[0].text, PREFIX);
  assert.equal(JSON.parse(cloakSystem('{"messages":[]}')).system, PREFIX);
  const once = cloakSystem('{"system":"原提示"}');
  assert.equal(cloakSystem(once), once);
  assert.equal(cloakSystem('not json'), 'not json');
});

test('/v1/messages 家族（count_tokens）合并 beta，非家族不合并', () => {
  const sub = buildAnthropicHeaders(req('/v1/messages/count_tokens'), env, true, true, true);
  assert.ok(sub.get('anthropic-beta')!.includes('claude-code-20250219'));
  const other = buildAnthropicHeaders(req('/v1/models'), env, true, false, false);
  assert.equal(other.get('anthropic-beta'), null);
});

// ── anthropicBody：cloak 只碰 messages 家族，二进制不损 ──

test('messages 家族 cloak 改写 JSON 并标 rewritten', async () => {
  const r = new Request('https://worker.example/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system: '原提示', messages: [] }),
  });
  const out = await anthropicBody(r, env, '/v1/messages');
  assert.equal(out.rewritten, true);
  assert.ok(JSON.parse(out.body as string).system.startsWith(PREFIX));
});

test('cloak 未改动（已有前缀）时 rewritten=false', async () => {
  const body = JSON.stringify({ system: PREFIX + '\n\n原提示', messages: [] });
  const r = new Request('https://worker.example/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const out = await anthropicBody(r, env, '/v1/messages');
  assert.equal(out.rewritten, false);
});

test('二进制/multipart（/v1/files）字节不损、不被标 JSON', async () => {
  const bytes = new Uint8Array([0, 255, 1, 128, 254, 0, 66]);
  const r = new Request('https://worker.example/v1/files', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    body: bytes,
  });
  const out = await anthropicBody(r, env, '/v1/files');
  assert.equal(out.rewritten, false);
  // 双凭据都在 → 走 arrayBuffer 缓冲，内容必须逐字节一致
  const got = new Uint8Array(out.body as ArrayBuffer);
  assert.deepEqual([...got], [...bytes]);
  const h = buildAnthropicHeaders(
    req('/v1/files', { 'content-type': 'multipart/form-data; boundary=x' }),
    env, true, out.rewritten, false,
  );
  assert.equal(h.get('content-type'), 'multipart/form-data; boundary=x');
});

test('GET 无 body', async () => {
  const out = await anthropicBody(req('/v1/models', {}, 'GET'), env, '/v1/models');
  assert.equal(out.body, undefined);
  assert.equal(out.rewritten, false);
});

// ── mergeBetas 去重 ──

test('mergeBetas 与客户端 beta 取并集且去重', () => {
  const merged = mergeBetas('claude-code-20250219,custom-x', true);
  const parts = merged.split(',');
  assert.equal(new Set(parts).size, parts.length);
  assert.ok(parts.includes('custom-x'));
  assert.ok(parts.includes('oauth-2025-04-20'));
});


// ── 2.1.1 字节透明：wiggly-dove 时代的自保 ──

test('cloak: system 数组带 billing 标记时字节级透传（CC 2.1.x 新形状）', () => {
  // 实测 Claude Code 2.1.304：system[0] 是 billing 块，前缀不再单独出现
  const real =
    '{"model":"claude-sonnet-4-5","system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.304.120; cc_entrypoint=sdk-cli;"},{"type":"text","text":"You are a Claude agent, built on Anthropic\'s Claude Agent SDK."}],"messages":[]}';
  assert.equal(cloakSystem(real), real);
});

test('cloak: 字符串前缀已带时保留 JSON 缩进与尾随换行', () => {
  const real = JSON.stringify({ system: PREFIX + '\n\n内容', messages: [] }, null, 2) + '\n';
  assert.equal(cloakSystem(real), real);
});

test('cloak: 数组首块带前缀时保留 JSON 缩进与尾随换行', () => {
  const real = JSON.stringify({ system: [{ type: 'text', text: PREFIX }], messages: [] }, null, 2) + '\n';
  assert.equal(cloakSystem(real), real);
});

test('anthropicBody: 已识别的 system 形态保留正文格式且不标 rewritten', async () => {
  for (const system of [
    PREFIX + '\n\n内容',
    [{ type: 'text', text: PREFIX }],
    [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.304.120; cc_entrypoint=sdk-cli;' },
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
    ],
  ]) {
    const body = JSON.stringify({ system, messages: [] }, null, 2) + '\n';
    const r = new Request('https://worker.example/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body,
    });
    const out = await anthropicBody(r, env, '/v1/messages');
    assert.deepEqual(new Uint8Array(out.body as ArrayBuffer), new TextEncoder().encode(body));
    assert.equal(out.rewritten, false);
    const headers = buildAnthropicHeaders(r, env, true, out.rewritten, true);
    assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  }
});

test('cloak: 裸客户端数组无前缀无 billing 才注入', () => {
  const out = JSON.parse(cloakSystem('{"system":[{"type":"text","text":"原提示"}],"messages":[]}'));
  assert.equal(out.system[0].text, PREFIX);
});

test('mergeBetas 客户端已覆盖时原样透传（不重排）', () => {
  const covered =
    'custom-first, claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,effort-2025-11-24,oauth-2025-04-20,extended-cache-ttl-2025-04-11';
  assert.equal(mergeBetas(covered, true), covered);
});

test('mergeBetas 缺项时保持客户端顺序、缺失追加在后', () => {
  const merged = mergeBetas('my-beta,claude-code-20250219', false);
  const parts = merged.split(',');
  assert.equal(parts[0], 'my-beta');
  assert.equal(parts[1], 'claude-code-20250219');
  assert.ok(parts.includes('interleaved-thinking-2025-05-14'));
});

// ── 2.1.1 头部卫生：IP 泄漏面补齐 ──

test('forwarded / via / envoy 系 IP 头被剥掉', () => {
  const h = buildAnthropicHeaders(
    req('/v1/messages', {
      forwarded: 'for=203.0.113.7;proto=https',
      via: '1.1 some-proxy',
      'x-cluster-client-ip': '203.0.113.7',
      'x-envoy-external-address': '203.0.113.7',
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-client-ip': '203.0.113.8',
      'x-forwarded-for-original': '203.0.113.9',
      'true-client-ip': '203.0.113.7',
      'cf-connecting-ip': '203.0.113.7',
      'cf-ipcountry': 'CN',
    }),
    env, true, true, true,
  );
  for (const k of ['forwarded', 'via', 'x-cluster-client-ip', 'x-envoy-external-address',
    'x-forwarded-for', 'x-forwarded-client-ip', 'x-forwarded-for-original', 'true-client-ip', 'cf-connecting-ip', 'cf-ipcountry']) {
    assert.equal(h.get(k), null, `${k} 应该被剥掉`);
  }
});

test('CLOAK=false 保留正文和客户端标记，仍剥代理头与替换认证', async () => {
  const rawEnv = { ...env, CLOAK: 'false', CLIENT_UA: 'ignored/1' };
  const bytes = new Uint8Array([0, 255, 128, 123, 125]);
  const r = new Request('https://worker.example/v1/messages', {
    method: 'POST', body: bytes,
    headers: {
      'x-api-key': env.PROXY_API_KEY,
      'anthropic-beta': 'custom-beta',
      'x-stainless-lang': 'typescript',
      'x-anthropic-billing-header': 'client-value',
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-client-ip': '203.0.113.7',
    },
  });
  const out = await anthropicBody(r, rawEnv, '/v1/messages');
  assert.equal(out.rewritten, false);
  assert.deepEqual(new Uint8Array(out.body as ArrayBuffer), bytes);
  const h = buildAnthropicHeaders(r, rawEnv, true, out.rewritten, true);
  assert.equal(h.get('authorization'), `Bearer ${env.CLAUDE_OAUTH_TOKEN}`);
  assert.equal(h.get('x-api-key'), null);
  assert.equal(h.get('anthropic-beta'), 'custom-beta');
  assert.equal(h.get('x-stainless-lang'), 'typescript');
  assert.equal(h.get('x-anthropic-billing-header'), 'client-value');
  for (const name of ['cf-connecting-ip', 'x-forwarded-client-ip', 'user-agent', 'x-app', 'anthropic-version', 'accept', 'content-type']) {
    assert.equal(h.get(name), null, name);
  }
  const health = await handleHealth(rawEnv, true).json() as any;
  assert.equal(health.routes.anthropic.signature, null);
  assert.equal(health.routes.anthropic.clientUA, null);
});

test('批请求不注入顶层 system，也不追加兼容 beta', async (t) => {
  const body = JSON.stringify({ requests: [{ custom_id: 'one', params: { system: 'mine', messages: [] } }] });
  const upstream = t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(new TextDecoder().decode(init.body as ArrayBuffer), body);
    assert.equal(new Headers(init.headers).get('anthropic-beta'), 'batch-beta');
    return new Response('{}');
  });
  const r = await worker.fetch(new Request('https://worker.example/proxy/v1/messages/batches', {
    method: 'POST', body,
    headers: { 'x-api-key': env.PROXY_API_KEY, 'anthropic-beta': 'batch-beta' },
  }), env);
  assert.equal(r.status, 200);
  assert.equal(upstream.mock.callCount(), 1);
});

test('gzip 正文在 OAuth 401 回退后仍逐字节一致', async (t) => {
  const bytes = gzipSync('{"messages":[],"system":"mine"}');
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const h = new Headers(init.headers);
    assert.deepEqual(new Uint8Array(init.body as ArrayBuffer), new Uint8Array(bytes));
    assert.equal(h.get('content-encoding'), 'gzip');
    assert.equal(h.get('content-type'), 'application/json');
    if (++calls === 1) {
      assert.equal(h.get('authorization'), `Bearer ${env.CLAUDE_OAUTH_TOKEN}`);
      return new Response('expired', { status: 401 });
    }
    assert.equal(h.get('x-api-key'), env.ANTHROPIC_API_KEY);
    assert.equal(h.get('authorization'), null);
    assert.ok(!h.get('anthropic-beta')!.includes('oauth-2025-04-20'));
    return new Response('ok');
  });
  const r = await worker.fetch(new Request('https://worker.example/v1/messages', {
    method: 'POST', body: bytes,
    headers: { 'x-api-key': env.PROXY_API_KEY, 'content-encoding': 'gzip', 'content-type': 'application/json' },
  }), env);
  assert.equal(await r.text(), 'ok');
  assert.equal(calls, 2);
});

test('单凭据无需改写时保留流，不受缓冲上限影响', async () => {
  const singleEnv = { PROXY_API_KEY: env.PROXY_API_KEY, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY };
  for (const [path, headers, config] of [
    ['/v1/files', {}, singleEnv],
    ['/v1/messages', { 'content-encoding': 'gzip' }, singleEnv],
    ['/v1/messages', {}, { ...singleEnv, CLOAK: 'false' }],
  ] as const) {
    const r = new Request(`https://worker.example${path}`, {
      method: 'POST', headers, body: new Uint8Array(16 * 1024 * 1024 + 1),
    });
    const out = await anthropicBody(r, config, path);
    assert.equal(out.body, r.body);
    assert.equal(r.bodyUsed, false);
    await r.body!.cancel();
  }
});

test('改写和回退缓冲均在实际正文超限时返回 413', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async () => new Response('unexpected'));
  for (const [path, config] of [
    ['/v1/messages', { ...env, ANTHROPIC_API_KEY: undefined }],
    ['/v1/files', env],
  ] as const) {
    let canceled = false;
    let count = 0;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(count++ < 16 ? 1024 * 1024 : 1));
      },
      cancel() { canceled = true; },
    });
    const r = await worker.fetch(new Request(`https://worker.example${path}`, {
      method: 'POST', body, duplex: 'half',
      headers: { 'x-api-key': env.PROXY_API_KEY, 'content-length': '1' },
    } as RequestInit), config);
    assert.equal(r.status, 413);
    assert.equal(canceled, true);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test('16 MiB 正文仍可缓冲', async () => {
  const r = new Request('https://worker.example/v1/files', {
    method: 'POST', body: new Uint8Array(16 * 1024 * 1024),
  });
  const out = await anthropicBody(r, env, '/v1/files');
  assert.equal((out.body as ArrayBuffer).byteLength, 16 * 1024 * 1024);
});

test('上游错误流无需结束即可返回，日志不读取敏感正文', { timeout: 1000 }, async (t) => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  t.after(() => controller.close());
  const log = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 400 }));
  const r = await worker.fetch(new Request('https://worker.example/v1/messages', {
    method: 'POST', body: '{"system":"private-input"}',
    headers: { 'x-api-key': env.PROXY_API_KEY, 'user-agent': 'private-ua' },
  }), env);
  assert.equal(r.status, 400);
  const entry = JSON.parse(log.mock.calls[0].arguments[0]);
  assert.equal(entry.upstreamStatus, 400);
  assert.equal(entry.detail, undefined);
  assert.equal(entry.ua, undefined);
  controller!.enqueue(new TextEncoder().encode('private-upstream-error'));
  const reader = r.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'private-upstream-error');
  reader.releaseLock();
});

test('异常原文不进入日志或 502 响应', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-token-and-input'); });
  const r = await worker.fetch(req('/v1/models', { 'x-api-key': env.PROXY_API_KEY }, 'GET'), env);
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: 'upstream request failed' });
  assert.ok(!JSON.stringify(log.mock.calls).includes('private-token-and-input'));
});
