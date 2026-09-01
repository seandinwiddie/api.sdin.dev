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

const presenceService = {
  getSummary: async () => ({
    checkedAt: '2026-08-30T04:00:00.000Z',
    cached: false,
    summary: { channels: 1, operational: 1, limited: 0, unreachable: 0 },
    channels: [
      {
        id: 'registry',
        label: 'Registry',
        url: 'https://sdin.dev',
        state: 'operational',
        httpStatus: 200,
        latencyMs: 42,
        checkedAt: '2026-08-30T04:00:00.000Z',
      },
    ],
  }),
};

const observatoryService = {
  getSummary: async () => ({
    checkedAt: '2026-08-30T04:00:00.000Z',
    cached: false,
    availability: 'available',
    window: {
      current: { startDate: '2026-08-03', endDate: '2026-08-30' },
      previous: { startDate: '2026-07-06', endDate: '2026-08-02' },
    },
    properties: [],
  }),
};

const securityPostureService = {
  getSummary: async () => ({
    schemaVersion: '1.0.0',
    kind: 'digital-estate-security-posture',
    checkedAt: '2026-08-30T04:00:00.000Z',
    cached: false,
    stale: false,
    scope: { userSuppliedTargetsAccepted: false },
    posture: { targets: 6, observed: 6, unavailable: 0, coveragePercent: 84 },
    sites: [],
    assessments: {
      schemaVersion: 1,
      state: 'not-published',
      severityCounts: null,
      alertsTotal: null,
      records: [],
      policy: { publicTrigger: false, rawFindingsPublic: false },
    },
    links: [],
    provenance: {
      authority: 'api-authored-json-and-runtime-observation',
      observedAt: '2026-08-30T04:00:00.000Z',
      cached: false,
      stale: false,
    },
  }),
};

const app = createApp({
  githubService,
  observatoryService,
  presenceService,
  securityPostureService,
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
  test('GET / returns a readiness payload', async () => {
    const { status, body } = await get('/');
    assert.equal(status, 200);
    assert.equal(body.message, 'api.sdin.dev ready');
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
    assert.equal(body.authoredData.securityAssessments, 'ready');
    assert.equal(body.authoredData.securityPosturePolicy, 'ready');
    assert.match(headers.get('cache-control'), /no-store/);
  });

  test('GET /data returns the full initial state', async () => {
    const { status, body } = await get('/data');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), Object.keys(initialState).sort());
  });

  test('GET /agent-manifest returns catalog-derived machine discovery', async () => {
    const { status, body } = await get('/agent-manifest');
    assert.equal(status, 200);
    assert.equal(body.kind, 'public-api-manifest');
    assert.equal(body.observedAt, '2026-08-30T04:00:00.000Z');
    assert.equal(body.usage.readOnly, true);
    assert.ok(
      body.resources.some(
        ({ method, path }) => method === 'GET' && path === '/security-posture'
      )
    );
    assert.equal(
      body.links.find(({ rel }) => rel === 'portfolio').href,
      'https://portfolio.sdin.dev'
    );
  });

  test('GET /security-posture returns sanitized public evidence without a scan trigger', async () => {
    const { status, body } = await get('/security-posture?target=https://attacker.example');
    assert.equal(status, 200);
    assert.equal(body.kind, 'digital-estate-security-posture');
    assert.equal(body.scope.userSuppliedTargetsAccepted, false);
    assert.equal(body.assessments.policy.publicTrigger, false);
    assert.equal(body.assessments.policy.rawFindingsPublic, false);
    assert.equal(JSON.stringify(body).includes('attacker.example'), false);
  });

  test('GET /observatory returns the public aggregate observatory', async () => {
    const { status, body } = await get('/observatory');
    assert.equal(status, 200);
    assert.equal(body.availability, 'available');
    assert.deepEqual(body.properties, []);
    assert.deepEqual(body.window.current, {
      startDate: '2026-08-03',
      endDate: '2026-08-30',
    });
    assert.deepEqual(
      body.estates.map(({ id, url }) => ({ id, url })),
      initialState.presentation.nexus.presences.map(({ id, url }) => ({ id, url }))
    );
    assert.equal(
      body.estates.find(({ id }) => id === 'registry').capabilities.presence
        .availability,
      'operational'
    );
    assert.equal(
      body.estates.find(({ id }) => id === 'forboc').capabilities.analytics
        .availability,
      'not-instrumented'
    );
    assert.deepEqual(
      body.estates.find(({ id }) => id === 'registry').repositories,
      [{
        id: 'seandinwiddie-portfolio',
        sourceUrl: 'https://github.com/seandinwiddie/portfolio',
        status: 'public-source',
      }]
    );
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
    assert.equal(body.brandName, 'Portfolio.sdin.dev');
    assert.equal(typeof body.description, 'string');
    assert.ok(Array.isArray(body.registryCapabilities));
    assert.ok(Array.isArray(body.operatingProtocols));
    for (const item of [...body.registryCapabilities, ...body.operatingProtocols]) {
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
    assert.deepEqual(body.ambientScene.motions, {
      'archive-orbit': { duration: 84, delay: -19, drift: 2 },
      'registry-spine': { duration: 68, delay: -31, drift: 2 },
      'pilgrim-transit': { duration: 36, delay: -11, drift: 12 },
      'relay-beacon': { duration: 19, delay: -7, drift: 0 },
      'terminus-horizon': { duration: 72, delay: -43, drift: 1 },
      'survey-monolith': { duration: 64, delay: -23, drift: 2 },
    });
    const activity = body.ambientScene.activity;
    const visualKindById = Object.freeze({
      'query-sync': 'sync',
      'query-resolve': 'resolve',
      'route-transit': 'transit',
      'query-fault': 'fault',
    });
    const allowedVisualKinds = Object.freeze(['sync', 'resolve', 'transit', 'fault']);
    const visualNumericBounds = Object.freeze({
      durationMs: [100, 10_000],
      intensity: [0.01, 1],
      x: [0, 100],
      y: [0, 100],
      rotation: [-360, 360],
      travelVw: [0, 100],
      spreadVw: [1, 100],
    });
    const acousticNumericBounds = Object.freeze({
      frequency: [20, 20_000],
      destinationFrequency: [20, 20_000],
      filterFrequency: [20, 20_000],
      durationSeconds: [0.01, 5],
      attackSeconds: [0.001, 1],
      delayMs: [0, 5_000],
      gain: [0.0001, 0.05],
      filterQ: [0.1, 100],
    });
    const assertFiniteWithin = (value, [minimum, maximum], path) => {
      assert.ok(Number.isFinite(value), `${path} must be finite`);
      assert.ok(
        value >= minimum && value <= maximum,
        `${path} must be between ${minimum} and ${maximum}`
      );
    };

    assert.deepEqual(activity.ids, [
      'query-sync',
      'query-resolve',
      'route-transit',
      'query-fault',
    ]);
    assert.equal(new Set(activity.ids).size, activity.ids.length);
    const activityKeys = [...activity.ids].sort();
    assert.deepEqual(Object.keys(visualKindById).sort(), activityKeys);
    assert.deepEqual(
      Object.keys(activity.visuals).sort(),
      activityKeys
    );
    assert.deepEqual(
      Object.keys(activity.acoustics).sort(),
      activityKeys
    );
    for (const id of activity.ids) {
      const visual = activity.visuals[id];
      const acoustic = activity.acoustics[id];
      assert.ok(allowedVisualKinds.includes(visual.kind));
      assert.equal(visual.kind, visualKindById[id]);
      for (const [field, bounds] of Object.entries(visualNumericBounds)) {
        assertFiniteWithin(visual[field], bounds, `activity.visuals.${id}.${field}`);
      }
      for (const [field, bounds] of Object.entries(acousticNumericBounds)) {
        assertFiniteWithin(acoustic[field], bounds, `activity.acoustics.${id}.${field}`);
      }
      assert.ok(
        acoustic.attackSeconds < acoustic.durationSeconds,
        `activity.acoustics.${id}.attackSeconds must be shorter than durationSeconds`
      );
      assert.ok(['sine', 'square', 'sawtooth', 'triangle'].includes(acoustic.waveform));
    }
    assert.equal(typeof body.presentation.ingress.name, 'string');
    assert.equal(typeof body.presentation.ingress.statement, 'string');
    assert.equal(typeof body.presentation.ingress.install.webUrl, 'string');
    assert.ok(Array.isArray(body.presentation.ingress.ctas));
    body.presentation.ingress.ctas.forEach(({ href, label }) => {
      assert.match(href, /^\/(?:dossier|missions|telemetry)$/);
      assert.equal(typeof label, 'string');
    });
    assert.equal(typeof body.presentation.metadata.routes.nexus.description, 'string');
    assert.ok(Array.isArray(body.presentation.nexus.presences));
    assert.equal(typeof body.presentation.observatory.headline, 'string');
    assert.equal(body.presentation.missions.panels.recorder, 'Flight recorder');
    assert.equal(body.presentation.missions.copy.activityKinds.push.plural, 'pushes');
    assert.equal(body.presentation.missions.copy.publicEventsPrefix, 'public events since');
    assert.equal(body.presentation.observatory.metrics.views, 'VIEWS');
    assert.equal(body.presentation.observatory.staleLabel, 'STALE SNAPSHOT');
    assert.equal(typeof body.presentation.observatory.metrics.clicks, 'string');
    assert.deepEqual(
      body.presentation.nexus.presences.find(({ id }) => id === 'forboc'),
      {
        id: 'forboc',
        url: 'https://forboc.ai',
        label: 'Forboc.ai',
        capabilities: { presence: true, analytics: false, searchConsole: false },
        repositories: [],
      }
    );
    assert.deepEqual(
      body.presentation.nexus.presences.find(({ id }) => id === 'lectures'),
      {
        id: 'lectures',
        url: 'https://seandinwiddie.github.io/lectures/',
        label: 'Lectures',
        capabilities: { presence: true, analytics: false, searchConsole: false },
        repositories: [{
          id: 'seandinwiddie-lectures',
          sourceUrl: 'https://github.com/seandinwiddie/lectures',
          status: 'public-source',
        }],
      }
    );
    assert.deepEqual(
      body.presentation.nexus.presences.find(
        ({ id }) => id === 'functional-programming-library'
      ),
      {
        id: 'functional-programming-library',
        url: 'https://www.npmjs.com/package/functional-programming-composition',
        label: 'Functional Programming Library',
        capabilities: { presence: true, analytics: false, searchConsole: false },
        repositories: [{
          id: 'functional-programming-composition-fp',
          sourceUrl: 'https://github.com/functional-programming-composition/fp',
          status: 'public-source',
        }],
      }
    );
    assert.ok(Array.isArray(body.presentation.utilityRail.links));
    [...body.presentation.nexus.presences, ...body.presentation.utilityRail.links].forEach(
      ({ id, url, label }) => {
        assert.equal(typeof id, 'string');
        assert.match(url, /^https:\/\//);
        assert.equal(typeof label, 'string');
      }
    );
    assert.equal(typeof body.presentation.metadata.registryName, 'string');
    assert.equal(typeof body.presentation.metadata.titleSuffix, 'string');
    assert.deepEqual(
      Object.keys(body.presentation.metadata.routes).sort(),
      ['dossier', 'ingress', 'lostSignal', 'missions', 'nexus', 'telemetry']
    );
    assert.equal(typeof body.presentation.lostSignal.actionLabel, 'string');
    assert.deepEqual(body.presentation.runtime.sound, {
      enabledText: 'SOUND ON',
      disabledText: 'SOUND OFF',
      enableLabel: 'Enable interface sounds',
      disableLabel: 'Disable interface sounds',
    });
    assert.equal(typeof body.presentation.runtime.navigation.routes.nexus.label, 'string');
    assert.equal(typeof body.presentation.runtime.archiveControl.commands.help[0], 'string');
    assert.equal(typeof body.presentation.runtime.dossier.stats.repositories, 'string');
    assert.equal(typeof body.presentation.runtime.telemetry.statement, 'string');
    assert.equal(
      body.presentation.runtime.telemetry.labels.feed,
      'GH + GOOGLE LIVE'
    );
    assert.equal(
      body.presentation.runtime.telemetry.values.store,
      '6 slices · rtk query'
    );
    assert.match(body.presentation.metadata.defaultDescription, /active missions/);
    assert.match(body.presentation.metadata.routes.telemetry.description, /system state/);
    assert.doesNotMatch(
      JSON.stringify(body.presentation.metadata),
      /live projects|application and API status/i
    );
    assert.equal(typeof body.dossier.headline, 'string');
    assert.equal('about' in body, false);
    assert.equal('portfolioFeatures' in body, false);
    assert.equal('appProcedures' in body, false);
    assert.equal('brandNameLoading' in body, false);
    assert.equal('nav' in body, false);
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

  test('GET /presence returns bounded public-channel observations', async () => {
    const { status, body } = await get('/presence');
    assert.equal(status, 200);
    assert.equal(body.summary.operational, 1);
    assert.equal(body.channels[0].state, 'operational');
    assert.equal(body.channels[0].latencyMs, 42);
    assert.equal('error' in body.channels[0], false);
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
    assert.ok(body.availableEndpoints.includes('/presence'));
    assert.ok(body.availableEndpoints.includes('/security-posture'));
    assert.ok(body.availableEndpoints.includes('/agent-manifest'));
  });

  test('unknown routes return JSON, not an HTML error document', async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json();
    assert.equal(body.error, 'Not Found');
    assert.ok(Array.isArray(body.availableEndpoints));
  });

  test('upstream and internal failures are uncached without leaking server details', async (t) => {
    const errorLogs = [];
    const failureService = {
      ...githubService,
      getProfile: async () => { throw new Error('GitHub private upstream detail'); },
      getRepos: async () => { throw new Error('private internal detail'); },
      getActivity: async () => {
        throw new Error('GitHub activity response was incomplete');
      },
    };
    const failureBaseUrl = await startTestApp(t, createApp({
      githubService: failureService,
      logger: {
        error: (...entry) => errorLogs.push(entry),
      },
    }));
    const upstreamResponse = await fetch(`${failureBaseUrl}/github/profile`);
    const internalResponse = await fetch(`${failureBaseUrl}/github/repos`);
    const malformedUpstreamResponse = await fetch(
      `${failureBaseUrl}/github/activity`
    );
    const upstreamText = await upstreamResponse.text();
    const internalText = await internalResponse.text();
    const malformedUpstreamText = await malformedUpstreamResponse.text();

    const loggerFailureBaseUrl = await startTestApp(t, createApp({
      githubService: failureService,
      logger: {
        error: () => { throw new Error('logger unavailable'); },
      },
    }));
    const loggerFailureResponse = await fetch(`${loggerFailureBaseUrl}/github/repos`);

    assert.equal(upstreamResponse.status, 502);
    assert.match(upstreamResponse.headers.get('cache-control'), /no-store/);
    assert.deepEqual(JSON.parse(upstreamText), { error: 'Upstream Unavailable' });
    assert.doesNotMatch(upstreamText, /private upstream detail/);
    assert.equal(internalResponse.status, 500);
    assert.match(internalResponse.headers.get('cache-control'), /no-store/);
    assert.deepEqual(JSON.parse(internalText), { error: 'Internal Server Error' });
    assert.doesNotMatch(internalText, /private internal detail/);
    assert.equal(malformedUpstreamResponse.status, 502);
    assert.match(malformedUpstreamResponse.headers.get('cache-control'), /no-store/);
    assert.deepEqual(JSON.parse(malformedUpstreamText), {
      error: 'Upstream Unavailable',
    });
    assert.equal(errorLogs.length, 3);
    errorLogs.forEach(([message, context]) => {
      assert.equal(message, 'Request failed');
      assert.deepEqual(Object.keys(context).sort(), ['event', 'requestId']);
      assert.match(context.requestId, /^[0-9a-f-]{36}$/u);
    });
    const loggedText = JSON.stringify(errorLogs);
    assert.doesNotMatch(loggedText, /private|incomplete|stack|Error/u);
    assert.equal(loggerFailureResponse.status, 500);
    assert.deepEqual(await loggerFailureResponse.json(), {
      error: 'Internal Server Error',
    });
  });

  test('responses are CORS-enabled without shared client-quota caching', async () => {
    const { headers } = await get('/data');
    assert.equal(headers.get('access-control-allow-origin'), '*');
    assert.match(headers.get('vary'), /Origin/);
    assert.match(headers.get('cache-control'), /private/);
    assert.doesNotMatch(headers.get('cache-control'), /s-maxage/);
  });
});
