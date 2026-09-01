const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  policyFindings,
  secretFindingsFrom,
  sensitiveTrackedPath,
} = require('../scripts/check-security');

describe('security release checker', () => {
  test('accepts the committed least-capability policy invariants', () => {
    assert.deepEqual(policyFindings(), []);
  });

  test('identifies sensitive tracked paths without reading untracked environment files', () => {
    assert.equal(sensitiveTrackedPath('.env.local'), true);
    assert.equal(sensitiveTrackedPath('config/service.pem'), true);
    assert.equal(sensitiveTrackedPath('src/data/initialState.json'), false);
    assert.deepEqual(secretFindingsFrom('.env.production')(''), [{
      filePath: '.env.production',
      rule: 'sensitive-file-tracked',
    }]);
  });

  test('reports signature names without returning matched credential material', () => {
    const githubToken = ['ghp', 'A'.repeat(36)].join('_');
    const privateKey = [
      ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      'secret-body',
      ['-----END', 'PRIVATE KEY-----'].join(' '),
    ].join('\n');
    const findings = secretFindingsFrom('src/unsafe.js')(
      `${githubToken}\n${privateKey}`
    );

    assert.deepEqual(findings, [
      { filePath: 'src/unsafe.js', rule: 'private-key' },
      { filePath: 'src/unsafe.js', rule: 'github-token' },
    ]);
    assert.doesNotMatch(JSON.stringify(findings), new RegExp(githubToken, 'u'));
    assert.doesNotMatch(JSON.stringify(findings), /secret-body/u);
  });
});
