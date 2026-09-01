const { describe, test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createApp } = require('../src/api');
const {
  clientRequestObserved,
  createRateLimitHistoryStore,
  createRateLimitStore,
  rateLimitSelectors,
} = require('../src/entities/rateLimitStore');
const vercelConfig = require('../vercel.json');
const {
  originDecision,
  parseOrigin,
  rateLimitDecisionIsValid,
  requestSizeDecision,
  securityPolicyFrom,
  securityValuesValidationFrom,
} = require('../src/security');
const {
  acceptDecision,
  authorityDecision,
  contentTypeDecision,
  parseHost,
  requestIdDecision,
  requestTargetDecision,
} = require('../src/systems/securityPerimeter');

const quietLogger = Object.freeze({
  error: () => undefined,
  warn: () => undefined,
});

const closeServer = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

const startApp = async (t, securityOptions = {}) => {
  const server = await new Promise((resolve) => {
    const listening = createApp({
      logger: quietLogger,
      securityOptions,
    }).listen(0, () => resolve(listening));
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
        API_ALLOWED_HOSTS: 'api.internal.example',
        API_ALLOW_VERCEL_PREVIEWS: 'false',
        API_CORS_ORIGINS: 'https://one.example',
        API_CORS_PUBLIC_READ: 'false',
        API_CLIENT_IP_SOURCE: 'vercel',
        API_MAX_REQUEST_BYTES: '2048',
        API_MAX_REQUEST_TARGET_BYTES: '1024',
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
    assert.deepEqual(policy.hosts, {
      allowedHosts: [
        'api.sdin.dev',
        'localhost',
        '127.0.0.1',
        '[::1]',
        'api.internal.example',
      ],
      allowVercelPreviews: false,
    });
    assert.equal(policy.maxRequestBytes, 2048);
    assert.equal(policy.maxRequestTargetBytes, 1024);
    assert.deepEqual(policy.rateLimit, {
      limit: 7,
      windowMs: 2500,
      maxClients: 40,
    });
  });

  test('invalid explicit security configuration accumulates failures and cannot start', () => {
    const validation = securityValuesValidationFrom({
      env: {
        API_ALLOWED_HOSTS: 'https://not-a-host.example/path',
        API_CORS_ORIGINS: 'https://client.example/path',
        API_CORS_PUBLIC_READ: 'sometimes',
        API_CLIENT_IP_SOURCE: 'forwarded-for',
        API_MAX_REQUEST_BYTES: '-1',
        API_RATE_LIMIT_MAX: '0',
      },
    });

    assert.equal(validation._tag, 'Failure');
    assert.deepEqual(validation.errors, [
      'API_CLIENT_IP_SOURCE',
      'API_CORS_PUBLIC_READ',
      'API_CORS_ORIGINS',
      'API_ALLOWED_HOSTS',
      'API_MAX_REQUEST_BYTES',
      'API_RATE_LIMIT_MAX',
    ]);
    assert.throws(
      () => securityPolicyFrom({
        env: {
          API_CORS_PUBLIC_READ: 'sometimes',
          API_MAX_REQUEST_BYTES: 'invalid',
        },
      }),
      /Invalid security configuration: API_CORS_PUBLIC_READ, API_MAX_REQUEST_BYTES/u
    );
  });

  test('request perimeter admits only unveiled hosts, bounded targets, and JSON negotiation', () => {
    const hostPolicy = securityPolicyFrom({ env: {} }).hosts;

    assert.deepEqual(parseHost('api.sdin.dev:443'), {
      tag: 'valid',
      hostname: 'api.sdin.dev',
      port: '443',
    });
    assert.equal(authorityDecision(hostPolicy)('api.sdin.dev').tag, 'allowed');
    assert.equal(authorityDecision(hostPolicy)('api-preview.vercel.app').tag, 'allowed');
    assert.equal(authorityDecision(hostPolicy)('api.sdin.dev.attacker.example').status, 421);
    assert.deepEqual(parseHost('2130706433'), { tag: 'invalid' });
    assert.equal(requestTargetDecision(32)('/data?fresh=1').tag, 'allowed');
    assert.equal(requestTargetDecision(8)('/12345678').status, 400);
    assert.equal(requestTargetDecision(32)('//attacker.example/data').status, 400);
    assert.equal(requestTargetDecision(32)('/bad%zz').status, 400);
    assert.equal(requestTargetDecision(32)('/bad%00target').status, 400);
    assert.equal(requestTargetDecision(32)('/bad%5ctarget').status, 400);
    assert.equal(requestTargetDecision(32)('/one//two').status, 400);
    assert.equal(requestTargetDecision(32)('/one/../data').status, 400);
    assert.equal(requestTargetDecision(32)('/%64ata').status, 400);
    assert.equal(requestTargetDecision(32)('/data?x=%00').status, 400);
    assert.equal(acceptDecision('application/json').tag, 'allowed');
    assert.equal(acceptDecision('text/html').status, 406);
    assert.equal(acceptDecision('application/json;q=0').status, 406);
    assert.equal(contentTypeDecision('application/json; charset=utf-8').tag, 'allowed');
    assert.equal(contentTypeDecision('text/plain').status, 415);
  });

  test('request IDs and rate decisions fail closed when an invariant is missing', () => {
    const policy = { limit: 2 };
    const validDecision = {
      allowed: true,
      observedAt: 0,
      remaining: 1,
      resetAt: 1000,
    };

    assert.equal(
      requestIdDecision(() => '123e4567-e89b-42d3-a456-426614174000').tag,
      'allowed'
    );
    assert.equal(requestIdDecision(() => 'attacker-controlled').status, 503);
    assert.equal(requestIdDecision(() => { throw new Error('entropy unavailable'); }).status, 503);
    assert.equal(rateLimitDecisionIsValid(policy)(validDecision), true);
    assert.equal(rateLimitDecisionIsValid(policy)({ ...validDecision, remaining: 3 }), false);
    assert.equal(rateLimitDecisionIsValid(policy)({ ...validDecision, resetAt: -1 }), false);
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
    const store = createRateLimitStore(() => clock)({
      limit: 10,
      windowMs: 1000,
      maxClients: 2,
    });

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

  test('RTK selectors project admission, remaining capacity, and reset from serializable history', () => {
    const historyStore = createRateLimitHistoryStore({
      limit: 2,
      windowMs: 1000,
      maxClients: 2,
    });
    const observe = (observedAt) =>
      historyStore.dispatch(clientRequestObserved({ clientKey: 'alpha', observedAt }));

    observe(0);
    assert.equal(rateLimitSelectors.selectAdmission(historyStore.getState(), 'alpha'), true);
    assert.equal(rateLimitSelectors.selectRemaining(historyStore.getState(), 'alpha'), 1);
    assert.equal(rateLimitSelectors.selectResetAt(historyStore.getState(), 'alpha'), 1000);

    observe(1);
    observe(2);
    const state = historyStore.getState();

    assert.equal(rateLimitSelectors.selectAdmission(state, 'alpha'), false);
    assert.equal(rateLimitSelectors.selectRemaining(state, 'alpha'), 0);
    assert.equal(rateLimitSelectors.selectResetAt(state, 'alpha'), 1000);
    assert.deepEqual(rateLimitSelectors.selectClientHistory(state, 'alpha'), [0, 1]);
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    assert.equal(clientRequestObserved.type, 'rateLimit/clientRequestObserved');
  });
});

describe('security HTTP boundary', () => {
  test('sets API-safe Helmet headers and removes the Express fingerprint', async (t) => {
    const server = await startApp(t);
    const response = await request(server)({ path: '/status' });

    assert.equal(response.status, 200);
    assert.equal(response.headers['x-powered-by'], undefined);
    assert.match(response.headers['content-type'], /^application\/json; charset=utf-8/u);
    assert.match(response.headers['content-security-policy'], /default-src 'none'/u);
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(response.headers['origin-agent-cluster'], '?1');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.match(response.headers['strict-transport-security'], /max-age=31536000/u);
    assert.match(response.headers['strict-transport-security'], /includeSubDomains/u);
    assert.match(response.headers['strict-transport-security'], /preload/u);
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(response.headers['permissions-policy'], /camera=\(\)/u);
    assert.equal(response.headers['cdn-cache-control'], 'no-store');
    assert.equal(response.headers['vercel-cdn-cache-control'], 'no-store');
    assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/u);
    assert.match(response.headers['access-control-expose-headers'], /X-Request-ID/u);
    assert.equal(response.headers['x-permitted-cross-domain-policies'], 'none');
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
    assert.equal(opaqueOrigin.status, 403);
    assert.equal(opaqueOrigin.headers['access-control-allow-origin'], undefined);
    assert.equal(opaqueOrigin.headers['ratelimit-limit'], '120');
    assert.deepEqual(opaqueOrigin.body, { error: 'Forbidden' });
    assert.match(opaqueOrigin.headers.vary, /Origin/u);
  });

  test('restricted CORS reflects allowed origins and fails closed for denied origins', async (t) => {
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
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    assert.equal(denied.headers['ratelimit-limit'], '120');
    assert.match(denied.headers.vary, /Origin/u);
    assert.deepEqual(denied.body, { error: 'Forbidden' });
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
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    assert.equal(denied.headers['ratelimit-limit'], '120');
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.allow, 'GET, HEAD, OPTIONS');
  });

  test('rejects authority, target, and representation capabilities outside the perimeter', async (t) => {
    const server = await startApp(t, { maxRequestTargetBytes: 8 });
    const wrongAuthority = await request(server)({
      path: '/data',
      headers: { Host: 'api.sdin.dev.attacker.example' },
    });
    const longTarget = await request(server)({ path: '/request-target-is-too-long' });
    const unacceptable = await request(server)({
      path: '/data',
      headers: { Accept: 'text/html' },
    });
    const unsupportedMedia = await request(server)({
      path: '/data',
      headers: { 'Content-Type': 'text/plain' },
    });

    assert.equal(wrongAuthority.status, 421);
    assert.deepEqual(wrongAuthority.body, { error: 'Misdirected Request' });
    assert.equal(longTarget.status, 400);
    assert.deepEqual(longTarget.body, { error: 'Bad Request' });
    assert.equal(unacceptable.status, 406);
    assert.deepEqual(unacceptable.body, { error: 'Not Acceptable' });
    assert.equal(unsupportedMedia.status, 415);
    assert.deepEqual(unsupportedMedia.body, { error: 'Unsupported Media Type' });
    [wrongAuthority, longTarget, unacceptable, unsupportedMedia].forEach((response) => {
      assert.match(response.headers['cache-control'], /no-store/u);
      assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/u);
    });
  });

  test('rate limits preflights and fails closed when request identity cannot be created', async (t) => {
    const rateServer = await startApp(t, {
      clientKey: () => 'one-client',
      rateLimit: { limit: 1, windowMs: 1000, maxClients: 2 },
    });
    const accepted = await request(rateServer)({ path: '/status' });
    const blockedPreflight = await request(rateServer)({
      method: 'OPTIONS',
      path: '/data',
      headers: {
        Origin: 'https://portfolio.sdin.dev',
        'Access-Control-Request-Method': 'GET',
      },
    });
    const identityServer = await startApp(t, {
      createRequestId: () => 'invalid',
    });
    const identityFailure = await request(identityServer)({ path: '/status' });

    assert.equal(accepted.status, 200);
    assert.equal(blockedPreflight.status, 429);
    assert.equal(blockedPreflight.headers['access-control-allow-origin'], '*');
    assert.deepEqual(blockedPreflight.body, {
      error: 'Too Many Requests',
      retryAfterSeconds: 1,
    });
    assert.equal(identityFailure.status, 503);
    assert.deepEqual(identityFailure.body, { error: 'Service Unavailable' });
    assert.equal(identityFailure.headers['x-request-id'], undefined);
    assert.match(identityFailure.headers['permissions-policy'], /camera=\(\)/u);
    assert.equal(identityFailure.headers['vercel-cdn-cache-control'], 'no-store');
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

    const malformedServer = await startApp(t, {
      rateLimitStore: {
        consume: () => ({
          allowed: true,
          observedAt: 0,
          remaining: 10_000,
          resetAt: 1000,
        }),
      },
    });
    const malformed = await request(malformedServer)({ path: '/status' });

    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, { error: 'Service Unavailable' });
    assert.doesNotMatch(failed.text, /private store detail/u);
    assert.equal(malformed.status, 503);
    assert.deepEqual(malformed.body, { error: 'Service Unavailable' });
  });

  test('security rejection remains available when the audit logger fails', async (t) => {
    const server = await new Promise((resolve) => {
      const listening = createApp({
        logger: {
          error: () => undefined,
          warn: () => { throw new Error('logger unavailable'); },
        },
        securityOptions: {
          rateLimitStore: {
            consume: () => { throw new Error('private state failure'); },
          },
        },
      }).listen(0, () => resolve(listening));
    });
    t.after(() => closeServer(server));

    const response = await request(server)({ path: '/status' });

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'Service Unavailable' });
    assert.doesNotMatch(response.text, /logger|private state/u);
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
