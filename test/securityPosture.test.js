'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  AUTHORIZED_ASSESSMENT_POLICY,
  AUTHORIZED_DAST_TARGETS,
  MAX_SECURITY_POSTURE_TARGETS,
  PASSIVE_SECURITY_POSTURE_POLICY,
  SECURITY_POSTURE_POLICY,
  securityPosturePolicyIssues,
} = require('../src/components/securityPosturePolicy');
const {
  createSecurityPostureStore,
} = require('../src/entities/securityPostureStore');
const {
  createSecurityPostureService,
  projectControlEvidence,
  safeHttpsUrl,
  sanitizeAssessmentRecord,
} = require('../src/systems/securityPosture');
const initialState = require('../src/data/initialState.json');
const securityAssessments = require('../src/data/securityAssessments.json');
const securityPosturePolicy = require('../src/data/securityPosturePolicy.json');

const definition = initialState.presentation.runtime.securityPosture;
const rubric = definition.rubric;

const responseWithDefenses = () => ({
  status: 200,
  headers: new Headers({
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
  }),
});

const validAssessmentRecord = () => ({
  schemaVersion: 1,
  assessmentId: 'zap-active-api-2026-08-31',
  target: { id: 'api', origin: 'https://api.sdin.dev' },
  profile: 'active',
  active: true,
  observedAt: '2026-08-31T20:00:00.000Z',
  validUntil: '2026-09-07T20:00:00.000Z',
  state: 'complete',
  severityCounts: {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    informational: 4,
  },
  alertsTotal: 999,
  coverage: { passive: true, active: true, authenticated: false },
  limits: {
    maxDurationMinutes: AUTHORIZED_ASSESSMENT_POLICY.maxDurationMinutes,
    maxRuleDurationMinutes: AUTHORIZED_ASSESSMENT_POLICY.maxRuleDurationMinutes,
    delayMs: AUTHORIZED_ASSESSMENT_POLICY.delayMs,
  },
  trend: {
    direction: 'improving',
    previousObservedAt: '2026-08-30T20:00:00.000Z',
    deltaAlerts: -2,
  },
  provider: 'OWASP ZAP',
});

const snapshot = (checkedAt = '2026-08-31T20:00:00.000Z') => ({
  schemaVersion: '1.0.0',
  kind: 'digital-estate-security-posture',
  description: 'fixture',
  checkedAt,
  scope: { authority: 'authored-site-catalog' },
  posture: { targets: 1 },
  sites: [{ id: 'registry', state: 'observed-complete' }],
  assessments: { state: 'not-published', records: [] },
  links: [],
  provenance: { authority: 'fixture', observedAt: checkedAt },
});

describe('digital-estate security posture', () => {
  test('projects defensive evidence without returning raw header values', () => {
    const controls = projectControlEvidence({
      rubric,
      response: responseWithDefenses(),
      httpsFetchSucceeded: true,
    });

    assert.deepEqual(
      Object.values(controls),
      Array.from({ length: rubric.length }, () => 'present')
    );
    assert.doesNotMatch(JSON.stringify(controls), /31536000|default-src|camera/u);

    const unavailable = projectControlEvidence({
      rubric,
      response: null,
      httpsFetchSucceeded: false,
    });
    assert.deepEqual(
      Object.values(unavailable),
      Array.from({ length: rubric.length }, () => 'unavailable')
    );
  });

  test('probes only authored public HTTPS sites with bounded passive HEAD requests', async () => {
    let clock = Date.parse('2026-08-31T20:00:00.000Z');
    const calls = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const service = createSecurityPostureService({
      sites: [{
        id: 'registry',
        label: 'Registry',
        url: 'https://registry.example/system',
      }],
      definition: {
        ...definition,
      },
      assessment: {
        schemaVersion: 1,
        state: 'published',
        updatedAt: '2026-08-31T21:00:00.000Z',
        records: [validAssessmentRecord()],
      },
      now: () => clock,
      cacheTtlMs: 100,
      makeTimeoutSignal: () => undefined,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        await gate;
        return responseWithDefenses();
      },
    });

    const firstPromise = service.getSummary('https://attacker.example');
    const concurrentPromise = service.getSummary({ target: 'https://attacker.example' });
    assert.equal(firstPromise, concurrentPromise);
    await Promise.resolve();
    release();
    const [first, concurrent] = await Promise.all([firstPromise, concurrentPromise]);
    const cached = await service.getSummary();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://registry.example/system');
    assert.equal(calls[0].init.method, PASSIVE_SECURITY_POSTURE_POLICY.method);
    assert.equal(calls[0].init.redirect, PASSIVE_SECURITY_POSTURE_POLICY.redirect);
    assert.equal(calls[0].init.credentials, PASSIVE_SECURITY_POSTURE_POLICY.credentials);
    assert.equal(calls[0].init.cache, PASSIVE_SECURITY_POSTURE_POLICY.cache);
    assert.equal(first.cached, false);
    assert.equal(first.stale, false);
    assert.deepEqual(concurrent, first);
    assert.equal(cached.cached, true);
    assert.equal(cached.stale, false);
    assert.equal(first.scope.userSuppliedTargetsAccepted, false);
    assert.equal(first.scope.responseBodiesRead, false);
    assert.equal(first.sites[0].state, 'observed-complete');
    assert.equal(first.posture.coveragePercent, 100);
    assert.equal(first.assessments.records[0].alertsTotal, 10);
    assert.equal('limits' in first.assessments.records[0], false);
    assert.equal(first.assessments.policy.publicTrigger, false);
    assert.equal(first.assessments.policy.rawFindingsPublic, false);
    assert.deepEqual(
      first.assessments.policy.targets,
      AUTHORIZED_DAST_TARGETS
    );
    assert.equal(JSON.stringify(first).includes('attacker.example'), false);

    clock += 101;
  });

  test('reduces passive transport failure to unavailable evidence without diagnostics', async () => {
    const service = createSecurityPostureService({
      sites: [{ id: 'registry', label: 'Registry', url: 'https://registry.example' }],
      definition,
      assessment: securityAssessments,
      now: () => Date.parse('2026-08-31T20:00:00.000Z'),
      makeTimeoutSignal: () => undefined,
      fetchImpl: async () => {
        throw new Error('private DNS certificate and socket detail');
      },
    });

    const result = await service.getSummary();

    assert.equal(result.sites[0].state, 'unavailable');
    assert.equal(result.sites[0].httpStatus, null);
    assert.equal(result.sites[0].transport.httpsFetchSucceeded, false);
    assert.equal(result.posture.coveragePercent, null);
    assert.doesNotMatch(JSON.stringify(result), /private|certificate and socket/u);
  });

  test('sanitizes aggregate assessment fields and rejects raw-finding input', () => {
    const record = validAssessmentRecord();
    const projected = sanitizeAssessmentRecord(
      () => Date.parse('2026-08-31T21:00:00.000Z')
    )(record);

    assert.equal(projected.alertsTotal, 10);
    assert.equal(projected.provenance.sanitized, true);
    assert.equal(projected.provenance.rawFindingsPublic, false);
    assert.equal('limits' in projected, false);
    assert.equal('alerts' in projected, false);

    const contaminated = {
      schemaVersion: 1,
      state: 'published',
      updatedAt: '2026-08-31T21:00:00.000Z',
      records: [{ ...record, rawFindings: [{ path: '/private' }] }],
    };
    assert.throws(
      () => createSecurityPostureService({
        sites: [{ id: 'api', label: 'API', url: 'https://api.sdin.dev' }],
        definition,
        assessment: contaminated,
      }),
      /assessment-record-private-field/u
    );

    const unavailableWithInventedZeroes = {
      schemaVersion: 1,
      state: 'published',
      updatedAt: '2026-08-31T21:00:00.000Z',
      records: [{
        ...record,
        state: 'unavailable',
        severityCounts: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          informational: 0,
        },
        alertsTotal: 0,
      }],
    };
    assert.throws(
      () => createSecurityPostureService({
        sites: [{ id: 'api', label: 'API', url: 'https://api.sdin.dev' }],
        definition,
        assessment: unavailableWithInventedZeroes,
      }),
      /assessment-record-evidence-state-parity/u
    );
  });

  test('rejects unsafe or unbounded authored scan catalogs before effects exist', () => {
    assert.equal(safeHttpsUrl('https://public.example/path'), true);
    assert.equal(safeHttpsUrl('https://public.example/path?target=other'), false);
    assert.equal(safeHttpsUrl('http://public.example'), false);
    assert.equal(safeHttpsUrl('https://127.0.0.1'), false);
    assert.equal(safeHttpsUrl('https://localhost'), false);
    assert.equal(safeHttpsUrl('https://user:secret@public.example'), false);
    assert.equal(safeHttpsUrl('https://public.example:8443'), false);

    const overflow = Array.from(
      { length: MAX_SECURITY_POSTURE_TARGETS + 1 },
      (_, index) => ({
        id: `target-${index}`,
        label: `Target ${index}`,
        url: `https://target-${index}.example`,
      })
    );
    assert.throws(
      () => createSecurityPostureService({
        sites: overflow,
        definition,
        assessment: securityAssessments,
      }),
      /sites-bound/u
    );
  });

  test('loads every posture capability from validated and deeply frozen JSON authority', () => {
    assert.deepEqual(securityPosturePolicyIssues(securityPosturePolicy), []);
    assert.strictEqual(SECURITY_POSTURE_POLICY, securityPosturePolicy);
    assert.equal(Object.isFrozen(SECURITY_POSTURE_POLICY), true);
    assert.equal(Object.isFrozen(PASSIVE_SECURITY_POSTURE_POLICY), true);
    assert.equal(Object.isFrozen(AUTHORIZED_ASSESSMENT_POLICY), true);
    assert.equal(Object.isFrozen(AUTHORIZED_DAST_TARGETS), true);
    assert.equal(Object.isFrozen(AUTHORIZED_DAST_TARGETS[0]), true);

    const publicTrigger = structuredClone(securityPosturePolicy);
    publicTrigger.assessment.publicTrigger = true;
    assert.ok(securityPosturePolicyIssues(publicTrigger)
      .includes('assessment-public-trigger'));

    const arbitraryTarget = structuredClone(securityPosturePolicy);
    arbitraryTarget.assessment.authorizedTargets.push({
      id: 'third-party',
      origin: 'https://third-party.example',
    });
    assert.ok(securityPosturePolicyIssues(arbitraryTarget)
      .includes('assessment-authorized-targets-bound'));
  });

  test('keeps serializable snapshots in RTK while single-flight effects stay outside it', async () => {
    let clock = 0;
    let releases = 0;
    let resolveRefresh;
    const store = createSecurityPostureStore({ now: () => clock, ttlMs: 10 });
    const refresh = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    const produce = () => {
      releases += 1;
      return refresh;
    };

    const firstPromise = store.read(produce);
    const concurrentPromise = store.read(produce);
    assert.equal(firstPromise, concurrentPromise);
    resolveRefresh(snapshot());
    const first = await firstPromise;

    assert.equal(releases, 1);
    assert.equal(first.cached, false);
    assert.deepEqual(store.getState().ids, ['registry']);
    assert.doesNotThrow(() => JSON.stringify(store.getState()));

    clock = 11;
    let failedRefreshes = 0;
    const stale = await store.read(() => {
      failedRefreshes += 1;
      return Promise.reject(new Error('private effect failure'));
    });
    const cooldown = await store.read(() => {
      failedRefreshes += 1;
      return Promise.reject(new Error('must not run during cooldown'));
    });

    assert.equal(failedRefreshes, 1);
    assert.equal(stale.cached, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.provenance.stale, true);
    assert.deepEqual(cooldown, stale);
    assert.equal(JSON.stringify(stale).includes('private effect failure'), false);
  });
});
