const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const app = require('../src/api');
const initialState = require('../src/data/initialState.json');

// The app is exported rather than self-started, so tests drive the real Express
// instance on an ephemeral port -- no mocks, no fixed port collisions.
let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server?.close());

const get = async (path) => {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, headers: response.headers, body: await response.json() };
};

describe('api.sdin.dev', () => {
  test('GET / returns a welcome payload', async () => {
    const { status, body } = await get('/');
    assert.equal(status, 200);
    assert.equal(body.message, 'Welcome to the API');
  });

  test('GET /status reports OK', async () => {
    const { status, body } = await get('/status');
    assert.equal(status, 200);
    assert.equal(body.status, 'OK');
  });

  test('GET /data returns the full initial state', async () => {
    const { status, body } = await get('/data');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), Object.keys(initialState).sort());
  });

  test('every initial-state key gets its own endpoint', async () => {
    for (const key of Object.keys(initialState)) {
      const { status, body } = await get(`/${key}`);
      assert.equal(status, 200, `/${key} should exist`);
      assert.deepEqual(body[key], initialState[key], `/${key} should return its slice`);
    }
  });

  test('the portfolio contract fields are present and typed', async () => {
    const { body } = await get('/data');
    assert.equal(typeof body.brandName, 'string');
    assert.equal(typeof body.description, 'string');
    assert.ok(Array.isArray(body.portfolioFeatures));
    assert.ok(Array.isArray(body.appProcedures));
    for (const item of [...body.portfolioFeatures, ...body.appProcedures]) {
      assert.equal(typeof item.id, 'string');
      assert.equal(typeof item.title, 'string');
      assert.equal(typeof item.description, 'string');
    }
  });

  test('GET /github returns live aggregated GitHub data', async () => {
    const { status, body } = await get('/github');
    assert.equal(status, 200);
    assert.equal(typeof body.profile.login, 'string');
    assert.ok(Array.isArray(body.repos));
    assert.ok(Array.isArray(body.languages));
  });

  test('GitHub routes are longer-cached than authored content', async () => {
    const authored = await get('/data');
    const live = await get('/github');
    assert.match(authored.headers.get('cache-control'), /s-maxage=300/);
    assert.match(live.headers.get('cache-control'), /s-maxage=600/);
  });

  test('the 404 payload advertises the GitHub endpoints', async () => {
    const { body } = await get('/definitely-not-a-route');
    assert.ok(body.availableEndpoints.includes('/github'));
    assert.ok(body.availableEndpoints.includes('/github/repos'));
    assert.ok(body.availableEndpoints.includes('/github/activity'));
  });

  test('unknown routes return JSON, not an HTML error page', async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const body = await response.json();
    assert.equal(body.error, 'Not Found');
    assert.ok(Array.isArray(body.availableEndpoints));
  });

  test('responses are CORS-enabled and CDN-cacheable', async () => {
    const { headers } = await get('/data');
    assert.equal(headers.get('access-control-allow-origin'), '*');
    assert.match(headers.get('cache-control'), /s-maxage=\d+/);
  });
});
