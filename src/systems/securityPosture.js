'use strict';

const net = require('node:net');

const {
  _,
  fold,
  multiMatch,
  orElse,
} = require('functional-programming-composition');

const {
  AUTHORIZED_ASSESSMENT_POLICY,
  AUTHORIZED_DAST_TARGETS,
  DEFAULT_SECURITY_POSTURE_CACHE_TTL_MS,
  DEFAULT_SECURITY_POSTURE_REQUEST_TIMEOUT_MS,
  MAX_SECURITY_POSTURE_TARGETS,
  PASSIVE_SECURITY_POSTURE_POLICY,
  SECURITY_ASSESSMENT_PROFILES,
  SECURITY_ASSESSMENT_STATES,
  SECURITY_POSTURE_CONTROL_IDS,
  SECURITY_SEVERITIES,
  SECURITY_TREND_DIRECTIONS,
} = require('../components/securityPosturePolicy');
const { createSecurityPostureStore } = require('../entities/securityPostureStore');
const { createBoundedFetch } = require('../http');

const PUBLIC_ASSESSMENT_FIELDS = Object.freeze([
  'active',
  'alertsTotal',
  'assessmentId',
  'coverage',
  'limits',
  'profile',
  'provider',
  'schemaVersion',
  'severityCounts',
  'state',
  'target',
  'trend',
  'validUntil',
  'observedAt',
]);

const SECURITY_POSTURE_DEFINITION_FIELDS = Object.freeze([
  'description',
  'kind',
  'links',
  'rubric',
  'schemaVersion',
]);

const RUBRIC_FIELDS = Object.freeze([
  'description',
  'id',
  'label',
  'weight',
]);

const publicReferrerPolicies = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
]);

const isoAt = (milliseconds) => new Date(milliseconds).toISOString();
const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (values) => new Set(values).size === values.length;
const hasExactFields = (value, fields) =>
  isObject(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const nonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0;
const nullableIsoDate = (value) =>
  value === null || (
    nonEmptyString(value) && Number.isFinite(Date.parse(value))
  );

const safeHttpsUrl = (value) => {
  const parsed = nonEmptyString(value) && URL.canParse(value)
    ? new URL(value)
    : null;
  const hostname = parsed?.hostname.replace(/^\[|\]$/gu, '') ?? '';
  const localName = hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local');

  return Boolean(
    parsed &&
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      net.isIP(hostname) === 0 &&
      !localName
  );
};

const targetIssues = (sites) => {
  const entries = Array.isArray(sites) ? sites : [];
  return [
    ...(Array.isArray(sites) ? [] : ['sites-array']),
    ...(entries.length <= MAX_SECURITY_POSTURE_TARGETS
      ? []
      : ['sites-bound']),
    ...(unique(entries.map(({ id }) => id)) ? [] : ['site-id-uniqueness']),
    ...(unique(entries.map(({ url }) => url)) ? [] : ['site-url-uniqueness']),
    ...entries.flatMap((site, index) => [
      ...(isObject(site) ? [] : [`site-${index}-object`]),
      ...(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(site?.id ?? '')
        ? []
        : [`site-${index}-id`]),
      ...(nonEmptyString(site?.label) ? [] : [`site-${index}-label`]),
      ...(safeHttpsUrl(site?.url) ? [] : [`site-${index}-https`]),
    ]),
  ];
};

const rubricIssues = (rubric) => {
  const entries = Array.isArray(rubric) ? rubric : [];
  const ids = entries.map(({ id }) => id);
  const exactControlSet = [...ids].sort().join(',') ===
    [...SECURITY_POSTURE_CONTROL_IDS].sort().join(',');
  return [
    ...(Array.isArray(rubric) ? [] : ['rubric-array']),
    ...(unique(ids) ? [] : ['rubric-id-uniqueness']),
    ...(exactControlSet ? [] : ['rubric-control-set']),
    ...entries.flatMap((control, index) => [
      ...(hasExactFields(control, RUBRIC_FIELDS)
        ? []
        : [`rubric-${index}-fields`]),
      ...(nonEmptyString(control?.label) && nonEmptyString(control?.description)
        ? []
        : [`rubric-${index}-copy`]),
      ...(Number.isSafeInteger(control?.weight) && control.weight > 0 && control.weight <= 5
        ? []
        : [`rubric-${index}-weight`]),
    ]),
  ];
};

const linkIssues = (links) => {
  const entries = Array.isArray(links) ? links : [];
  return [
    ...(Array.isArray(links) ? [] : ['links-array']),
    ...(unique(entries.map(({ rel }) => rel)) ? [] : ['link-rel-uniqueness']),
    ...entries.flatMap((link, index) => [
      ...(hasExactFields(link, ['href', 'rel', 'type'])
        ? []
        : [`link-${index}-fields`]),
      ...(/^[a-z][a-z0-9-]*$/u.test(link?.rel ?? '')
        ? []
        : [`link-${index}-rel`]),
      ...(safeHttpsUrl(link?.href) ? [] : [`link-${index}-https`]),
      ...(link?.type === 'application/json' ? [] : [`link-${index}-type`]),
    ]),
  ];
};

const assessmentDefinitionIssues = (assessment) => {
  const records = Array.isArray(assessment?.records) ? assessment.records : [];
  const latestObservedAt = records.reduce(
    (latest, record) => Math.max(latest, Date.parse(record?.observedAt) || 0),
    0
  );
  const updatedAt = Date.parse(assessment?.updatedAt) || 0;
  return [
    ...(hasExactFields(assessment, ['records', 'schemaVersion', 'state', 'updatedAt'])
      ? []
      : ['assessment-fields']),
    ...(assessment?.schemaVersion === 1 ? [] : ['assessment-schema']),
    ...(
      (records.length === 0 &&
        assessment?.state === AUTHORIZED_ASSESSMENT_POLICY.emptyDocumentState) ||
      (records.length > 0 &&
        assessment?.state === AUTHORIZED_ASSESSMENT_POLICY.publishedDocumentState)
      ? []
      : ['assessment-state']),
    ...(
      (records.length === 0 && assessment?.updatedAt === null) ||
      (records.length > 0 && nullableIsoDate(assessment?.updatedAt) &&
        updatedAt >= latestObservedAt)
      ? []
      : ['assessment-updated-at']),
    ...(Array.isArray(assessment?.records) ? [] : ['assessment-records-array']),
    ...records.flatMap(assessmentRecordIssues),
  ];
};

const securityPostureDefinitionIssues = ({ sites, definition }) => [
  ...targetIssues(sites),
  ...(hasExactFields(definition, SECURITY_POSTURE_DEFINITION_FIELDS)
    ? []
    : ['definition-fields']),
  ...(/^\d+\.\d+\.\d+$/u.test(definition?.schemaVersion ?? '')
    ? []
    : ['definition-schema']),
  ...(definition?.kind === 'digital-estate-security-posture'
    ? []
    : ['definition-kind']),
  ...(nonEmptyString(definition?.description) ? [] : ['definition-description']),
  ...rubricIssues(definition?.rubric),
  ...linkIssues(definition?.links),
];

const securityAssessmentIssues = (assessment) =>
  assessmentDefinitionIssues(assessment);

const requireValidDefinition = (input) => {
  const issues = [
    ...securityPostureDefinitionIssues(input),
    ...securityAssessmentIssues(input.assessment),
  ];
  if (issues.length > 0) {
    throw new Error(`Invalid security posture definition: ${issues.join(', ')}`);
  }
  return input;
};

const headerValue = (headers, name) => {
  const value = typeof headers?.get === 'function'
    ? headers.get(name)
    : headers?.[name] ?? headers?.[name.toLowerCase()];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
};

const present = (value) => value.length > 0;
const presentState = (predicate) => (context) =>
  context.available
    ? (predicate(context) ? 'present' : 'missing')
    : 'unavailable';

const CONTROL_EVIDENCE = Object.freeze({
  'encrypted-transport': presentState(({ httpsFetchSucceeded }) => httpsFetchSucceeded),
  'strict-transport-security': presentState(({ headers }) => {
    const value = headerValue(headers, 'strict-transport-security');
    const maxAge = value.match(/(?:^|;)\s*max-age=(\d+)/u)?.[1];
    return Number(maxAge) > 0;
  }),
  'content-security-policy': presentState(({ headers }) =>
    present(headerValue(headers, 'content-security-policy'))),
  'frame-protection': presentState(({ headers }) => {
    const csp = headerValue(headers, 'content-security-policy');
    const frameOptions = headerValue(headers, 'x-frame-options');
    return /(?:^|;)\s*frame-ancestors\s+/u.test(csp) ||
      ['deny', 'sameorigin'].includes(frameOptions);
  }),
  'content-type-options': presentState(({ headers }) =>
    headerValue(headers, 'x-content-type-options') === 'nosniff'),
  'referrer-policy': presentState(({ headers }) =>
    headerValue(headers, 'referrer-policy')
      .split(',')
      .some((entry) => publicReferrerPolicies.has(entry.trim()))),
  'permissions-policy': presentState(({ headers }) =>
    present(headerValue(headers, 'permissions-policy'))),
  'cross-origin-isolation': presentState(({ headers }) =>
    headerValue(headers, 'cross-origin-opener-policy') === 'same-origin' &&
      ['require-corp', 'credentialless'].includes(
        headerValue(headers, 'cross-origin-embedder-policy')
      )),
});

const projectControlEvidence = ({ rubric, response, httpsFetchSucceeded }) => {
  const context = {
    available: Boolean(response),
    headers: response?.headers,
    httpsFetchSucceeded,
  };
  return Object.freeze(
    Object.fromEntries(
      rubric.map(({ id }) => [id, CONTROL_EVIDENCE[id](context)])
    )
  );
};

const coverageOf = (rubric, controls) => {
  const coverage = fold(
    rubric,
    { met: 0, evaluated: 0, weightMet: 0, weightEvaluated: 0 },
    (totals, control) => ({
      met: totals.met + Number(controls[control.id] === 'present'),
      evaluated: totals.evaluated + Number(controls[control.id] !== 'unavailable'),
      weightMet:
        totals.weightMet +
        (controls[control.id] === 'present' ? control.weight : 0),
      weightEvaluated:
        totals.weightEvaluated +
        (controls[control.id] === 'unavailable' ? 0 : control.weight),
    })
  );
  return Object.freeze({
    ...coverage,
    percent: coverage.weightEvaluated === 0
      ? null
      : Math.round((coverage.weightMet / coverage.weightEvaluated) * 100),
  });
};

const httpStateOf = (status) =>
  orElse(
    multiMatch(status, [
      [(value) => value >= 200 && value < 300, () => 'success'],
      [(value) => value >= 300 && value < 400, () => 'redirect'],
      [(value) => value >= 400 && value < 500, () => 'client-error'],
      [(value) => value >= 500 && value < 600, () => 'server-error'],
      [_, () => 'unknown'],
    ]),
    'unknown'
  );

const siteStateOf = (coverage) =>
  orElse(
    multiMatch(coverage, [
      [({ evaluated }) => evaluated === 0, () => 'unavailable'],
      [({ met, evaluated }) => met === evaluated, () => 'observed-complete'],
      [_, () => 'observed-partial'],
    ]),
    'unavailable'
  );

const normalizeTarget = ({ id, label, url }) => Object.freeze({ id, label, url });

const targetForAssessment = (target) =>
  AUTHORIZED_DAST_TARGETS.find(
    (candidate) => candidate.id === target?.id && candidate.origin === target?.origin
  ) ?? null;

const finiteCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

const sanitizedSeverity = (severityCounts) => {
  const counts = Object.fromEntries(
    SECURITY_SEVERITIES.map((severity) => [
      severity,
      finiteCount(severityCounts?.[severity]),
    ])
  );
  return Object.values(counts).every((value) => value !== null)
    ? Object.freeze(counts)
    : null;
};

const sanitizedTrend = (trend) => Object.freeze({
  direction: SECURITY_TREND_DIRECTIONS.includes(trend?.direction)
    ? trend.direction
    : AUTHORIZED_ASSESSMENT_POLICY.unavailableTrendDirection,
  previousObservedAt: nullableIsoDate(trend?.previousObservedAt)
    ? trend?.previousObservedAt ?? null
    : null,
  deltaAlerts: Number.isSafeInteger(trend?.deltaAlerts)
    ? trend.deltaAlerts
    : null,
});

const sanitizedCoverage = (coverage) => Object.freeze({
  passive: coverage?.passive === true,
  active: coverage?.active === true,
  authenticated: false,
});

const assessmentRecordIssues = (record) => {
  const target = targetForAssessment(record?.target);
  const severity = sanitizedSeverity(record?.severityCounts);
  const evidenceRequired = !AUTHORIZED_ASSESSMENT_POLICY.noEvidenceStates
    .includes(record?.state);
  const findingsUnavailable = AUTHORIZED_ASSESSMENT_POLICY.noEvidenceStates
    .includes(record?.state);
  const timesOrdered = record?.observedAt === null || record?.validUntil === null
    ? !evidenceRequired
    : Date.parse(record.observedAt) < Date.parse(record.validUntil);
  const activeMatchesProfile =
    record?.profile === AUTHORIZED_ASSESSMENT_POLICY.activeProfile
    ? record?.active === true
    : record?.active === false;
  const expectedLimits = {
    delayMs: AUTHORIZED_ASSESSMENT_POLICY.delayMs,
    maxDurationMinutes: AUTHORIZED_ASSESSMENT_POLICY.maxDurationMinutes,
    maxRuleDurationMinutes: AUTHORIZED_ASSESSMENT_POLICY.maxRuleDurationMinutes,
  };
  return [
    ...(isObject(record) ? [] : ['assessment-record-object']),
    ...(Object.keys(record ?? {}).every((field) => PUBLIC_ASSESSMENT_FIELDS.includes(field))
      ? []
      : ['assessment-record-private-field']),
    ...(record?.schemaVersion === 1 ? [] : ['assessment-record-schema']),
    ...(/^[A-Za-z0-9._:-]{1,96}$/u.test(record?.assessmentId ?? '')
      ? []
      : ['assessment-record-id']),
    ...(target === null ? ['assessment-record-target'] : []),
    ...(hasExactFields(record?.target, ['id', 'origin'])
      ? []
      : ['assessment-record-target-fields']),
    ...(SECURITY_ASSESSMENT_PROFILES.includes(record?.profile)
      ? []
      : ['assessment-record-profile']),
    ...(typeof record?.active === 'boolean' ? [] : ['assessment-record-active']),
    ...(activeMatchesProfile ? [] : ['assessment-record-profile-active-parity']),
    ...(SECURITY_ASSESSMENT_STATES.includes(record?.state)
      ? []
      : ['assessment-record-state']),
    ...(nullableIsoDate(record?.observedAt) && nullableIsoDate(record?.validUntil)
      ? []
      : ['assessment-record-time']),
    ...(timesOrdered ? [] : ['assessment-record-time-order']),
    ...(
      (findingsUnavailable && severity === null && record?.alertsTotal === null) ||
      (!findingsUnavailable && severity !== null &&
        finiteCount(record?.alertsTotal) !== null)
        ? []
        : ['assessment-record-evidence-state-parity']
    ),
    ...(hasExactFields(record?.severityCounts, SECURITY_SEVERITIES)
      ? []
      : ['assessment-record-severity-fields']),
    ...(hasExactFields(record?.coverage, ['active', 'authenticated', 'passive'])
      ? []
      : ['assessment-record-coverage-fields']),
    ...(typeof record?.coverage?.passive === 'boolean' &&
      typeof record?.coverage?.active === 'boolean'
      ? []
      : ['assessment-record-coverage-values']),
    ...(record?.coverage?.active === record?.active
      ? []
      : ['assessment-record-coverage-active-parity']),
    ...(record?.coverage?.authenticated === false
      ? []
      : ['assessment-record-authenticated']),
    ...(hasExactFields(record?.trend, [
      'deltaAlerts',
      'direction',
      'previousObservedAt',
    ]) ? [] : ['assessment-record-trend-fields']),
    ...(SECURITY_TREND_DIRECTIONS.includes(record?.trend?.direction) &&
      nullableIsoDate(record?.trend?.previousObservedAt) &&
      (record?.trend?.deltaAlerts === null ||
        Number.isSafeInteger(record?.trend?.deltaAlerts))
      ? []
      : ['assessment-record-trend-values']),
    ...(record?.provider === null || (
      nonEmptyString(record?.provider) && record.provider.trim().length <= 64
    )
      ? []
      : ['assessment-record-provider']),
    ...(hasExactFields(record?.limits, [
      'delayMs',
      'maxDurationMinutes',
      'maxRuleDurationMinutes',
    ]) && Object.entries(expectedLimits).every(
      ([field, value]) => record.limits[field] === value
    ) ? [] : ['assessment-record-limits']),
  ];
};

const sanitizeAssessmentRecord = (now) => (record) => {
  const issues = assessmentRecordIssues(record);
  if (issues.length > 0) {
    throw new Error(`Invalid public assessment record: ${issues.join(', ')}`);
  }
  const severityCounts = sanitizedSeverity(record.severityCounts);
  const expired = record.validUntil !== null && Date.parse(record.validUntil) <= now();
  const state = expired && AUTHORIZED_ASSESSMENT_POLICY.expirableStates
    .includes(record.state)
    ? AUTHORIZED_ASSESSMENT_POLICY.expiredState
    : record.state;

  return Object.freeze({
    schemaVersion: 1,
    assessmentId: record.assessmentId,
    target: targetForAssessment(record.target),
    profile: record.profile,
    active: record.active,
    state,
    provider: nonEmptyString(record.provider) ? record.provider.trim().slice(0, 64) : null,
    observedAt: record.observedAt,
    validUntil: record.validUntil,
    severityCounts,
    alertsTotal: severityCounts === null
      ? null
      : fold(Object.values(severityCounts), 0, (total, count) => total + count),
    coverage: sanitizedCoverage(record.coverage),
    trend: sanitizedTrend(record.trend),
    provenance: Object.freeze({
      sanitized: true,
      rawFindingsPublic: false,
    }),
  });
};

const aggregateSeverity = (records) => {
  const complete = records.filter(({ severityCounts }) => severityCounts !== null);
  return complete.length === 0
    ? null
    : Object.freeze(
        Object.fromEntries(
          SECURITY_SEVERITIES.map((severity) => [
            severity,
            fold(complete, 0, (total, record) =>
              total + record.severityCounts[severity]),
          ])
        )
      );
};

const projectAssessment = (assessment, now) => {
  const records = Object.freeze(
    (assessment?.records ?? []).map(sanitizeAssessmentRecord(now))
  );
  const severityCounts = aggregateSeverity(records);
  return Object.freeze({
    schemaVersion: assessment.schemaVersion,
    updatedAt: assessment.updatedAt,
    state: records.length === 0
      ? assessment.state
      : AUTHORIZED_ASSESSMENT_POLICY.publishedDocumentState,
    severityCounts,
    alertsTotal: severityCounts === null
      ? null
      : fold(Object.values(severityCounts), 0, (total, count) => total + count),
    records,
    policy: Object.freeze({
      executionBoundary: AUTHORIZED_ASSESSMENT_POLICY.executionBoundary,
      publicTrigger: AUTHORIZED_ASSESSMENT_POLICY.publicTrigger,
      rawFindingsPublic: AUTHORIZED_ASSESSMENT_POLICY.rawFindingsPublic,
      targets: AUTHORIZED_DAST_TARGETS,
      maxConcurrentTargets: AUTHORIZED_ASSESSMENT_POLICY.maxConcurrentTargets,
      maxRunsPerTargetPerDay: AUTHORIZED_ASSESSMENT_POLICY.maxRunsPerTargetPerDay,
      maxRequestsPerSecond: AUTHORIZED_ASSESSMENT_POLICY.maxRequestsPerSecond,
      maxDurationMinutes: AUTHORIZED_ASSESSMENT_POLICY.maxDurationMinutes,
      maxRuleDurationMinutes: AUTHORIZED_ASSESSMENT_POLICY.maxRuleDurationMinutes,
      delayMs: AUTHORIZED_ASSESSMENT_POLICY.delayMs,
      cooldownMs: AUTHORIZED_ASSESSMENT_POLICY.cooldownMs,
      authenticated: AUTHORIZED_ASSESSMENT_POLICY.authenticated,
    }),
  });
};

const summarizeSites = (sites) => {
  const totals = fold(
    sites,
    {
      targets: sites.length,
      observed: 0,
      unavailable: 0,
      completeCoverage: 0,
      controlsMet: 0,
      controlsEvaluated: 0,
      weightMet: 0,
      weightEvaluated: 0,
    },
    (summary, site) => ({
      ...summary,
      observed: summary.observed + Number(site.state !== 'unavailable'),
      unavailable: summary.unavailable + Number(site.state === 'unavailable'),
      completeCoverage:
        summary.completeCoverage + Number(site.state === 'observed-complete'),
      controlsMet: summary.controlsMet + site.coverage.met,
      controlsEvaluated: summary.controlsEvaluated + site.coverage.evaluated,
      weightMet: summary.weightMet + site.coverage.weightMet,
      weightEvaluated:
        summary.weightEvaluated + site.coverage.weightEvaluated,
    })
  );
  return Object.freeze({
    ...totals,
    coveragePercent: totals.weightEvaluated === 0
      ? null
      : Math.round((totals.weightMet / totals.weightEvaluated) * 100),
  });
};

const createSecurityPostureService = ({
  sites,
  definition,
  assessment,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheTtlMs = DEFAULT_SECURITY_POSTURE_CACHE_TTL_MS,
  requestTimeoutMs = DEFAULT_SECURITY_POSTURE_REQUEST_TIMEOUT_MS,
  makeTimeoutSignal,
  store = createSecurityPostureStore({ now, ttlMs: cacheTtlMs }),
} = {}) => {
  requireValidDefinition({ sites, definition, assessment });
  const authoredSites = Object.freeze(sites.map(normalizeTarget));
  const rubric = Object.freeze(definition.rubric.map(Object.freeze));
  const boundedFetch = createBoundedFetch({
    fetchImpl,
    timeoutMs: requestTimeoutMs,
    makeTimeoutSignal,
  });

  const observeSite = async (site) => {
    let response = null;
    let httpsFetchSucceeded = false;
    try {
      response = await boundedFetch(site.url, {
        method: PASSIVE_SECURITY_POSTURE_POLICY.method,
        redirect: PASSIVE_SECURITY_POSTURE_POLICY.redirect,
        credentials: PASSIVE_SECURITY_POSTURE_POLICY.credentials,
        cache: PASSIVE_SECURITY_POSTURE_POLICY.cache,
        headers: {
          Accept: PASSIVE_SECURITY_POSTURE_POLICY.accept,
          'User-Agent': PASSIVE_SECURITY_POSTURE_POLICY.userAgent,
        },
      });
      httpsFetchSucceeded = true;
    } catch {
      response = null;
    }

    const observedAt = isoAt(now());
    const controls = projectControlEvidence({
      rubric,
      response,
      httpsFetchSucceeded,
    });
    const coverage = coverageOf(rubric, controls);

    return Object.freeze({
      ...site,
      state: siteStateOf(coverage),
      httpStatus: response?.status ?? null,
      httpState: response === null ? 'unavailable' : httpStateOf(response.status),
      transport: Object.freeze({
        scheme: 'https',
        httpsFetchSucceeded,
        certificateDetailsPublic: false,
      }),
      controls,
      coverage,
      observedAt,
    });
  };

  const observe = async () => {
    const observedSites = Object.freeze(await Promise.all(authoredSites.map(observeSite)));
    const checkedAt = isoAt(now());
    return Object.freeze({
      schemaVersion: definition.schemaVersion,
      kind: definition.kind,
      description: definition.description,
      checkedAt,
      scope: Object.freeze({
        authority: 'authored-site-catalog',
        sourcePath: '/data#presentation.nexus.presences',
        siteCount: authoredSites.length,
        maximumSiteCount: MAX_SECURITY_POSTURE_TARGETS,
        userSuppliedTargetsAccepted: false,
        method: PASSIVE_SECURITY_POSTURE_POLICY.method,
        redirects: PASSIVE_SECURITY_POSTURE_POLICY.redirect,
        responseBodiesRead: PASSIVE_SECURITY_POSTURE_POLICY.responseBodiesRead,
      }),
      posture: summarizeSites(observedSites),
      sites: observedSites,
      assessments: projectAssessment(assessment, now),
      links: definition.links,
      provenance: Object.freeze({
        authority: 'api-authored-json-and-runtime-observation',
        observedAt: checkedAt,
      }),
    });
  };

  return Object.freeze({
    getSummary: () => store.read(observe),
  });
};

module.exports = {
  SECURITY_ASSESSMENT_PROFILES,
  PUBLIC_ASSESSMENT_FIELDS,
  coverageOf,
  createSecurityPostureService,
  projectAssessment,
  projectControlEvidence,
  safeHttpsUrl,
  sanitizeAssessmentRecord,
  securityAssessmentIssues,
  securityPostureDefinitionIssues,
  summarizeSites,
};
