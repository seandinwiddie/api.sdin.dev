/**
 * Aggregate Google Analytics and Search Console observability.
 *
 * OAuth credentials, Google property identifiers, raw reports, dimensions,
 * and transport errors remain inside this effect boundary. The returned value
 * contains only the fixed public channel identity and aggregate measurements.
 */

const {
  DEFAULT_OBSERVATORY_CACHE_TTL_MS,
  DEFAULT_OBSERVATORY_REQUEST_TIMEOUT_MS,
  GOOGLE_ANALYTICS_AGGREGATE_METRICS,
  GOOGLE_ANALYTICS_DATA_ORIGIN,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_SEARCH_CONSOLE_METRICS,
  GOOGLE_SEARCH_CONSOLE_ORIGIN,
  OAUTH_CONFIG_KEYS,
  OBSERVATORY_CHANNELS,
} = require('../components/observatoryPolicy');
const { createObservatoryStore } = require('../entities/observatoryStore');
const { createBoundedFetch, positiveMilliseconds } = require('../http');
const {
  _,
  ematch,
  fold,
  isRight,
  left,
  multiMatch,
  orElse,
  pipe,
  right,
} = require('functional-programming-composition');

const DAY_MS = 24 * 60 * 60 * 1000;
const REPORTING_DAYS = 28;
const REPORTING_TIME_ZONE = 'America/Los_Angeles';
const availabilityRank = Object.freeze({
  unavailable: 0,
  unconfigured: 0,
  partial: 1,
  available: 2,
});

const presentEvidenceCount = (values) =>
  fold(
    values,
    0,
    (count, value) => count + Number(value !== null && value !== undefined)
  );

const sourceEvidenceCount = (source, fields) =>
  presentEvidenceCount(fields.map((field) => source?.[field])) +
  Number((source?.dateTrend?.length ?? 0) > 0);

const observatoryStrength = (snapshot) => {
  const nested = fold(
    snapshot.properties ?? [],
    { sourceRank: 0, evidence: 0 },
    (strength, property) => ({
      sourceRank:
        strength.sourceRank +
        (availabilityRank[property.analytics?.availability] ?? 0) +
        (availabilityRank[property.searchConsole?.availability] ?? 0),
      evidence:
        strength.evidence +
        sourceEvidenceCount(property.analytics, [
          'realtime',
          'current',
          'previous',
          'trend',
        ]) +
        sourceEvidenceCount(property.searchConsole, ['current', 'previous']),
    })
  );
  return [
    availabilityRank[snapshot.availability] ?? 0,
    nested.sourceRank,
    nested.evidence,
  ];
};

const preferObservatoryCandidate = (previous, candidate) => {
  const previousStrength = observatoryStrength(previous);
  const candidateStrength = observatoryStrength(candidate);
  const decisiveDelta = candidateStrength
    .map((value, index) => value - previousStrength[index])
    .find((delta) => delta !== 0);
  return (decisiveDelta ?? 0) >= 0;
};

const trimmedString = (value) => {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return candidate.length > 0 ? candidate : null;
};

const configuredValue = (config, env) => (key) =>
  trimmedString(config?.[key] ?? env?.[key]);

const normalizeAnalyticsPropertyId = (value) => {
  const candidate = trimmedString(value)?.replace(/^properties\//, '') ?? '';
  return /^\d+$/.test(candidate) ? candidate : null;
};

const isWebProperty = (value) =>
  URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);

const normalizeSearchConsoleSiteUrl = (value) => {
  const candidate = trimmedString(value) ?? '';
  const supported = /^sc-domain:[a-z0-9.-]+$/i.test(candidate) ||
    isWebProperty(candidate);
  return supported ? candidate : null;
};

const observatoryConfigOf = ({ config = {}, env = process.env } = {}) => {
  const read = configuredValue(config, env);
  const oauth = Object.fromEntries(
    Object.entries(OAUTH_CONFIG_KEYS).map(([field, key]) => [field, read(key)])
  );

  return Object.freeze({
    oauth: Object.freeze({
      ...oauth,
      configured: Object.values(oauth).every(Boolean),
    }),
    channels: Object.freeze(
      OBSERVATORY_CHANNELS.map((channel) =>
        Object.freeze({
          id: channel.id,
          label: channel.label,
          analyticsPropertyId: normalizeAnalyticsPropertyId(
            read(channel.analyticsKey)
          ),
          searchConsoleSiteUrl: normalizeSearchConsoleSiteUrl(
            read(channel.searchConsoleKey)
          ),
        })
      )
    ),
  });
};

const dateAtDay = (day) =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);

const calendarDayInReportingZone = (milliseconds) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: REPORTING_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(milliseconds))
      .filter(({ type }) => ['year', 'month', 'day'].includes(type))
      .map(({ type, value }) => [type, Number(value)])
  );
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
};

const reportingWindowOf = (milliseconds) => {
  const currentEndDay = calendarDayInReportingZone(milliseconds) - 1;
  const currentStartDay = currentEndDay - REPORTING_DAYS + 1;
  const previousEndDay = currentStartDay - 1;
  const previousStartDay = previousEndDay - REPORTING_DAYS + 1;

  return Object.freeze({
    current: Object.freeze({
      startDate: dateAtDay(currentStartDay),
      endDate: dateAtDay(currentEndDay),
    }),
    previous: Object.freeze({
      startDate: dateAtDay(previousStartDay),
      endDate: dateAtDay(previousEndDay),
    }),
  });
};

const finiteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const rounded = (value, decimalPlaces = 2) => {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const directionBySign = Object.freeze({
  '-1': 'down',
  0: 'flat',
  1: 'up',
});

const deltaOf = (current, previous) => {
  const absolute = rounded(finiteNumber(current) - finiteNumber(previous));
  const baseline = finiteNumber(previous);
  const percent = baseline === 0
    ? (absolute === 0 ? 0 : null)
    : rounded((absolute / baseline) * 100);

  return Object.freeze({
    absolute,
    percent,
    direction: directionBySign[String(Math.sign(absolute))],
  });
};

const metricValuesFrom = (headers, row) =>
  fold(
    (headers ?? []).map((header, index) => ({ header, index })),
    {},
    (metrics, { header, index }) => ({
      ...metrics,
      [header?.name]: finiteNumber(row?.metricValues?.[index]?.value),
    }),
  );

const metricValuesOf = (response) =>
  metricValuesFrom(
    response?.metricHeaders,
    response?.rows?.[0]
  );

const normalizeAnalyticsRealtime = (response) =>
  pipe(
    response,
    metricValuesOf,
    (metrics) => ({ activeUsers: finiteNumber(metrics.activeUsers) }),
    Object.freeze
  );

const PUBLIC_ANALYTICS_KEY_BY_GOOGLE_METRIC = Object.freeze({
  activeUsers: 'activeUsers',
  sessions: 'sessions',
  screenPageViews: 'views',
});

const normalizeAnalyticsAggregate = (response) =>
  pipe(
    response,
    metricValuesOf,
    (metrics) =>
      GOOGLE_ANALYTICS_AGGREGATE_METRICS.map((googleMetric) => [
        PUBLIC_ANALYTICS_KEY_BY_GOOGLE_METRIC[googleMetric],
        finiteNumber(metrics[googleMetric]),
      ]),
    Object.fromEntries,
    Object.freeze
  );

const analyticsTrendOf = (current, previous) =>
  Object.freeze(
    Object.fromEntries(
      Object.values(PUBLIC_ANALYTICS_KEY_BY_GOOGLE_METRIC).map((name) => [
        name,
        deltaOf(current[name], previous[name]),
      ])
    )
  );

const normalizeAnalyticsDate = (value) => {
  const candidate = trimmedString(value) ?? '';
  return /^\d{8}$/.test(candidate)
    ? `${candidate.slice(0, 4)}-${candidate.slice(4, 6)}-${candidate.slice(6)}`
    : (isDateKey(candidate) ? candidate : null);
};

const normalizeAnalyticsDateTrend = (response) => {
  const dateIndex = (response?.dimensionHeaders ?? []).findIndex(
    ({ name }) => name === 'date'
  );

  return Object.freeze(
    (response?.rows ?? [])
      .map((row) => {
        const metrics = metricValuesFrom(response?.metricHeaders, row);
        return {
          date: normalizeAnalyticsDate(
            row?.dimensionValues?.[dateIndex]?.value
          ),
          activeUsers: finiteNumber(metrics.activeUsers),
          sessions: finiteNumber(metrics.sessions),
          views: finiteNumber(metrics.screenPageViews),
        };
      })
      .filter(({ date }) => isDateKey(date))
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-REPORTING_DAYS)
      .map(Object.freeze)
  );
};

const normalizeSearchAggregate = (response) =>
  pipe(
    response?.rows?.[0] ?? {},
    (row) =>
      GOOGLE_SEARCH_CONSOLE_METRICS.map((name) => [
        name,
        finiteNumber(row[name]),
      ]),
    Object.fromEntries,
    Object.freeze
  );

const isDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '');

const normalizeSearchDateTrend = (response) =>
  Object.freeze(
    (response?.rows ?? [])
      .map((row) => ({
        date: row?.keys?.[0],
        clicks: finiteNumber(row?.clicks),
        impressions: finiteNumber(row?.impressions),
        ctr: finiteNumber(row?.ctr),
        position: finiteNumber(row?.position),
      }))
      .filter(({ date }) => isDateKey(date))
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-REPORTING_DAYS)
      .map(Object.freeze)
  );

const hasNamedHeaders = (headers, expectedNames) =>
  Array.isArray(headers) &&
  expectedNames.every((name) =>
    headers.some((header) => header?.name === name)
  );

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExplicitOrAbsentRows = (response) =>
  isRecord(response) &&
  (response.rows === undefined || Array.isArray(response.rows));

const numericValue = (value) =>
  (typeof value === 'string' || typeof value === 'number') &&
  String(value).trim().length > 0 &&
  Number.isFinite(Number(value));

const analyticsRowsMatch = (response, metricNames, dimensionNames = []) => {
  if (!hasExplicitOrAbsentRows(response)) return false;
  const rows = response.rows ?? [];
  const metricIndexes = metricNames.map((name) =>
    response.metricHeaders.findIndex((header) => header?.name === name)
  );
  const dimensionIndexes = dimensionNames.map((name) =>
    response.dimensionHeaders.findIndex((header) => header?.name === name)
  );
  return rows.every(
    (row) =>
      metricIndexes.every((index) =>
        numericValue(row?.metricValues?.[index]?.value)
      ) &&
      dimensionIndexes.every(
        (index) => trimmedString(row?.dimensionValues?.[index]?.value) !== null
      )
  );
};

const isAnalyticsPayload = (metricNames, dimensionNames = []) => (response) =>
  hasNamedHeaders(response?.metricHeaders, metricNames) &&
  hasNamedHeaders(response?.dimensionHeaders ?? [], dimensionNames) &&
  analyticsRowsMatch(response, metricNames, dimensionNames);

const searchRowsMatch = (dimensions = []) => (response) =>
  hasExplicitOrAbsentRows(response) &&
  (response.rows ?? []).every(
    (row) =>
      GOOGLE_SEARCH_CONSOLE_METRICS.every((name) => numericValue(row?.[name])) &&
      dimensions.every((_, index) => trimmedString(row?.keys?.[index]) !== null)
  );

const validatePayload = (predicate) => (value) =>
  predicate(value)
    ? value
    : Promise.reject(new Error('Google service response was incomplete'));

const attemptPayload = (promise, predicate) =>
  attempt(promise.then(validatePayload(predicate)));

const responseIsOk = (response) =>
  response?.ok ?? (response?.status >= 200 && response?.status < 300);

const readJsonResponse = (response) =>
  responseIsOk(response)
    ? response.json()
    : Promise.reject(new Error('Google service request failed'));

const attempt = (promise) =>
  promise.then(
    right,
    () => left('upstream-unavailable')
  );

const valueFrom = (result, normalize) =>
  ematch(result, () => null, normalize);

const availabilityOfAttempts = (results) => {
  const successful = fold(
    results,
    0,
    (count, result) => count + Number(isRight(result))
  );
  return orElse(
    multiMatch(successful, [
      [0, () => 'unavailable'],
      [results.length, () => 'available'],
      [_, () => 'partial'],
    ]),
    'partial'
  );
};

const availabilityOf = (states) => {
  const counts = fold(
    states,
    { available: 0, partial: 0, unavailable: 0, unconfigured: 0 },
    (summary, state) => ({ ...summary, [state]: summary[state] + 1 }),
  );
  return orElse(
    multiMatch(counts, [
      [
        (summary) => summary.unconfigured === states.length,
        () => 'unconfigured',
      ],
      [(summary) => summary.available === states.length, () => 'available'],
      [
        (summary) =>
          summary.unavailable > 0 &&
          summary.unavailable + summary.unconfigured === states.length,
        () => 'unavailable',
      ],
      [_, () => 'partial'],
    ]),
    'partial'
  );
};

const sourceModeByKey = Object.freeze({
  'false:false': 'unconfigured',
  'false:true': 'unconfigured',
  'true:false': 'unavailable',
  'true:true': 'observe',
});

const sourceModeOf = (target, auth) =>
  sourceModeByKey[`${Boolean(target && auth.configured)}:${Boolean(auth.token)}`];

const unavailableAnalytics = (availability) =>
  Object.freeze({
    availability,
    realtime: null,
    current: null,
    previous: null,
    trend: null,
    dateTrend: Object.freeze([]),
  });

const unavailableSearchConsole = (availability) =>
  Object.freeze({
    availability,
    current: null,
    previous: null,
    dateTrend: Object.freeze([]),
  });

const postJsonWith = (boundedFetch, token) => (url, body) =>
  boundedFetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).then(readJsonResponse);

const requestAccessToken = (boundedFetch, oauth) => {
  const body = new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: oauth.refreshToken,
    grant_type: 'refresh_token',
  });

  return boundedFetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
    .then(readJsonResponse)
    .then(({ access_token: accessToken }) =>
      trimmedString(accessToken) ??
      Promise.reject(new Error('Google token response was incomplete'))
    );
};

const resolveAuth = (boundedFetch, oauth) => {
  const resolutions = {
    false: () => Promise.resolve({ configured: false, token: null }),
    true: () =>
      attempt(requestAccessToken(boundedFetch, oauth)).then((result) => ({
        configured: true,
        token: ematch(result, () => null, (value) => value),
      })),
  };

  return resolutions[String(oauth.configured)]();
};

const analyticsReportBody = (dateRange, dimensions = []) => ({
  dateRanges: [dateRange],
  dimensions,
  metrics: GOOGLE_ANALYTICS_AGGREGATE_METRICS.map((name) => ({ name })),
  keepEmptyRows: false,
});

const analyticsRealtimeBody = Object.freeze({
  metrics: Object.freeze([{ name: 'activeUsers' }]),
});

const analyticsUrlOf = (propertyId, operation) =>
  `${GOOGLE_ANALYTICS_DATA_ORIGIN}/properties/${encodeURIComponent(propertyId)}:${operation}`;

const observeConfiguredAnalytics = (postJson) => async (channel, window) => {
  const realtimeUrl = analyticsUrlOf(
    channel.analyticsPropertyId,
    'runRealtimeReport'
  );
  const reportUrl = analyticsUrlOf(channel.analyticsPropertyId, 'runReport');
  const results = await Promise.all([
    attemptPayload(
      postJson(realtimeUrl, analyticsRealtimeBody),
      isAnalyticsPayload(['activeUsers'])
    ),
    attemptPayload(
      postJson(reportUrl, analyticsReportBody(window.current)),
      isAnalyticsPayload(GOOGLE_ANALYTICS_AGGREGATE_METRICS)
    ),
    attemptPayload(
      postJson(reportUrl, analyticsReportBody(window.previous)),
      isAnalyticsPayload(GOOGLE_ANALYTICS_AGGREGATE_METRICS)
    ),
    attemptPayload(
      postJson(
        reportUrl,
        analyticsReportBody(window.current, [{ name: 'date' }])
      ),
      isAnalyticsPayload(GOOGLE_ANALYTICS_AGGREGATE_METRICS, ['date'])
    ),
  ]);
  const [realtimeResult, currentResult, previousResult, dateTrendResult] =
    results;
  const current = valueFrom(currentResult, normalizeAnalyticsAggregate);
  const previous = valueFrom(previousResult, normalizeAnalyticsAggregate);

  return Object.freeze({
    availability: availabilityOfAttempts(results),
    realtime: valueFrom(realtimeResult, normalizeAnalyticsRealtime),
    current,
    previous,
    trend: current && previous ? analyticsTrendOf(current, previous) : null,
    dateTrend:
      valueFrom(dateTrendResult, normalizeAnalyticsDateTrend) ??
      Object.freeze([]),
  });
};

const analyticsObservers = Object.freeze({
  unconfigured: () => Promise.resolve(unavailableAnalytics('unconfigured')),
  unavailable: () => Promise.resolve(unavailableAnalytics('unavailable')),
  observe: (context) =>
    observeConfiguredAnalytics(context.postJson)(context.channel, context.window),
});

const observeAnalytics = (context) =>
  analyticsObservers[
    sourceModeOf(context.channel.analyticsPropertyId, context.auth)
  ](context);

const searchConsoleBody = (dateRange, dimensions = []) => ({
  startDate: dateRange.startDate,
  endDate: dateRange.endDate,
  dimensions,
  rowLimit: REPORTING_DAYS,
  dataState: 'final',
});

const searchConsoleUrlOf = (siteUrl) =>
  `${GOOGLE_SEARCH_CONSOLE_ORIGIN}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

const observeConfiguredSearchConsole = (postJson) =>
  async (channel, window) => {
    const url = searchConsoleUrlOf(channel.searchConsoleSiteUrl);
    const results = await Promise.all([
      attemptPayload(
        postJson(url, searchConsoleBody(window.current)),
        searchRowsMatch()
      ),
      attemptPayload(
        postJson(url, searchConsoleBody(window.previous)),
        searchRowsMatch()
      ),
      attemptPayload(
        postJson(url, searchConsoleBody(window.current, ['date'])),
        searchRowsMatch(['date'])
      ),
    ]);
    const [currentResult, previousResult, dateTrendResult] = results;

    return Object.freeze({
      availability: availabilityOfAttempts(results),
      current: valueFrom(currentResult, normalizeSearchAggregate),
      previous: valueFrom(previousResult, normalizeSearchAggregate),
      dateTrend:
        valueFrom(dateTrendResult, normalizeSearchDateTrend) ?? Object.freeze([]),
    });
  };

const searchConsoleObservers = Object.freeze({
  unconfigured: () =>
    Promise.resolve(unavailableSearchConsole('unconfigured')),
  unavailable: () => Promise.resolve(unavailableSearchConsole('unavailable')),
  observe: (context) =>
    observeConfiguredSearchConsole(context.postJson)(
      context.channel,
      context.window
    ),
});

const observeSearchConsole = (context) =>
  searchConsoleObservers[
    sourceModeOf(context.channel.searchConsoleSiteUrl, context.auth)
  ](context);

const observeChannel = (context) => async (channel) => {
  const sourceContext = { ...context, channel };
  const [analytics, searchConsole] = await Promise.all([
    observeAnalytics(sourceContext),
    observeSearchConsole(sourceContext),
  ]);

  return Object.freeze({
    id: channel.id,
    label: channel.label,
    availability: availabilityOf([
      analytics.availability,
      searchConsole.availability,
    ]),
    analytics,
    searchConsole,
  });
};

const createObservatoryService = ({
  config = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheTtlMs = DEFAULT_OBSERVATORY_CACHE_TTL_MS,
  requestTimeoutMs = DEFAULT_OBSERVATORY_REQUEST_TIMEOUT_MS,
  makeTimeoutSignal,
  store = createObservatoryStore({
    now,
    ttlMs: positiveMilliseconds(cacheTtlMs, DEFAULT_OBSERVATORY_CACHE_TTL_MS),
    preferCandidate: preferObservatoryCandidate,
  }),
} = {}) => {
  const configuration = observatoryConfigOf({ config, env });
  const boundedFetch = createBoundedFetch({
    fetchImpl,
    timeoutMs: requestTimeoutMs,
    makeTimeoutSignal,
  });

  const observe = async () => {
    const observedAt = now();
    const window = reportingWindowOf(observedAt);
    const auth = await resolveAuth(boundedFetch, configuration.oauth);
    const postJson = auth.token ? postJsonWith(boundedFetch, auth.token) : null;
    const properties = await Promise.all(
      configuration.channels.map(
        observeChannel({ auth, postJson, window })
      )
    );

    return Object.freeze({
      checkedAt: new Date(observedAt).toISOString(),
      window,
      availability: availabilityOf(
        properties.map(({ availability }) => availability)
      ),
      properties: Object.freeze(properties),
    });
  };

  return Object.freeze({ getSummary: () => store.read(observe) });
};

module.exports = {
  analyticsTrendOf,
  availabilityOf,
  createObservatoryService,
  deltaOf,
  normalizeAnalyticsAggregate,
  normalizeAnalyticsDateTrend,
  normalizeAnalyticsRealtime,
  normalizeSearchAggregate,
  normalizeSearchDateTrend,
  observatoryConfigOf,
  preferObservatoryCandidate,
  reportingWindowOf,
};
