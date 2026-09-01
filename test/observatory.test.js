const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  createObservatoryService,
  deltaOf,
  normalizeAnalyticsAggregate,
  normalizeAnalyticsDateTrend,
  normalizeSearchDateTrend,
  preferObservatoryCandidate,
  reportingWindowOf,
} = require('../src/systems/observatory');
const { createObservatoryStore } = require('../src/entities/observatoryStore');
const {
  DEFAULT_OBSERVATORY_REQUEST_TIMEOUT_MS,
  GOOGLE_ANALYTICS_AGGREGATE_METRICS,
} = require('../src/components/observatoryPolicy');

const FIXED_NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

const completeConfig = Object.freeze({
  GOOGLE_OAUTH_CLIENT_ID: 'oauth-client-secret-value',
  GOOGLE_OAUTH_CLIENT_SECRET: 'oauth-client-super-secret',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'oauth-refresh-super-secret',
  GA4_SDIN_DEV_PROPERTY_ID: '111111111',
  GA4_SEANDINWIDDIE_COM_PROPERTY_ID: '222222222',
  GSC_SDIN_DEV_SITE_URL: 'sc-domain:sdin.dev',
  GSC_SEANDINWIDDIE_COM_SITE_URL: 'https://seandinwiddie.com/',
});

const jsonResponse = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});

const analyticsResponse = (values) =>
  jsonResponse({
    metricHeaders: [
      { name: 'activeUsers' },
      { name: 'sessions' },
      { name: 'screenPageViews' },
    ],
    rows: [
      {
        metricValues: values.map((value) => ({ value: String(value) })),
      },
    ],
  });

const realtimeResponse = (value) =>
  jsonResponse({
    metricHeaders: [{ name: 'activeUsers' }],
    rows: [{ metricValues: [{ value: String(value) }] }],
  });

const analyticsTrendResponse = (domainMarker) =>
  jsonResponse({
    dimensionHeaders: [
      { name: 'date' },
      { name: 'country' },
      { name: 'pagePathPlusQueryString' },
    ],
    metricHeaders: [
      { name: 'screenPageViews' },
      { name: 'activeUsers' },
      { name: 'sessions' },
      { name: 'privateMetric' },
    ],
    rows: [
      {
        dimensionValues: [
          { value: '20260830' },
          { value: `raw-country-${domainMarker}` },
          { value: `/raw-private-path-${domainMarker}?query=private` },
        ],
        metricValues: [
          { value: '40' },
          { value: '10' },
          { value: '20' },
          { value: '999' },
        ],
      },
      {
        dimensionValues: [
          { value: '20260829' },
          { value: 'another raw country' },
          { value: '/another-private-path' },
        ],
        metricValues: [
          { value: '30' },
          { value: '8' },
          { value: '16' },
          { value: '888' },
        ],
      },
    ],
  });

const searchAggregateResponse = (metrics) =>
  jsonResponse({ rows: [metrics] });

const searchTrendResponse = (domainMarker) =>
  jsonResponse({
    rows: [
      {
        keys: ['2026-08-30', `raw-query-${domainMarker}-must-not-escape`],
        clicks: 4,
        impressions: 80,
        ctr: 0.05,
        position: 7.25,
      },
      {
        keys: ['2026-08-29', 'another private query'],
        clicks: 3,
        impressions: 60,
        ctr: 0.05,
        position: 8,
      },
    ],
  });

const createGoogleFetch = (calls) => async (url, init) => {
  calls.push({ url, init });

  const routes = [
    {
      when: () => url === 'https://oauth2.googleapis.com/token',
      respond: () => jsonResponse({ access_token: 'private-access-token' }),
    },
    {
      when: () => url.includes(':runRealtimeReport'),
      respond: () => realtimeResponse(url.includes('111111111') ? 5 : 7),
    },
    {
      when: () => url.includes(':runReport'),
      respond: () => {
        const body = JSON.parse(init.body);
        const dateTrend = body.dimensions?.some(({ name }) => name === 'date');
        const current = body.dateRanges[0].startDate === '2026-08-03';
        const firstDomain = url.includes('111111111');
        const values = firstDomain
          ? (current ? [100, 80, 400] : [50, 100, 200])
          : (current ? [20, 10, 30] : [10, 10, 60]);
        return dateTrend
          ? analyticsTrendResponse(firstDomain ? 'sdin' : 'sean')
          : analyticsResponse(values);
      },
    },
    {
      when: () => url.includes('/searchAnalytics/query'),
      respond: () => {
        const body = JSON.parse(init.body);
        const firstDomain = url.includes('sdin.dev');
        const domainMarker = firstDomain ? 'sdin' : 'sean';
        const current = body.startDate === '2026-08-03';
        const metrics = firstDomain
          ? (current
            ? { clicks: 30, impressions: 600, ctr: 0.05, position: 7.5 }
            : { clicks: 20, impressions: 500, ctr: 0.04, position: 8.5 })
          : (current
            ? { clicks: 10, impressions: 250, ctr: 0.04, position: 9 }
            : { clicks: 5, impressions: 200, ctr: 0.025, position: 10 });
        return body.dimensions?.includes('date')
          ? searchTrendResponse(domainMarker)
          : searchAggregateResponse(metrics);
      },
    },
  ];

  return routes.find(({ when }) => when()).respond();
};

describe('public Google observatory', () => {
  test('keeps sequential OAuth and report timeout stages below the client budget', () => {
    assert.ok(DEFAULT_OBSERVATORY_REQUEST_TIMEOUT_MS * 2 <= 5000);
    assert.ok(DEFAULT_OBSERVATORY_REQUEST_TIMEOUT_MS * 2 < 8000);
  });

  test('serves an explicit stale snapshot when a later refresh fails', async () => {
    let clock = 0;
    const store = createObservatoryStore({ now: () => clock, ttlMs: 10 });
    const first = await store.read(async () => ({ availability: 'available' }));
    clock = 11;
    const stale = await store.read(async () => {
      throw new Error('private upstream detail');
    });

    assert.deepEqual(first, {
      availability: 'available',
      cached: false,
      stale: false,
    });
    assert.deepEqual(stale, {
      availability: 'available',
      cached: true,
      stale: true,
    });
    assert.equal(JSON.stringify(stale).includes('private upstream detail'), false);
  });

  test('backs off consecutive reads after a failed refresh', async () => {
    let clock = 0;
    let calls = 0;
    const store = createObservatoryStore({ now: () => clock, ttlMs: 10 });
    const produce = async () => {
      calls += 1;
      if (calls > 1) throw new Error('private upstream detail');
      return { availability: 'available' };
    };

    await store.read(produce);
    clock = 11;
    const failedRefresh = await store.read(produce);
    const cooldownRead = await store.read(produce);

    assert.equal(calls, 2);
    assert.deepEqual(failedRefresh, {
      availability: 'available',
      cached: true,
      stale: true,
    });
    assert.deepEqual(cooldownRead, failedRefresh);

    clock = 22;
    await store.read(produce);
    assert.equal(calls, 3);
  });

  test('backs off consecutive reads after a weaker refresh', async () => {
    let clock = 0;
    let calls = 0;
    const store = createObservatoryStore({
      now: () => clock,
      ttlMs: 10,
      preferCandidate: (current, candidate) =>
        current.availability !== 'available' ||
        candidate.availability === 'available',
    });
    const produce = async () => {
      calls += 1;
      return {
        availability: calls === 1 ? 'available' : 'partial',
      };
    };

    await store.read(produce);
    clock = 11;
    const weakerRefresh = await store.read(produce);
    const cooldownRead = await store.read(produce);

    assert.equal(calls, 2);
    assert.deepEqual(weakerRefresh, {
      availability: 'available',
      cached: true,
      stale: true,
    });
    assert.deepEqual(cooldownRead, weakerRefresh);
  });

  test('preserves a complete snapshot across a total service-level Google outage', async () => {
    let clock = FIXED_NOW;
    let outage = false;
    const calls = [];
    const successfulFetch = createGoogleFetch(calls);
    const service = createObservatoryService({
      config: completeConfig,
      env: {},
      now: () => clock,
      cacheTtlMs: 10,
      makeTimeoutSignal: () => undefined,
      fetchImpl: (...args) =>
        outage
          ? Promise.reject(new Error('private Google outage detail'))
          : successfulFetch(...args),
    });

    const complete = await service.getSummary();
    clock += 11;
    outage = true;
    const stale = await service.getSummary();

    assert.equal(complete.availability, 'available');
    assert.equal(stale.availability, 'available');
    assert.equal(stale.cached, true);
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.properties, complete.properties);
    assert.equal(JSON.stringify(stale).includes('private Google outage detail'), false);
  });

  test('prefers equal or stronger aggregate evidence and preserves stronger history', () => {
    assert.equal(
      preferObservatoryCandidate(
        { availability: 'available' },
        { availability: 'partial' }
      ),
      false
    );
    assert.equal(
      preferObservatoryCandidate(
        { availability: 'partial' },
        { availability: 'available' }
      ),
      true
    );
    const strongerPartial = {
      availability: 'partial',
      properties: [
        {
          analytics: {
            availability: 'available',
            realtime: { activeUsers: 1 },
            current: { activeUsers: 10 },
            previous: { activeUsers: 8 },
            trend: { activeUsers: { absolute: 2 } },
            dateTrend: [],
          },
          searchConsole: {
            availability: 'partial',
            current: { clicks: 2 },
            previous: { clicks: 1 },
            dateTrend: [],
          },
        },
      ],
    };
    const weakerPartial = {
      availability: 'partial',
      properties: [
        {
          analytics: strongerPartial.properties[0].analytics,
          searchConsole: {
            availability: 'unavailable',
            current: null,
            previous: null,
            dateTrend: [],
          },
        },
      ],
    };

    assert.equal(
      preferObservatoryCandidate(strongerPartial, weakerPartial),
      false
    );
    assert.equal(
      preferObservatoryCandidate(weakerPartial, strongerPartial),
      true
    );
  });

  test('keeps normalization and growth math pure and bounded', () => {
    assert.deepEqual(reportingWindowOf(FIXED_NOW), {
      current: { startDate: '2026-08-03', endDate: '2026-08-30' },
      previous: { startDate: '2026-07-06', endDate: '2026-08-02' },
    });
    assert.deepEqual(reportingWindowOf(Date.UTC(2026, 7, 31, 1, 0, 0)), {
      current: { startDate: '2026-08-02', endDate: '2026-08-29' },
      previous: { startDate: '2026-07-05', endDate: '2026-08-01' },
    });
    assert.deepEqual(deltaOf(150, 100), {
      absolute: 50,
      percent: 50,
      direction: 'up',
    });
    assert.deepEqual(deltaOf(3, 0), {
      absolute: 3,
      percent: null,
      direction: 'up',
    });
    assert.deepEqual(
      normalizeAnalyticsAggregate({
        metricHeaders: [
          { name: 'screenPageViews' },
          { name: 'activeUsers' },
          { name: 'sessions' },
          { name: 'unrequestedSecretMetric' },
        ],
        rows: [
          {
            metricValues: [
              { value: '40' },
              { value: '10' },
              { value: '20' },
              { value: '999' },
            ],
          },
        ],
      }),
      { activeUsers: 10, sessions: 20, views: 40 }
    );
    assert.deepEqual(
      normalizeAnalyticsDateTrend({
        dimensionHeaders: [
          { name: 'privateDimension' },
          { name: 'date' },
          { name: 'pagePathPlusQueryString' },
        ],
        metricHeaders: [
          { name: 'sessions' },
          { name: 'privateMetric' },
          { name: 'screenPageViews' },
          { name: 'activeUsers' },
        ],
        rows: [
          {
            dimensionValues: [
              { value: 'private dimension value' },
              { value: '20260830' },
              { value: '/private-path?raw=query' },
            ],
            metricValues: [
              { value: '20' },
              { value: '999' },
              { value: '40' },
              { value: '10' },
            ],
          },
        ],
      }),
      [
        {
          date: '2026-08-30',
          activeUsers: 10,
          sessions: 20,
          views: 40,
        },
      ]
    );
    const boundedAnalyticsTrend = normalizeAnalyticsDateTrend({
      dimensionHeaders: [{ name: 'date' }],
      metricHeaders: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' },
      ],
      rows: Array.from({ length: 30 }, (_, index) => ({
        dimensionValues: [
          { value: `202608${String(index + 1).padStart(2, '0')}` },
        ],
        metricValues: [
          { value: String(index + 1) },
          { value: String(index + 2) },
          { value: String(index + 3) },
        ],
      })),
    });
    assert.equal(boundedAnalyticsTrend.length, 28);
    assert.equal(boundedAnalyticsTrend[0].date, '2026-08-03');
    assert.equal(boundedAnalyticsTrend.at(-1).date, '2026-08-30');
    assert.deepEqual(
      normalizeSearchDateTrend({
        rows: [
          {
            keys: ['2026-08-30', 'private search query'],
            clicks: 2,
            impressions: 10,
            ctr: 0.2,
            position: 4,
          },
        ],
      }),
      [
        {
          date: '2026-08-30',
          clicks: 2,
          impressions: 10,
          ctr: 0.2,
          position: 4,
        },
      ]
    );
  });

  test('makes no Google request when the observatory is unconfigured', async () => {
    let calls = 0;
    const service = createObservatoryService({
      env: {},
      now: () => FIXED_NOW,
      makeTimeoutSignal: () => undefined,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('network must remain untouched');
      },
    });

    const result = await service.getSummary();

    assert.equal(calls, 0);
    assert.equal(result.availability, 'unconfigured');
    assert.deepEqual(
      result.properties.map(({ id, availability }) => ({ id, availability })),
      [
        { id: 'registry', availability: 'unconfigured' },
        { id: 'personal', availability: 'unconfigured' },
      ]
    );
  });

  test('aggregates both public channels with one OAuth exchange and an inflight cache', async () => {
    const calls = [];
    const service = createObservatoryService({
      config: completeConfig,
      env: {},
      now: () => FIXED_NOW,
      cacheTtlMs: 60_000,
      makeTimeoutSignal: () => undefined,
      fetchImpl: createGoogleFetch(calls),
    });

    const [first, concurrent] = await Promise.all([
      service.getSummary(),
      service.getSummary(),
    ]);
    const cached = await service.getSummary();

    assert.equal(calls.length, 15);
    assert.equal(
      calls.filter(({ url }) => url === 'https://oauth2.googleapis.com/token')
        .length,
      1
    );
    const tokenCall = calls.find(
      ({ url }) => url === 'https://oauth2.googleapis.com/token'
    );
    const tokenForm = new URLSearchParams(tokenCall.init.body);
    assert.equal(tokenForm.get('grant_type'), 'refresh_token');
    assert.equal(
      tokenForm.get('refresh_token'),
      completeConfig.GOOGLE_OAUTH_REFRESH_TOKEN
    );
    calls
      .filter(({ url }) => url !== 'https://oauth2.googleapis.com/token')
      .forEach(({ init }) => {
        assert.equal(init.headers.Authorization, 'Bearer private-access-token');
      });
    assert.equal(first.cached, false);
    assert.equal(concurrent.cached, false);
    assert.equal(cached.cached, true);
    assert.equal(first.availability, 'available');
    assert.deepEqual(first.properties[0].analytics.realtime, {
      activeUsers: 5,
    });
    assert.deepEqual(first.properties[0].analytics.current, {
      activeUsers: 100,
      sessions: 80,
      views: 400,
    });
    assert.deepEqual(first.properties[0].analytics.trend.sessions, {
      absolute: -20,
      percent: -20,
      direction: 'down',
    });
    assert.deepEqual(first.properties[0].analytics.dateTrend, [
      {
        date: '2026-08-29',
        activeUsers: 8,
        sessions: 16,
        views: 30,
      },
      {
        date: '2026-08-30',
        activeUsers: 10,
        sessions: 20,
        views: 40,
      },
    ]);
    assert.deepEqual(first.properties[0].searchConsole.current, {
      clicks: 30,
      impressions: 600,
      ctr: 0.05,
      position: 7.5,
    });
    assert.deepEqual(
      first.properties[0].searchConsole.dateTrend.map(({ date }) => date),
      ['2026-08-29', '2026-08-30']
    );

    const serialized = JSON.stringify(first);
    assert.equal(serialized.includes('screenPageViews'), false);
    [
      ...Object.values(completeConfig),
      'private-access-token',
      'raw-query-sdin-must-not-escape',
      'another private query',
      'unrequestedSecretMetric',
      'raw-country-sdin',
      '/raw-private-path-sdin?query=private',
      'privateMetric',
    ].forEach((privateValue) => {
      assert.equal(serialized.includes(privateValue), false);
    });
  });

  test('rejects malformed successful Analytics reports without inventing zero evidence', async () => {
    const service = createObservatoryService({
      config: completeConfig,
      env: {},
      now: () => FIXED_NOW,
      makeTimeoutSignal: () => undefined,
      fetchImpl: async (url) =>
        url === 'https://oauth2.googleapis.com/token'
          ? jsonResponse({ access_token: 'private-access-token' })
          : jsonResponse({}),
    });

    const result = await service.getSummary();

    assert.equal(result.availability, 'partial');
    result.properties.forEach((property) => {
      assert.equal(property.analytics.availability, 'unavailable');
      assert.equal(property.analytics.realtime, null);
      assert.equal(property.analytics.current, null);
      assert.equal(property.searchConsole.availability, 'available');
      assert.deepEqual(property.searchConsole.current, {
        clicks: 0,
        impressions: 0,
        ctr: 0,
        position: 0,
      });
    });
  });

  test('accepts structurally valid empty reports as truthful zero evidence', async () => {
    const service = createObservatoryService({
      config: completeConfig,
      env: {},
      now: () => FIXED_NOW,
      makeTimeoutSignal: () => undefined,
      fetchImpl: async (url, init) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return jsonResponse({ access_token: 'private-access-token' });
        }
        if (url.includes(':runRealtimeReport')) {
          return jsonResponse({
            metricHeaders: [{ name: 'activeUsers' }],
            rows: [],
          });
        }
        if (url.includes(':runReport')) {
          const body = JSON.parse(init.body);
          return jsonResponse({
            ...(body.dimensions?.length
              ? { dimensionHeaders: [{ name: 'date' }] }
              : {}),
            metricHeaders: GOOGLE_ANALYTICS_AGGREGATE_METRICS.map((name) => ({
              name,
            })),
            rows: [],
          });
        }
        return jsonResponse({});
      },
    });

    const result = await service.getSummary();

    assert.equal(result.availability, 'available');
    assert.deepEqual(result.properties[0].analytics.realtime, { activeUsers: 0 });
    assert.deepEqual(result.properties[0].analytics.current, {
      activeUsers: 0,
      sessions: 0,
      views: 0,
    });
    assert.deepEqual(result.properties[0].searchConsole.current, {
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    });
  });

  test('rejects malformed non-object and non-array Search Console payloads', async () => {
    let searchCall = 0;
    const service = createObservatoryService({
      config: completeConfig,
      env: {},
      now: () => FIXED_NOW,
      makeTimeoutSignal: () => undefined,
      fetchImpl: async (url, init) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return jsonResponse({ access_token: 'private-access-token' });
        }
        if (url.includes(':runRealtimeReport')) {
          return jsonResponse({
            metricHeaders: [{ name: 'activeUsers' }],
            rows: [],
          });
        }
        if (url.includes(':runReport')) {
          const body = JSON.parse(init.body);
          return jsonResponse({
            ...(body.dimensions?.length
              ? { dimensionHeaders: [{ name: 'date' }] }
              : {}),
            metricHeaders: GOOGLE_ANALYTICS_AGGREGATE_METRICS.map((name) => ({
              name,
            })),
            rows: [],
          });
        }
        searchCall += 1;
        return jsonResponse(
          [{ rows: {} }, 'malformed-success', []][searchCall % 3]
        );
      },
    });

    const result = await service.getSummary();

    assert.equal(result.availability, 'partial');
    assert.equal(result.properties[0].analytics.availability, 'available');
    assert.equal(result.properties[0].searchConsole.availability, 'unavailable');
    assert.equal(result.properties[0].searchConsole.current, null);
  });

  test('returns useful partial aggregates without exposing upstream failures', async () => {
    const service = createObservatoryService({
      config: {
        ...completeConfig,
        GA4_SEANDINWIDDIE_COM_PROPERTY_ID: '',
        GSC_SEANDINWIDDIE_COM_SITE_URL: '',
      },
      env: {},
      now: () => FIXED_NOW,
      makeTimeoutSignal: () => undefined,
      fetchImpl: async (url, init) => {
        const base = createGoogleFetch([]);
        const body = init.body?.startsWith('{') ? JSON.parse(init.body) : {};
        const isPreviousSearch =
          url.includes('/searchAnalytics/query') &&
          body.startDate === '2026-07-06' &&
          (body.dimensions ?? []).length === 0;
        return isPreviousSearch
          ? Promise.reject(new Error('private upstream diagnostic and query'))
          : base(url, init);
      },
    });

    const result = await service.getSummary();

    assert.equal(result.availability, 'partial');
    assert.equal(result.properties[0].availability, 'partial');
    assert.equal(result.properties[0].analytics.availability, 'available');
    assert.equal(result.properties[0].searchConsole.availability, 'partial');
    assert.equal(result.properties[0].searchConsole.previous, null);
    assert.equal(result.properties[1].availability, 'unconfigured');
    assert.equal(
      JSON.stringify(result).includes('private upstream diagnostic and query'),
      false
    );
  });
});
