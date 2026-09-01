#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ALLOWED_METHODS,
  DEFAULT_SECURITY_POLICY,
  HELMET_OPTIONS,
  PERMISSIONS_POLICY,
  REQUIRED_HOSTS,
  REQUIRED_ORIGINS,
} = require('../src/components/securityPolicy');
const {
  AUTHORIZED_ASSESSMENT_POLICY,
  AUTHORIZED_DAST_TARGETS,
  MAX_SECURITY_POSTURE_TARGETS,
  PASSIVE_SECURITY_POSTURE_POLICY,
  SECURITY_POSTURE_POLICY,
  securityPosturePolicyIssues,
} = require('../src/components/securityPosturePolicy');
const { securityPolicyFrom } = require('../src/security');

const secretSignatures = Object.freeze([
  Object.freeze({
    id: 'private-key',
    pattern: new RegExp(
      ['-----BEGIN', '(?:(?:RSA|OPENSSH|EC|DSA) )?PRIVATE KEY-----'].join(' '),
      'u'
    ),
  }),
  Object.freeze({ id: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{30,}/u }),
  Object.freeze({ id: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/u }),
  Object.freeze({ id: 'aws-access-key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/u }),
  Object.freeze({ id: 'slack-token', pattern: /xox[baprs]-[0-9A-Za-z-]{20,}/u }),
  Object.freeze({
    id: 'server-secret-assignment',
    pattern: /(?:GITHUB_TOKEN|GOOGLE_OAUTH_CLIENT_SECRET|GOOGLE_OAUTH_REFRESH_TOKEN)\s*=\s*["']?[A-Za-z0-9_./+=-]{16,}/u,
  }),
  Object.freeze({
    id: 'npm-auth-token',
    pattern: /_authToken\s*=\s*["']?[A-Za-z0-9_./+=-]{16,}/u,
  }),
]);

const sensitiveTrackedPath = (filePath) => {
  const base = path.basename(filePath).toLowerCase();
  const extension = path.extname(base);
  return base === '.env' || base.startsWith('.env.') ||
    ['.key', '.p12', '.pem', '.pfx'].includes(extension);
};

const secretFindingsFrom = (filePath) => (text) => [
  ...(sensitiveTrackedPath(filePath)
    ? [{ filePath, rule: 'sensitive-file-tracked' }]
    : []),
  ...secretSignatures
    .filter(({ pattern }) => pattern.test(text))
    .map(({ id }) => ({ filePath, rule: id })),
];

const sameValues = (left) => (right) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const policyFindings = () => {
  const defaultPolicy = securityPolicyFrom({ env: {} });
  const checks = [
    ['method-capability', sameValues(ALLOWED_METHODS)(['GET', 'HEAD', 'OPTIONS'])],
    ['canonical-host', REQUIRED_HOSTS.includes('api.sdin.dev')],
    ['portfolio-origin', REQUIRED_ORIGINS.includes('https://portfolio.sdin.dev')],
    ['content-security-policy', HELMET_OPTIONS.contentSecurityPolicy.directives.defaultSrc.includes("'none'")],
    ['frame-capability', HELMET_OPTIONS.frameguard.action === 'deny'],
    ['transport-lifetime', HELMET_OPTIONS.hsts.maxAge >= 31_536_000],
    ['referrer-capability', HELMET_OPTIONS.referrerPolicy.policy === 'no-referrer'],
    ['browser-capabilities', ['camera=()', 'geolocation=()', 'microphone=()', 'payment=()', 'usb=()']
      .every((directive) => PERMISSIONS_POLICY.includes(directive))],
    ['request-byte-bound', defaultPolicy.maxRequestBytes <= 65_536],
    ['request-target-bound', defaultPolicy.maxRequestTargetBytes <= 8_192],
    ['rate-window-bound', defaultPolicy.rateLimit.limit <= 1_000],
    ['rate-state-bound', defaultPolicy.rateLimit.maxClients <= 100_000],
    ['posture-json-policy-valid', securityPosturePolicyIssues(SECURITY_POSTURE_POLICY)
      .length === 0],
    ['posture-target-bound', MAX_SECURITY_POSTURE_TARGETS <= 12],
    ['posture-bodyless-fetch', PASSIVE_SECURITY_POSTURE_POLICY.method === 'HEAD' &&
      PASSIVE_SECURITY_POSTURE_POLICY.responseBodiesRead === false],
    ['posture-no-redirect', PASSIVE_SECURITY_POSTURE_POLICY.redirect === 'manual'],
    ['assessment-public-trigger-denied', AUTHORIZED_ASSESSMENT_POLICY.publicTrigger === false],
    ['assessment-raw-findings-private', AUTHORIZED_ASSESSMENT_POLICY.rawFindingsPublic === false],
    ['assessment-target-allowlist', sameValues(
      AUTHORIZED_DAST_TARGETS.map(({ origin }) => origin)
    )(['https://portfolio.sdin.dev', 'https://api.sdin.dev'])],
    ['assessment-target-concurrency', AUTHORIZED_ASSESSMENT_POLICY.maxConcurrentTargets === 1],
    ['assessment-daily-bound', AUTHORIZED_ASSESSMENT_POLICY.maxRunsPerTargetPerDay <= 1],
    ['assessment-request-rate', AUTHORIZED_ASSESSMENT_POLICY.maxRequestsPerSecond <= 2],
    ['assessment-delay-rate-parity', AUTHORIZED_ASSESSMENT_POLICY.delayMs >=
      Math.ceil(1000 / AUTHORIZED_ASSESSMENT_POLICY.maxRequestsPerSecond)],
    ['assessment-duration-bound', AUTHORIZED_ASSESSMENT_POLICY.maxDurationMinutes <= 15],
    ['assessment-cooldown', AUTHORIZED_ASSESSMENT_POLICY.cooldownMs >= 86_400_000],
    ['assessment-rule-bound', AUTHORIZED_ASSESSMENT_POLICY.activeRuleIds.length <= 8],
    ['frozen-policy', Object.isFrozen(defaultPolicy) && Object.isFrozen(defaultPolicy.rateLimit)],
    ['frozen-assessment-policy', Object.isFrozen(AUTHORIZED_ASSESSMENT_POLICY) &&
      Object.isFrozen(AUTHORIZED_DAST_TARGETS) &&
      Object.isFrozen(AUTHORIZED_ASSESSMENT_POLICY.activeRuleIds) &&
      Object.isFrozen(SECURITY_POSTURE_POLICY) &&
      Object.isFrozen(PASSIVE_SECURITY_POSTURE_POLICY)],
  ];

  return checks
    .filter(([, passed]) => !passed)
    .map(([rule]) => ({ filePath: 'runtime-security-policy', rule }));
};

const trackedPaths = () => {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  const output = result.status === 0
    ? result.stdout
    : (() => {
        throw new Error('Unable to enumerate candidate source files');
      })();

  return output.split('\0').filter(Boolean);
};

const scanTrackedFiles = (repositoryRoot) => (filePaths) =>
  filePaths.flatMap((filePath) => {
    const absolutePath = path.join(repositoryRoot, filePath);
    const text = fs.readFileSync(absolutePath, 'utf8');
    return secretFindingsFrom(filePath)(text);
  });

const run = () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const filePaths = trackedPaths();
  const findings = [
    ...policyFindings(),
    ...scanTrackedFiles(repositoryRoot)(filePaths),
  ];

  return findings.length === 0
    ? (() => {
        console.log(`[security] policy and candidate-secret checks passed (${filePaths.length} files)`);
        return 0;
      })()
    : (() => {
        findings.forEach(({ filePath, rule }) => {
          console.error(`[security] ${filePath}: ${rule}`);
        });
        return 1;
      })();
};

process.exitCode = require.main === module ? run() : 0;

module.exports = {
  policyFindings,
  run,
  secretFindingsFrom,
  sensitiveTrackedPath,
};
