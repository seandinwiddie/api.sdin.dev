const { test, describe } = require('node:test');
const assert = require('node:assert');
const { getSummary, getRepos, getProfile, getActivity } = require('../src/github');
const { parseCalendarHtml } = require('../src/contributions');

/**
 * These run against the real GitHub API -- no mocks, so a shape change upstream
 * shows up here rather than in production. Two requests total, well inside the
 * unauthenticated 60/hour limit, and the module cache makes repeats free.
 */
describe('github aggregation', () => {
  test('profile is normalized to the fields the portfolio renders', async () => {
    const { profile } = await getProfile();
    assert.equal(typeof profile.login, 'string');
    assert.equal(typeof profile.publicRepos, 'number');
    assert.equal(typeof profile.followers, 'number');
    assert.match(profile.htmlUrl, /^https:\/\/github\.com\//);
    // The raw payload has ~40 fields; only the normalized ones should survive.
    assert.equal(profile.public_repos, undefined);
    assert.equal(profile.avatar_url, undefined);
  });

  test('repos exclude forks and archives, and are normalized', async () => {
    const { repos } = await getRepos();
    assert.ok(repos.length > 0, 'expected at least one repo');
    repos.forEach((repo) => {
      assert.equal(typeof repo.id, 'string');
      assert.equal(typeof repo.name, 'string');
      assert.ok(Array.isArray(repo.topics));
      assert.match(repo.htmlUrl, /^https:\/\/github\.com\//);
      assert.equal(repo.stargazers_count, undefined, 'raw GitHub fields should not leak');
    });
  });

  test('repos are ordered most recently pushed first', async () => {
    const { repos } = await getRepos();
    const pushed = repos.map((r) => r.pushedAt);
    assert.deepEqual(pushed, [...pushed].sort().reverse());
  });

  test('language breakdown counts repos and is ordered by frequency', async () => {
    const { repos, languages } = await getRepos();
    assert.ok(languages.length > 0);

    const counts = languages.map((l) => l.count);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'should be descending');

    const totalWithLanguage = repos.filter((r) => r.language).length;
    assert.equal(
      languages.reduce((sum, l) => sum + l.count, 0),
      totalWithLanguage,
      'every language-bearing repo should be counted exactly once'
    );
  });

  test('repos span the user account and their organisations', async () => {
    const { repos, owners } = await getRepos();
    const distinct = new Set(repos.map((r) => r.owner));
    assert.ok(distinct.size > 1, 'expected org repos alongside personal ones');
    assert.ok(owners.some((o) => o.owner === 'ForbocAI'), 'ForbocAI work should be included');
    // fullName disambiguates same-named repos across owners.
    assert.equal(new Set(repos.map((r) => r.fullName)).size, repos.length);
  });

  test('activity is normalized and tallied', async () => {
    const activity = await getActivity();
    assert.ok(Array.isArray(activity.events));
    assert.ok(activity.events.every((e) => typeof e.kind === 'string'), 'unknown kinds filtered out');
    assert.deepEqual(
      activity.byKind.map((k) => k.count),
      [...activity.byKind.map((k) => k.count)].sort((a, b) => b - a),
      'tallies should be descending'
    );
    assert.equal(
      activity.byRepo.reduce((sum, r) => sum + r.count, 0),
      activity.total,
      'every event counted exactly once'
    );
  });

  test('the contribution calendar is chronological and internally consistent', async () => {
    const { contributions } = await getSummary();
    if (contributions === null) {
      // Degraded path is legitimate: the HTML source is not a contract.
      return;
    }
    const dates = contributions.days.map((d) => d.date);
    assert.deepEqual(dates, [...dates].sort(), 'days must be chronological');
    assert.ok(contributions.days.every((d) => d.level >= 0 && d.level <= 4));
    assert.ok(contributions.total >= 0);
  });

  test('a calendar that cannot be parsed degrades to null rather than throwing', () => {
    assert.equal(parseCalendarHtml('<html>nothing resembling a calendar</html>'), null);
  });

  test('the second call is served from cache', async () => {
    await getSummary();
    const second = await getSummary();
    assert.equal(second.cached, true);
  });

  test('summary composes profile, repos and languages in one payload', async () => {
    const summary = await getSummary();
    assert.deepEqual(
      Object.keys(summary).sort(),
      ['activity', 'authenticated', 'cached', 'contributions', 'languages', 'owners', 'profile', 'repos']
    );
    assert.equal(typeof summary.authenticated, 'boolean');
  });
});
