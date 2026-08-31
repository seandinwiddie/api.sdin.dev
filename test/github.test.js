const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createGithubService } = require('../src/github');
const { createContributionLoader, parseCalendarHtml } = require('../src/contributions');

const quietLogger = { warn: () => {}, error: () => {} };

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Unavailable',
  json: async () => body,
  text: async () => String(body),
});

const rawProfile = {
  login: 'seandinwiddie',
  name: 'Sean Dinwiddie',
  bio: 'Builder',
  location: 'California',
  blog: 'https://sdin.dev',
  avatar_url: 'https://avatars.example/sean',
  html_url: 'https://github.com/seandinwiddie',
  public_repos: 2,
  followers: 95,
};

const rawRepo = ({ id, owner, name, language, pushedAt, createdAt }) => ({
  id,
  name,
  full_name: `${owner}/${name}`,
  owner: { login: owner },
  description: `${name} description`,
  language,
  stargazers_count: id,
  forks_count: 0,
  topics: ['portfolio'],
  created_at: createdAt,
  html_url: `https://github.com/${owner}/${name}`,
  homepage: null,
  pushed_at: pushedAt,
  fork: false,
  archived: false,
});

const personalRepo = rawRepo({
  id: 1,
  owner: 'seandinwiddie',
  name: 'portfolio',
  language: 'TypeScript',
  pushedAt: '2026-08-29T00:00:00Z',
  createdAt: '2014-08-20T00:00:00Z',
});

const orgRepo = rawRepo({
  id: 2,
  owner: 'ForbocAI',
  name: 'demo-ue-5',
  language: 'C++',
  pushedAt: '2026-08-30T00:00:00Z',
  createdAt: '2025-01-01T00:00:00Z',
});

const rawEvents = [
  { id: 'e2', type: 'IssuesEvent', repo: { name: 'ForbocAI/demo-ue-5' }, created_at: '2026-08-30T02:00:00Z' },
  { id: 'e1', type: 'PushEvent', repo: { name: 'seandinwiddie/portfolio' }, created_at: '2026-08-30T01:00:00Z' },
];

const rawCommits = {
  total_count: 1,
  items: [
    {
      sha: 'abcdef1234567890',
      repository: { full_name: 'seandinwiddie/portfolio' },
      commit: {
        message: 'feat(ui): show recent work\n\nDetails',
        author: { date: '2026-08-30T03:00:00Z' },
      },
      html_url: 'https://github.com/seandinwiddie/portfolio/commit/abcdef1234567890',
    },
  ],
};

const calendar = {
  days: [{ date: '2026-08-30', count: 3, level: 2 }],
  total: 3,
  source: 'html',
};

const routePayloads = {
  '/users/seandinwiddie': rawProfile,
  '/users/seandinwiddie/repos?per_page=100&sort=pushed': [personalRepo],
  '/orgs/ForbocAI/repos?per_page=100&sort=pushed': [orgRepo],
  '/users/seandinwiddie/events/public?per_page=100': rawEvents,
  '/search/commits?q=author:seandinwiddie&sort=author-date&order=desc&per_page=50': rawCommits,
};

const createFixtureFetch = (overrides = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const route = `${parsed.pathname}${parsed.search}`;
    calls.push({ route, signal: init.signal });
    const configured = Object.prototype.hasOwnProperty.call(overrides, route)
      ? overrides[route]
      : routePayloads[route];
    const resolved = typeof configured === 'function' ? configured() : configured;
    return resolved?.ok !== undefined ? resolved : jsonResponse(resolved);
  };
  return { calls, fetchImpl };
};

const createFixtureService = (overrides = {}) => {
  const fixture = createFixtureFetch(overrides.routes);
  const service = createGithubService({
    fetchImpl: fixture.fetchImpl,
    now: overrides.now ?? (() => Date.parse('2026-08-30T04:00:00Z')),
    cacheTtlMs: overrides.cacheTtlMs ?? 1000,
    requestTimeoutMs: 50,
    loadContributionsImpl: overrides.loadContributionsImpl ?? (async () => calendar),
    logger: quietLogger,
  });
  return { ...fixture, service };
};

const missingKeys = (value, keys) => keys.filter((key) => !Object.hasOwn(value, key));

describe('github aggregation', () => {
  test('summary normalizes all resources and exposes serializable availability', async () => {
    const { service } = createFixtureService();
    const summary = await service.getSummary();

    assert.deepEqual(summary.repos.map((repo) => repo.fullName), [
      'ForbocAI/demo-ue-5',
      'seandinwiddie/portfolio',
    ]);
    assert.deepEqual(summary.languages, [
      { language: 'C++', count: 1 },
      { language: 'TypeScript', count: 1 },
    ]);
    assert.deepEqual(summary.owners, [
      { owner: 'ForbocAI', count: 1 },
      { owner: 'seandinwiddie', count: 1 },
    ]);
    assert.equal(summary.profile.public_repos, undefined);
    assert.equal(summary.commits.commits[0].subject, 'feat(ui): show recent work');
    assert.equal(summary.commits.commits[0].scope, 'ui');
    assert.equal(summary.availability.state, 'live');
    assert.equal(summary.partial, false);
    assert.doesNotThrow(() => JSON.stringify(summary.availability));
  });

  test('preserves the portfolio contract for /github and /github/commits', async () => {
    const { service } = createFixtureService();
    const summary = await service.getSummary();
    const commits = await service.getCommits();

    assert.deepEqual(missingKeys(summary, [
      'profile',
      'repos',
      'languages',
      'owners',
      'since',
      'activity',
      'contributions',
      'commits',
      'cached',
      'stale',
      'partial',
      'availability',
      'authenticated',
    ]), []);
    assert.deepEqual(missingKeys(summary.profile, [
      'login',
      'name',
      'bio',
      'location',
      'blog',
      'avatarUrl',
      'htmlUrl',
      'publicRepos',
      'followers',
    ]), []);
    assert.deepEqual(missingKeys(summary.repos[0], [
      'id',
      'name',
      'fullName',
      'owner',
      'description',
      'language',
      'stars',
      'forks',
      'topics',
      'createdAt',
      'htmlUrl',
      'homepage',
      'pushedAt',
    ]), []);
    assert.deepEqual(missingKeys(summary.activity, [
      'events',
      'byRepo',
      'byKind',
      'total',
      'since',
      'until',
    ]), []);
    assert.deepEqual(missingKeys(summary.commits, ['commits', 'total', 'byType']), []);
    assert.deepEqual(missingKeys(summary.availability, [
      'state',
      'cached',
      'stale',
      'partial',
      'checkedAt',
      'resources',
    ]), []);
    assert.deepEqual(missingKeys(commits, [
      'commits',
      'total',
      'byType',
      'cached',
      'stale',
      'availability',
    ]), []);
    assert.deepEqual(missingKeys(commits.availability, [
      'state',
      'cached',
      'stale',
      'partial',
      'fetchedAt',
      'degradedSources',
      'errorCode',
    ]), []);
    assert.deepEqual(missingKeys(commits.commits[0], [
      'sha',
      'repo',
      'at',
      'url',
      'type',
      'scope',
      'summary',
      'subject',
    ]), []);
  });

  test('a second summary is served wholly from the per-instance cache', async () => {
    const { calls, service } = createFixtureService();
    await service.getSummary();
    const firstCallCount = calls.length;
    const second = await service.getSummary();

    assert.equal(calls.length, firstCallCount);
    assert.equal(second.cached, true);
    assert.equal(second.availability.state, 'cached');
  });

  test('concurrent cache misses share one in-flight request', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const service = createGithubService({
      fetchImpl: async () => {
        requests += 1;
        await gate;
        return jsonResponse(rawProfile);
      },
      requestTimeoutMs: 50,
      logger: quietLogger,
    });

    const first = service.getProfile();
    const second = service.getProfile();
    await Promise.resolve();
    assert.equal(requests, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
  });

  test('a partial repo result is explicitly marked partial, including cache hits', async () => {
    const orgRoute = '/orgs/ForbocAI/repos?per_page=100&sort=pushed';
    const { service } = createFixtureService({
      routes: { [orgRoute]: jsonResponse({ error: 'down' }, 503) },
    });

    const first = await service.getRepos();
    const second = await service.getRepos();
    assert.deepEqual(first.repos.map((repo) => repo.fullName), ['seandinwiddie/portfolio']);
    assert.equal(first.availability.state, 'partial');
    assert.equal(first.cached, false);
    assert.equal(second.availability.state, 'partial');
    assert.equal(second.cached, true);
    assert.equal(second.availability.errorCode, 'PARTIAL_UPSTREAM');
    assert.deepEqual(first.availability.degradedSources, [orgRoute]);
  });

  test('all repo sources unavailable rejects instead of returning a healthy empty cache entry', async () => {
    const unavailable = jsonResponse({ error: 'down' }, 503);
    const { service } = createFixtureService({
      routes: {
        '/users/seandinwiddie/repos?per_page=100&sort=pushed': unavailable,
        '/orgs/ForbocAI/repos?per_page=100&sort=pushed': unavailable,
      },
    });

    await assert.rejects(service.getRepos(), /repository sources unavailable/);
  });

  test('stale partial data remains partial instead of being reported as healthy stale data', async () => {
    let clock = 0;
    let personalAvailable = true;
    const personalRoute = '/users/seandinwiddie/repos?per_page=100&sort=pushed';
    const orgRoute = '/orgs/ForbocAI/repos?per_page=100&sort=pushed';
    const { service } = createFixtureService({
      now: () => clock,
      cacheTtlMs: 100,
      routes: {
        [personalRoute]: () => personalAvailable ? [personalRepo] : jsonResponse({ error: 'down' }, 503),
        [orgRoute]: jsonResponse({ error: 'down' }, 503),
      },
    });

    const partial = await service.getRepos();
    assert.equal(partial.availability.state, 'partial');
    clock = 101;
    personalAvailable = false;
    const stalePartial = await service.getRepos();

    assert.equal(stalePartial.stale, true);
    assert.equal(stalePartial.availability.state, 'partial');
    assert.equal(stalePartial.availability.partial, true);
    assert.equal(stalePartial.availability.errorCode, 'UPSTREAM_ERROR');
  });

  test('partial refresh never replaces a complete stale repo value', async () => {
    let clock = 0;
    let orgAvailable = true;
    const orgRoute = '/orgs/ForbocAI/repos?per_page=100&sort=pushed';
    const { service } = createFixtureService({
      now: () => clock,
      cacheTtlMs: 100,
      routes: {
        [orgRoute]: () => orgAvailable ? [orgRepo] : jsonResponse({ error: 'down' }, 503),
      },
    });

    const complete = await service.getRepos();
    assert.equal(complete.repos.length, 2);
    clock = 101;
    orgAvailable = false;
    const refreshed = await service.getRepos();

    assert.equal(refreshed.repos.length, 2);
    assert.equal(refreshed.stale, true);
    assert.equal(refreshed.availability.state, 'stale');
    assert.equal(refreshed.availability.errorCode, 'PARTIAL_UPSTREAM');
    assert.deepEqual(refreshed.availability.degradedSources, [orgRoute]);
  });

  test('commit failure degrades only the commit resource in the summary', async () => {
    const commitRoute = '/search/commits?q=author:seandinwiddie&sort=author-date&order=desc&per_page=50';
    const { service } = createFixtureService({
      routes: { [commitRoute]: jsonResponse({ error: 'down' }, 503) },
    });
    const summary = await service.getSummary();

    assert.equal(summary.repos.length, 2);
    assert.deepEqual(summary.commits.commits, []);
    assert.equal(summary.commits.availability.state, 'unavailable');
    assert.equal(summary.availability.state, 'partial');
    assert.equal(summary.partial, true);
  });

  test('bounded GitHub requests surface a deterministic timeout', async () => {
    const timeout = Object.assign(new Error('deadline'), { name: 'TimeoutError' });
    const signal = AbortSignal.abort(timeout);
    const service = createGithubService({
      fetchImpl: async (url, init) => {
        assert.equal(init.signal, signal);
        throw init.signal.reason;
      },
      makeTimeoutSignal: () => signal,
      requestTimeoutMs: 50,
      logger: quietLogger,
    });

    await assert.rejects(service.getProfile(), /timed out after 50ms/);
  });

  test('calendar parsing is chronological and rejects missing calendars', () => {
    const html = [
      '4 contributions',
      '<td data-date="2026-08-30" data-level="2"></td>',
      '<td data-date="2026-08-29" data-level="1"></td>',
      '<tool-tip>3 contributions on August 30</tool-tip>',
      '<tool-tip>1 contribution on August 29</tool-tip>',
    ].join('\n');
    const parsed = parseCalendarHtml(html);

    assert.deepEqual(parsed.days.map((day) => day.date), ['2026-08-29', '2026-08-30']);
    assert.equal(parsed.total, 4);
    assert.equal(parseCalendarHtml('<html>no calendar</html>'), null);
  });

  test('contribution requests use the same bounded effect and degrade to null', async () => {
    const timeout = Object.assign(new Error('deadline'), { name: 'TimeoutError' });
    const signal = AbortSignal.abort(timeout);
    const loadContributions = createContributionLoader({
      fetchImpl: async (url, init) => {
        assert.equal(init.signal, signal);
        throw init.signal.reason;
      },
      makeTimeoutSignal: () => signal,
      timeoutMs: 50,
      logger: quietLogger,
    });

    assert.equal(await loadContributions(), null);
  });
});
