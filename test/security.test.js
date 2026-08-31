const { describe, test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createApp } = require('../src/api');
const { createRateLimitStore } = require('../src/entities/rateLimitStore');
const vercelConfig = require('../vercel.json');
const {
  originDecision,
  parseOrigin,
  requestSizeDecision,
  securityPolicyFrom,
} = require('../src/security');

const closeServer = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

const startApp = async (t, securityOptions = {}) => {
  const server = await new Promise((resolve) => {
    const listening = createApp({ securityOptions }).listen(0, () => resolve(listening));
  });
  t.after(() => closeServer(server));
  return server;
};

const request = (server) => ({
  method = 'GET',
  path = '/',
  headers = {},
  body,
} = {}) =>
  new Promise((resolve, reject) => {
    const address = server.address();
    const client = http.request({
      host: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers,
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const isJson = /application\/json/u.test(response.headers['content-type'] ?? '');
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text,
          body: isJson && text ? JSON.parse(text) : null,
        });
      });
    });
    client.on('error', reject);
    body === undefined ? client.end() : client.end(body);
  });

describe('security policy core', () => {
  test('origin parsing accepts canonical origins and rejects smuggled shapes', () => {
    assert.deepEqual(parseOrigin('https://portfolio.sdin.dev'), {
      tag: 'valid',
      origin: 'https://portfolio.sdin.dev',
      protocol: 'https:',
      hostname: 'portfolio.sdin.dev',
      port: '',
    });
    assert.deepEqual(parseOrigin('https://portfolio.sdin.dev/path'), { tag: 'invalid' });
    assert.deepEqual(parseOrigin('https://user@portfolio.sdin.dev'), { tag: 'invalid' });
    assert.deepEqual(parseOrigin('null'), { tag: 'invalid' });
  });

  test('restricted policy preserves required, configured, local, and native clients', () => {
    const policy = securityPolicyFrom({
      env: {},
      cors: {
        allowPublicRead: false,
        allowedOrigins: ['https://client.example'],
      },
    }).cors;
    const decide = originDecision(policy);

    assert.equal(decide('https://portfolio.sdin.dev').tag, 'allowed');
    assert.equal(decide('https://sdin.dev').tag, 'allowed');
    assert.equal(decide('https://client.example').tag, 'allowed');
    assert.equal(decide('http://localhost:8081').tag, 'allowed');
    assert.equal(decide('http://127.0.0.1:19006').tag, 'allowed');
    assert.equal(decide(undefined).tag, 'allowed');
    assert.equal(decide('https://unrelated.example').tag, 'denied');
  });

  test('environment policy values are validated and composed with required origins', () => {
    const policy = securityPolicyFrom({
      env: {
        API_CORS_ORIGINS: 'https://one.example, https://two.example/path',
        API_CORS_PUBLIC_READ: 'false',
        API_CLIENT_IP_SOURCE: 'vercel',
        API_MAX_REQUEST_BYTES: '2048',
        API_RATE_LIMIT_MAX: '7',
        API_RATE_LIMIT_WINDOW_MS: '2500',
        API_RATE_LIMIT_MAX_CLIENTS: '40',
      },
    });

    assert.equal(policy.clientIpSource, 'vercel');
    assert.equal(policy.cors.allowPublicRead, false);
    assert.deepEqual(policy.cors.allowedOrigins, [
      'https://portfolio.sdin.dev',
      'https://sdin.dev',
      'https://one.example',
    ]);
    assert.equal(policy.maxRequestBytes, 2048);
    assert.deepEqual(policy.rateLimit, {
      limit: 7,
      windowMs: 2500,
      maxClients: 40,
    });
  });

  test('Vercel deployment explicitly selects its trusted client-IP boundary', () => {
    assert.equal(vercelConfig.env.API_CLIENT_IP_SOURCE, 'vercel');
    assert.equal(securityPolicyFrom({ env: vercelConfig.env }).clientIpSource, 'vercel');
    assert.equal(securityPolicyFrom({ env: {} }).clientIpSource, 'socket');
  });

  test('request-size decisions reject malformed, chunked, and oversized requests', () => {
    const decide = requestSizeDecision(8);

    assert.equal(decide({ contentLength: '8' }).tag, 'allowed');
    assert.equal(decide({ contentLength: '9' }).tag, 'oversized');
    assert.equal(decide({ contentLength: 'wat' }).tag, 'invalid');
    assert.equal(decide({ transferEncoding: 'chunked' }).tag, 'oversized');
  });

  test('rate-limit state evicts the least-recent client while refreshing existing keys', () => {
    let clock = 0;
    const transition = (observedAt) => (history) => ({
      allowed: true,
      history: [...history, observedAt],
      observedAt,
      remaining: 1,
      resetAt: observedAt + 1000,
    });
    const store = createRateLimitStore(() => clock)(transition)(2);

    assert.deepEqual(store.consume('alpha').history, [0]);
    clock = 1;
    assert.deepEqual(store.consume('beta').history, [1]);
    clock = 2;
    assert.deepEqual(store.consume('alpha').history, [0, 2]);
    clock = 3;
    assert.deepEqual(store.consume('gamma').history, [3]);
    clock = 4;
    assert.deepEqual(store.consume('beta').history, [4]);
  });
});

describe('security HTTP boundary', () => {
  test('sets API-safe Helmet headers and removes the Express fingerprint', async (t) => {
    const server = await startApp(t);
    const response = await request(server)({ path: '/status' });

    assert.equal(response.status, 200);
    assert.equal(response.headers['x-powered-by'], undefined);
    assert.match(response.headers['content-security-policy'], /default-src 'none'/u);
    assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
    assert.match(response.headers['strict-transport-security'], /max-age=/u);
    assert.equal(response.headers['x-xss-protection'], '0');
  });

  test('keeps public reads and native requests compatible by default', async (t) => {
    const server = await startApp(t);
    const publicRead = await request(server)({
      path: '/data',
      headers: { Origin: 'https://public-client.example' },
    });
    const nativeRead = await request(server)({ path: '/data' });
    const opaqueOrigin = await request(server)({
      path: '/data',
      headers: { Origin: 'null' },
    });

    assert.equal(publicRead.status, 200);
    assert.equal(publicRead.headers['access-control-allow-origin'], '*');
    assert.match(publicRead.headers.vary, /Origin/u);
    assert.equal(nativeRead.status, 200);
    assert.equal(nativeRead.headers['access-control-allow-origin'], '*');
    assert.match(nativeRead.headers.vary, /Origin/u);
    assert.equal(opaqueOrigin.status, 200);
    assert.equal(opaqueOrigin.headers['access-control-allow-origin'], undefined);
    assert.match(opaqueOrigin.headers.vary, /Origin/u);
  });

  test('restricted CORS reflects allowed origins and omits headers for denied origins', async (t) => {
    const server = await startApp(t, {
      cors: {
        allowPublicRead: false,
        allowedOrigins: ['https://client.example'],
      },
    });
    const origins = [
      'https://portfolio.sdin.dev',
      'https://sdin.dev',
      'https://client.example',
      'http://localhost:8081',
    ];
    const allowed = await Promise.all(origins.map((origin) =>
      request(server)({ path: '/data', headers: { Origin: origin } })
    ));
    const denied = await request(server)({
      path: '/data',
      headers: { Origin: 'https://unrelated.example' },
    });
    const nativeRead = await request(server)({ path: '/data' });

    allowed.forEach((response, index) => {
      assert.equal(response.status, 200);
      assert.equal(response.headers['access-control-allow-origin'], origins[index]);
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    assert.match(denied.headers.vary, /Origin/u);
    assert.equal(nativeRead.status, 200);
    assert.equal(nativeRead.headers['access-control-allow-origin'], undefined);
    assert.match(nativeRead.headers.vary, /Origin/u);
  });

  test('answers allowed and denied preflights without opening unsupported methods', async (t) => {
    const server = await startApp(t, { cors: { allowPublicRead: false } });
    const allowed = await request(server)({
      method: 'OPTIONS',
      path: '/data',
      headers: {
        Origin: 'https://portfolio.sdin.dev',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const denied = await request(server)({
      method: 'OPTIONS',
      path: '/data',
      headers: {
        Origin: 'https://unrelated.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    const unsupported = await request(server)({
      method: 'OPTIONS',
      path: '/data',
      headers: {
        Origin: 'https://portfolio.sdin.dev',
        'Access-Control-Request-Method': 'POST',
      },
    });

    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers['access-control-allow-origin'], 'https://portfolio.sdin.dev');
    assert.match(allowed.headers['access-control-allow-methods'], /GET/u);
    assert.match(allowed.headers['access-control-allow-methods'], /HEAD/u);
    assert.equal(denied.status, 204);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.allow, 'GET, HEAD, OPTIONS');
  });

  test('rejects unsupported methods with a JSON 405 and Allow contract', async (t) => {
    const server = await startApp(t);
    const response = await request(server)({ method: 'POST', path: '/data' });

    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD, OPTIONS');
    assert.equal(response.headers['ratelimit-limit'], '120');
    assert.match(response.headers['cache-control'], /no-store/u);
    assert.deepEqual(response.body, {
      error: 'Method Not Allowed',
      allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
    });
  });

  test('rejects declared and chunked request bodies above the configured bound', async (t) => {
    const server = await startApp(t, { maxRequestBytes: 8 });
    const declared = await request(server)({
      path: '/data',
      headers: { 'Content-Length': '9' },
    });
    const chunked = await request(server)({
      path: '/data',
      headers: { 'Transfer-Encoding': 'chunked' },
      body: '123456789',
    });
    const unsupported = await request(server)({
      method: 'POST',
      path: '/data',
      headers: { 'Content-Length': '9' },
    });

    [declared, chunked, unsupported].forEach((response) => {
      assert.equal(response.status, 413);
      assert.equal(response.headers['ratelimit-limit'], '120');
      assert.match(response.headers['cache-control'], /no-store/u);
      assert.deepEqual(response.body, {
        error: 'Payload Too Large',
        limitBytes: 8,
      });
    });
  });

  test('rate limits per client with deterministic standard headers and reset', async (t) => {
    let clock = 0;
    const server = await startApp(t, {
      now: () => clock,
      clientKey: (req) => req.get('x-test-client') ?? 'anonymous',
      rateLimit: { limit: 2, windowMs: 1000, maxClients: 10 },
    });
    const forClient = (client) => request(server)({
      path: '/status',
      headers: { 'X-Test-Client': client },
    });

    const first = await forClient('alpha');
    const second = await forClient('alpha');
    const blocked = await forClient('alpha');
    const independent = await forClient('beta');
    clock = 1000;
    const reset = await forClient('alpha');

    assert.equal(first.status, 200);
    assert.equal(first.headers['ratelimit-policy'], '2;w=1');
    assert.equal(first.headers['ratelimit-limit'], '2');
    assert.equal(first.headers['ratelimit-remaining'], '1');
    assert.equal(first.headers['ratelimit-reset'], '1');
    assert.equal(second.headers['ratelimit-remaining'], '0');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['retry-after'], '1');
    assert.deepEqual(blocked.body, {
      error: 'Too Many Requests',
      retryAfterSeconds: 1,
    });
    assert.equal(independent.status, 200);
    assert.equal(independent.headers['ratelimit-remaining'], '1');
    assert.equal(reset.status, 200);
    assert.equal(reset.headers['ratelimit-remaining'], '1');
  });

  test('uses socket identity by default and ignores attacker-supplied forwarding headers', async (t) => {
    const server = await startApp(t, {
      rateLimit: { limit: 1, windowMs: 1000, maxClients: 10 },
    });
    const first = await request(server)({
      path: '/status',
      headers: { 'X-Forwarded-For': '198.51.100.10' },
    });
    const second = await request(server)({
      path: '/status',
      headers: { 'X-Forwarded-For': '203.0.113.20' },
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
  });

  test('uses only a valid single Vercel client IP when that boundary is explicit', async (t) => {
    const server = await startApp(t, {
      clientIpSource: 'vercel',
      rateLimit: { limit: 1, windowMs: 1000, maxClients: 10 },
    });
    const validFirst = await request(server)({
      path: '/status',
      headers: {
        'X-Vercel-Forwarded-For': '198.51.100.10',
        'X-Forwarded-For': '192.0.2.10',
      },
    });
    const validSecond = await request(server)({
      path: '/status',
      headers: {
        'X-Vercel-Forwarded-For': '203.0.113.20',
        'X-Forwarded-For': '192.0.2.10',
      },
    });
    const socketFallback = await request(server)({
      path: '/status',
      headers: { 'X-Forwarded-For': '198.51.100.30' },
    });
    const malformedFallback = await request(server)({
      path: '/status',
      headers: {
        'X-Vercel-Forwarded-For': '198.51.100.30, 203.0.113.40',
        'X-Forwarded-For': '203.0.113.50',
      },
    });

    assert.equal(validFirst.status, 200);
    assert.equal(validSecond.status, 200);
    assert.equal(socketFallback.status, 200);
    assert.equal(malformedFallback.status, 429);
  });

  test('accepts an injected store and fails closed without leaking store errors', async (t) => {
    const keys = [];
    const acceptingStore = {
      consume: (key) => {
        keys.push(key);
        return {
          allowed: true,
          observedAt: 0,
          remaining: 4,
          resetAt: 1000,
        };
      },
    };
    const acceptingServer = await startApp(t, {
      clientKey: () => 'injected-client',
      rateLimitStore: acceptingStore,
      rateLimit: { limit: 5, windowMs: 1000 },
    });
    const accepted = await request(acceptingServer)({ path: '/status' });

    assert.equal(accepted.status, 200);
    assert.deepEqual(keys, ['injected-client']);

    const failingServer = await startApp(t, {
      rateLimitStore: { consume: () => { throw new Error('private store detail'); } },
    });
    const failed = await request(failingServer)({ path: '/status' });

    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, { error: 'Service Unavailable' });
    assert.doesNotMatch(failed.text, /private store detail/u);
  });

  test('preserves GET, HEAD, status, authored-data, and JSON 404 behavior', async (t) => {
    const server = await startApp(t);
    const status = await request(server)({ path: '/status' });
    const data = await request(server)({ path: '/data' });
    const head = await request(server)({ method: 'HEAD', path: '/data' });
    const missing = await request(server)({ path: '/missing-security-regression' });

    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'OK');
    assert.match(status.headers['cache-control'], /no-store/u);
    assert.equal(data.status, 200);
    assert.equal(typeof data.body.brandName, 'string');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'Not Found');
  });
});
