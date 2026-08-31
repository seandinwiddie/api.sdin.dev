const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/api');
const initialState = require('../src/data/initialState.json');

const resource = (value) => ({
  ...value,
  cached: false,
  stale: false,
  availability: {
    state: 'live',
    cached: false,
    stale: false,
    partial: false,
    fetchedAt: '2026-08-30T04:00:00.000Z',
    degradedSources: [],
    errorCode: null,
  },
});

const githubService = {
  getProfile: async () => resource({ profile: { login: 'seandinwiddie' } }),
  getRepos: async () => resource({ repos: [], languages: [], owners: [], since: null }),
  getActivity: async () => resource({ events: [], byRepo: [], byKind: [], total: 0, since: null, until: null }),
  getContributions: async () => resource({ contributions: null }),
  getCommits: async () => resource({ commits: [], total: 0, byType: [] }),
  getSummary: async () => ({
    profile: { login: 'seandinwiddie' },
    repos: [],
    languages: [],
    owners: [],
    since: null,
    activity: resource({ events: [], byRepo: [], byKind: [], total: 0, since: null, until: null }),
    contributions: null,
    commits: resource({ commits: [], total: 0, byType: [] }),
    cached: false,
    stale: false,
    partial: false,
    availability: { state: 'live', cached: false, stale: false, partial: false, resources: {} },
    authenticated: false,
  }),
};

const app = createApp({
  githubService,
  now: () => Date.parse('2026-08-30T04:00:00Z'),
});

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

const startTestApp = (t, testApp) =>
  new Promise((resolve) => {
    const testServer = testApp.listen(0, () => {
      t.after(() => new Promise((closeResolve, closeReject) =>
        testServer.close((error) => (error ? closeReject(error) : closeResolve()))
      ));
      resolve(`http://127.0.0.1:${testServer.address().port}`);
    });
  });

describe('api.sdin.dev', () => {
  test('GET / returns a welcome payload', async () => {
    const { status, body } = await get('/');
    assert.equal(status, 200);
    assert.equal(body.message, 'Welcome to the API');
  });

  test('GET /status is uncached and reports service readiness', async () => {
    const { status, headers, body } = await get('/status');
    assert.equal(status, 200);
    assert.equal(body.status, 'OK');
    assert.equal(body.service, 'api.sdin.dev');
    assert.equal(body.version, '1.0.0');
    assert.equal(body.checkedAt, '2026-08-30T04:00:00.000Z');
    assert.equal(body.authoredData.status, 'ready');
    assert.equal(body.authoredData.keys, Object.keys(initialState).length);
    assert.match(headers.get('cache-control'), /no-store/);
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
    assert.equal(body.ambientScene.ids.length, 6);
    for (const id of body.ambientScene.ids) {
      assert.equal(typeof body.ambientScene.positions[id].x, 'number');
      assert.equal(typeof body.ambientScene.visuals[id].label, 'string');
      assert.equal(typeof body.ambientScene.motions[id].duration, 'number');
    }
  });

  test('GET /github returns live aggregated GitHub data', async () => {
    const { status, body } = await get('/github');
    assert.equal(status, 200);
    assert.equal(typeof body.profile.login, 'string');
    assert.ok(Array.isArray(body.repos));
    assert.ok(Array.isArray(body.languages));
    assert.ok(Array.isArray(body.commits.commits));
    assert.equal(body.availability.state, 'live');
  });

  test('authored and GitHub responses require private revalidation', async () => {
    const authored = await get('/data');
    const live = await get('/github');
    assert.match(authored.headers.get('cache-control'), /private/);
    assert.match(authored.headers.get('cache-control'), /no-cache/);
    assert.match(live.headers.get('cache-control'), /private/);
    assert.match(live.headers.get('cache-control'), /no-cache/);
    assert.doesNotMatch(authored.headers.get('cache-control'), /s-maxage/);
    assert.doesNotMatch(live.headers.get('cache-control'), /s-maxage/);
  });

  test('the 404 payload advertises the GitHub endpoints', async () => {
    const { body } = await get('/definitely-not-a-route');
    assert.ok(body.availableEndpoints.includes('/github'));
    assert.ok(body.availableEndpoints.includes('/github/repos'));
    assert.ok(body.availableEndpoints.includes('/github/activity'));
    assert.ok(body.availableEndpoints.includes('/github/contributions'));
    assert.ok(body.availableEndpoints.includes('/github/commits'));
  });

  test('unknown routes return JSON, not an HTML error page', async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json();
    assert.equal(body.error, 'Not Found');
    assert.ok(Array.isArray(body.availableEndpoints));
  });

  test('upstream and internal failures are uncached without leaking server details', async (t) => {
    const failureService = {
      ...githubService,
      getProfile: async () => { throw new Error('GitHub private upstream detail'); },
      getRepos: async () => { throw new Error('private internal detail'); },
    };
    const failureBaseUrl = await startTestApp(t, createApp({
      githubService: failureService,
      logger: { error: () => undefined },
    }));
    const upstreamResponse = await fetch(`${failureBaseUrl}/github/profile`);
    const internalResponse = await fetch(`${failureBaseUrl}/github/repos`);
    const upstreamText = await upstreamResponse.text();
    const internalText = await internalResponse.text();

    assert.equal(upstreamResponse.status, 502);
    assert.match(upstreamResponse.headers.get('cache-control'), /no-store/);
    assert.deepEqual(JSON.parse(upstreamText), { error: 'Upstream Unavailable' });
    assert.doesNotMatch(upstreamText, /private upstream detail/);
    assert.equal(internalResponse.status, 500);
    assert.match(internalResponse.headers.get('cache-control'), /no-store/);
    assert.deepEqual(JSON.parse(internalText), { error: 'Internal Server Error' });
    assert.doesNotMatch(internalText, /private internal detail/);
  });

  test('responses are CORS-enabled without shared client-quota caching', async () => {
    const { headers } = await get('/data');
    assert.equal(headers.get('access-control-allow-origin'), '*');
    assert.match(headers.get('vary'), /Origin/);
    assert.match(headers.get('cache-control'), /private/);
    assert.doesNotMatch(headers.get('cache-control'), /s-maxage/);
  });
});
