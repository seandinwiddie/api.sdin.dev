'use strict';

const net = require('node:net');

const { fold } = require('functional-programming-composition');

const authoredPolicy = require('../data/securityPosturePolicy.json');

const TOP_LEVEL_FIELDS = Object.freeze([
  'assessment',
  'controls',
  'passive',
  'schemaVersion',
]);
const PASSIVE_FIELDS = Object.freeze([
  'accept',
  'cache',
  'cacheTtlMs',
  'credentials',
  'maxTargets',
  'method',
  'redirect',
  'requestTimeoutMs',
  'responseBodiesRead',
  'userAgent',
]);
const ASSESSMENT_FIELDS = Object.freeze([
  'activeProfile',
  'activeRuleIds',
  'activeScanMinutes',
  'attackStrength',
  'authenticated',
  'authorizedTargets',
  'baselineSpiderMinutes',
  'cooldownMs',
  'delayMs',
  'documentStates',
  'emptyDocumentState',
  'executionBoundary',
  'expirableStates',
  'expiredState',
  'maxAlertsPerRule',
  'maxConcurrentTargets',
  'maxDurationMinutes',
  'maxRequestsPerSecond',
  'maxRuleDurationMinutes',
  'maxRunsPerTargetPerDay',
  'noEvidenceStates',
  'passiveWaitMinutes',
  'profiles',
  'publicTrigger',
  'publishedDocumentState',
  'rawFindingsPublic',
  'recordStates',
  'severities',
  'trendDirections',
  'unavailableTrendDirection',
]);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactFields = (value, fields) =>
  isObject(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const nonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0;
const safeIntegerBetween = (minimum, maximum) => (value) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const unique = (values) => new Set(values).size === values.length;
const token = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
const numericRuleId = (value) =>
  typeof value === 'string' && /^\d{4,8}$/u.test(value);
const safeOrigin = (value) => {
  const parsed = nonEmptyString(value) && URL.canParse(value)
    ? new URL(value)
    : null;
  const hostname = parsed?.hostname.replace(/^\[|\]$/gu, '') ?? '';
  return Boolean(
    parsed &&
      parsed.protocol === 'https:' &&
      parsed.origin === value &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      hostname !== 'localhost' &&
      !hostname.endsWith('.localhost') &&
      !hostname.endsWith('.local') &&
      net.isIP(hostname) === 0
  );
};
const arrayOf = (predicate) => (value) =>
  Array.isArray(value) && value.length > 0 && value.every(predicate) && unique(value);
const subsetOf = (values) => (candidates) =>
  Array.isArray(candidates) && candidates.every((candidate) => values.includes(candidate));
const issueUnless = (condition, issue) => condition ? [] : [issue];

const targetIssues = (targets) => {
  const entries = Array.isArray(targets) ? targets : [];
  return [
    ...issueUnless(Array.isArray(targets), 'assessment-authorized-targets-array'),
    ...issueUnless(entries.length > 0 && entries.length <= 2, 'assessment-authorized-targets-bound'),
    ...issueUnless(unique(entries.map((target) => target?.id)), 'assessment-authorized-target-id-uniqueness'),
    ...issueUnless(unique(entries.map((target) => target?.origin)), 'assessment-authorized-target-origin-uniqueness'),
    ...entries.flatMap((target, index) => [
      ...issueUnless(exactFields(target, ['id', 'origin']), `assessment-target-${index}-fields`),
      ...issueUnless(token(target?.id), `assessment-target-${index}-id`),
      ...issueUnless(safeOrigin(target?.origin), `assessment-target-${index}-origin`),
    ]),
  ];
};

const securityPosturePolicyIssues = (policy) => {
  const passive = isObject(policy?.passive) ? policy.passive : {};
  const assessment = isObject(policy?.assessment) ? policy.assessment : {};
  const controls = Array.isArray(policy?.controls) ? policy.controls : [];
  const profiles = Array.isArray(assessment.profiles) ? assessment.profiles : [];
  const recordStates = Array.isArray(assessment.recordStates)
    ? assessment.recordStates
    : [];
  const documentStates = Array.isArray(assessment.documentStates)
    ? assessment.documentStates
    : [];
  const severities = Array.isArray(assessment.severities) ? assessment.severities : [];
  const trends = Array.isArray(assessment.trendDirections)
    ? assessment.trendDirections
    : [];
  const activeRuleIds = Array.isArray(assessment.activeRuleIds)
    ? assessment.activeRuleIds
    : [];

  return [
    ...issueUnless(exactFields(policy, TOP_LEVEL_FIELDS), 'policy-fields'),
    ...issueUnless(policy?.schemaVersion === 1, 'policy-schema-version'),
    ...issueUnless(exactFields(passive, PASSIVE_FIELDS), 'passive-fields'),
    ...issueUnless(safeIntegerBetween(1, 12)(passive.maxTargets), 'passive-target-bound'),
    ...issueUnless(safeIntegerBetween(1, 2 ** 31 - 1)(passive.cacheTtlMs), 'passive-cache-ttl'),
    ...issueUnless(safeIntegerBetween(1, 30_000)(passive.requestTimeoutMs), 'passive-request-timeout'),
    ...issueUnless(passive.method === 'HEAD', 'passive-method'),
    ...issueUnless(passive.redirect === 'manual', 'passive-redirect'),
    ...issueUnless(passive.credentials === 'omit', 'passive-credentials'),
    ...issueUnless(passive.cache === 'no-store', 'passive-cache'),
    ...issueUnless(nonEmptyString(passive.accept) && passive.accept.length <= 128, 'passive-accept'),
    ...issueUnless(nonEmptyString(passive.userAgent) && passive.userAgent.length <= 128, 'passive-user-agent'),
    ...issueUnless(passive.responseBodiesRead === false, 'passive-response-body'),
    ...issueUnless(arrayOf(token)(controls) && controls.length <= 16, 'control-identifiers'),
    ...issueUnless(exactFields(assessment, ASSESSMENT_FIELDS), 'assessment-fields'),
    ...issueUnless(arrayOf(token)(profiles) && profiles.length <= 8, 'assessment-profiles'),
    ...issueUnless(profiles.includes(assessment.activeProfile), 'assessment-active-profile'),
    ...issueUnless(arrayOf(token)(recordStates) && recordStates.length <= 12, 'assessment-record-states'),
    ...issueUnless(arrayOf(token)(documentStates) && documentStates.length === 2, 'assessment-document-states'),
    ...issueUnless(documentStates.includes(assessment.emptyDocumentState), 'assessment-empty-document-state'),
    ...issueUnless(documentStates.includes(assessment.publishedDocumentState), 'assessment-published-document-state'),
    ...issueUnless(assessment.emptyDocumentState !== assessment.publishedDocumentState, 'assessment-document-state-distinction'),
    ...issueUnless(
      arrayOf(token)(assessment.expirableStates) &&
        subsetOf(recordStates)(assessment.expirableStates),
      'assessment-expirable-states'
    ),
    ...issueUnless(recordStates.includes(assessment.expiredState), 'assessment-expired-state'),
    ...issueUnless(
      arrayOf(token)(assessment.noEvidenceStates) &&
        subsetOf(recordStates)(assessment.noEvidenceStates),
      'assessment-no-evidence-states'
    ),
    ...issueUnless(arrayOf(token)(severities) && severities.length <= 8, 'assessment-severities'),
    ...issueUnless(arrayOf(token)(trends) && trends.length <= 8, 'assessment-trends'),
    ...issueUnless(trends.includes(assessment.unavailableTrendDirection), 'assessment-unavailable-trend'),
    ...issueUnless(nonEmptyString(assessment.executionBoundary), 'assessment-execution-boundary'),
    ...issueUnless(assessment.publicTrigger === false, 'assessment-public-trigger'),
    ...issueUnless(assessment.rawFindingsPublic === false, 'assessment-raw-findings'),
    ...issueUnless(assessment.authenticated === false, 'assessment-authenticated'),
    ...issueUnless(safeIntegerBetween(1, 1)(assessment.maxConcurrentTargets), 'assessment-concurrency'),
    ...issueUnless(safeIntegerBetween(1, 1)(assessment.maxRunsPerTargetPerDay), 'assessment-daily-run-bound'),
    ...issueUnless(safeIntegerBetween(1, 2)(assessment.maxRequestsPerSecond), 'assessment-request-rate'),
    ...issueUnless(safeIntegerBetween(500, 60_000)(assessment.delayMs), 'assessment-delay'),
    ...issueUnless(
      safeIntegerBetween(1, 15)(assessment.maxDurationMinutes),
      'assessment-duration'
    ),
    ...issueUnless(
      safeIntegerBetween(1, assessment.maxDurationMinutes ?? 0)(assessment.maxRuleDurationMinutes),
      'assessment-rule-duration'
    ),
    ...issueUnless(safeIntegerBetween(1, 3)(assessment.baselineSpiderMinutes), 'assessment-baseline-spider'),
    ...issueUnless(safeIntegerBetween(1, 5)(assessment.passiveWaitMinutes), 'assessment-passive-wait'),
    ...issueUnless(safeIntegerBetween(1, 10)(assessment.activeScanMinutes), 'assessment-active-scan'),
    ...issueUnless(
      [
        assessment.baselineSpiderMinutes,
        assessment.passiveWaitMinutes,
        assessment.activeScanMinutes,
      ].every(Number.isSafeInteger) &&
        assessment.baselineSpiderMinutes +
          assessment.passiveWaitMinutes +
          assessment.activeScanMinutes <= assessment.maxDurationMinutes,
      'assessment-phase-duration-parity'
    ),
    ...issueUnless(safeIntegerBetween(1, 5)(assessment.maxAlertsPerRule), 'assessment-alert-bound'),
    ...issueUnless(assessment.attackStrength === 'LOW', 'assessment-attack-strength'),
    ...issueUnless(safeIntegerBetween(86_400_000, 2 ** 31 - 1)(assessment.cooldownMs), 'assessment-cooldown'),
    ...issueUnless(
      assessment.delayMs >= Math.ceil(1000 / (assessment.maxRequestsPerSecond || 1)),
      'assessment-delay-rate-parity'
    ),
    ...issueUnless(arrayOf(numericRuleId)(activeRuleIds) && activeRuleIds.length <= 8, 'assessment-active-rule-ids'),
    ...targetIssues(assessment.authorizedTargets),
  ];
};

const deepFreeze = (value) => {
  if (!isObject(value) && !Array.isArray(value)) return value;
  fold(Object.values(value), value, (owner, entry) => {
    deepFreeze(entry);
    return owner;
  });
  return Object.freeze(value);
};

const requireValidPolicy = (policy) => {
  const issues = securityPosturePolicyIssues(policy);
  if (issues.length > 0) {
    throw new Error(`Invalid authored security posture policy: ${issues.join(', ')}`);
  }
  return deepFreeze(policy);
};

const SECURITY_POSTURE_POLICY = requireValidPolicy(authoredPolicy);
const PASSIVE_SECURITY_POSTURE_POLICY = SECURITY_POSTURE_POLICY.passive;
const AUTHORIZED_ASSESSMENT_POLICY = SECURITY_POSTURE_POLICY.assessment;
const AUTHORIZED_DAST_TARGETS = AUTHORIZED_ASSESSMENT_POLICY.authorizedTargets;
const AUTHORIZED_ACTIVE_SCAN_RULE_IDS = AUTHORIZED_ASSESSMENT_POLICY.activeRuleIds;
const DEFAULT_SECURITY_POSTURE_CACHE_TTL_MS = PASSIVE_SECURITY_POSTURE_POLICY.cacheTtlMs;
const DEFAULT_SECURITY_POSTURE_REQUEST_TIMEOUT_MS =
  PASSIVE_SECURITY_POSTURE_POLICY.requestTimeoutMs;
const MAX_SECURITY_POSTURE_TARGETS = PASSIVE_SECURITY_POSTURE_POLICY.maxTargets;
const SECURITY_ASSESSMENT_PROFILES = AUTHORIZED_ASSESSMENT_POLICY.profiles;
const SECURITY_ASSESSMENT_STATES = AUTHORIZED_ASSESSMENT_POLICY.recordStates;
const SECURITY_ASSESSMENT_DOCUMENT_STATES = AUTHORIZED_ASSESSMENT_POLICY.documentStates;
const SECURITY_POSTURE_CONTROL_IDS = SECURITY_POSTURE_POLICY.controls;
const SECURITY_SEVERITIES = AUTHORIZED_ASSESSMENT_POLICY.severities;
const SECURITY_TREND_DIRECTIONS = AUTHORIZED_ASSESSMENT_POLICY.trendDirections;

module.exports = {
  AUTHORIZED_ACTIVE_SCAN_RULE_IDS,
  AUTHORIZED_ASSESSMENT_POLICY,
  AUTHORIZED_DAST_TARGETS,
  DEFAULT_SECURITY_POSTURE_CACHE_TTL_MS,
  DEFAULT_SECURITY_POSTURE_REQUEST_TIMEOUT_MS,
  MAX_SECURITY_POSTURE_TARGETS,
  PASSIVE_SECURITY_POSTURE_POLICY,
  SECURITY_ASSESSMENT_DOCUMENT_STATES,
  SECURITY_ASSESSMENT_PROFILES,
  SECURITY_ASSESSMENT_STATES,
  SECURITY_POSTURE_CONTROL_IDS,
  SECURITY_POSTURE_POLICY,
  SECURITY_SEVERITIES,
  SECURITY_TREND_DIRECTIONS,
  securityPosturePolicyIssues,
};
