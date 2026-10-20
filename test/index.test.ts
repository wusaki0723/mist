// mist 回归测试：node --experimental-strip-types --test test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicUrl,
  anthropicBody,
  buildAnthropicHeaders,
  cloakSystem,
  mergeBetas,
  clientUA,
} from '../src/index.ts';

const env = {
  PROXY_API_KEY: 'test-proxy-key',
  CLAUDE_OAUTH_TOKEN: 'sk-ant-oat01-fake',
  ANTHROPIC_API_KEY: 'sk-ant-api03-fake',
} as any;

function req(path: string, headers: Record<string, string> = {}, method = 'POST') {
  return new Request(`https://worker.example${path}`, { method, headers });
}

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
    assert.equal(out.body, body);
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
    'custom-first,claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,thinking-display-updates-2026-08-18,oauth-2025-04-20';
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
      'true-client-ip': '203.0.113.7',
      'cf-connecting-ip': '203.0.113.7',
      'cf-ipcountry': 'CN',
    }),
    env, true, true, true,
  );
  for (const k of ['forwarded', 'via', 'x-cluster-client-ip', 'x-envoy-external-address',
    'x-forwarded-for', 'true-client-ip', 'cf-connecting-ip', 'cf-ipcountry']) {
    assert.equal(h.get(k), null, `${k} 应该被剥掉`);
  }
});
