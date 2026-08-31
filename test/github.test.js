const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  MAX_GITHUB_ORGS,
  MAX_PUBLIC_REPOSITORIES,
  createGithubService,
  normalizeOrganizations,
} = require('../src/github');
const {
  MAX_CONTRIBUTION_DAYS,
  createContributionLoader,
  parseCalendarHtml,
} = require('../src/contributions');

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
  private: false,
  visibility: 'public',
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
      repository: {
        full_name: 'seandinwiddie/portfolio',
        private: false,
      },
      commit: {
        message: 'feat(ui): show recent work\n\nDetails',
        author: { date: '2026-08-30T03:00:00Z' },
      },
      html_url: 'https://github.com/seandinwiddie/portfolio/commit/abcdef1234567890',
    },
  ],
};

const COMMIT_ROUTE =
  '/search/commits?q=author%3Aseandinwiddie+is%3Apublic&sort=author-date&order=desc&per_page=50';

const calendar = {
  days: [{ date: '2026-08-30', count: 3, level: 2 }],
  total: 3,
  source: 'html',
};

const routePayloads = {
  '/users/seandinwiddie': rawProfile,
  '/users/seandinwiddie/repos?per_page=100&sort=pushed': [personalRepo],
  '/orgs/ForbocAI/repos?type=public&per_page=100&sort=pushed': [orgRepo],
  '/users/seandinwiddie/events/public?per_page=100': rawEvents,
  [COMMIT_ROUTE]: rawCommits,
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
    orgs: overrides.orgs,
    cacheTtlMs: overrides.cacheTtlMs ?? 1000,
    requestTimeoutMs: 50,
    loadContributionsImpl: overrides.loadContributionsImpl ?? (async () => calendar),
    logger: quietLogger,
  });
  return { ...fixture, service };
};

const missingKeys = (value, keys) => keys.filter((key) => !Object.hasOwn(value, key));

describe('github aggregation', () => {
  test('bounds configured organizations and projected repositories', async () => {
    const orgs = Array.from({ length: MAX_GITHUB_ORGS + 3 }, (_, index) =>
      `organization-${index}`
    );
    const repositories = Array.from(
      { length: MAX_PUBLIC_REPOSITORIES + 10 },
      (_, index) => rawRepo({
        id: index + 100,
        owner: 'seandinwiddie',
        name: `repository-${index}`,
        language: 'TypeScript',
        pushedAt: `2026-08-${String(30 - (index % 20)).padStart(2, '0')}T00:00:00Z`,
        createdAt: '2020-01-01T00:00:00Z',
      })
    );
    const calls = [];
    const service = createGithubService({
      orgs,
      fetchImpl: async (url) => {
        calls.push(new URL(url).pathname);
        return jsonResponse(url.includes('/users/') ? repositories : []);
      },
      loadContributionsImpl: async () => null,
      logger: quietLogger,
    });

    const result = await service.getRepos();

    assert.equal(normalizeOrganizations([...orgs, orgs[0]]).length, MAX_GITHUB_ORGS);
    assert.equal(calls.length, MAX_GITHUB_ORGS + 1);
    assert.equal(result.repos.length, MAX_PUBLIC_REPOSITORIES);
  });

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

  test('organization repositories request public visibility and reject private items', async () => {
    const privateRepo = {
      ...orgRepo,
      id: 99,
      name: 'private-system',
      full_name: 'ForbocAI/private-system',
      html_url: 'https://github.com/ForbocAI/private-system',
      private: true,
      visibility: 'private',
    };
    const organizationRoute =
      '/orgs/ForbocAI/repos?type=public&per_page=100&sort=pushed';
    const { calls, service } = createFixtureService({
      routes: { [organizationRoute]: [orgRepo, privateRepo] },
    });

    const result = await service.getRepos();

    assert.ok(calls.some(({ route }) => route === organizationRoute));
    assert.equal(result.repos.some(({ name }) => name === 'private-system'), false);
    assert.equal(JSON.stringify(result).includes('private-system'), false);
  });

  test('orders an empty public repository by its creation fallback', async () => {
    const emptyRepo = {
      ...personalRepo,
      id: 98,
      name: 'empty-public-system',
      full_name: 'seandinwiddie/empty-public-system',
      html_url: 'https://github.com/seandinwiddie/empty-public-system',
      created_at: '2010-01-01T00:00:00Z',
      pushed_at: null,
    };
    const { service } = createFixtureService({
      routes: {
        '/users/seandinwiddie/repos?per_page=100&sort=pushed': [
          emptyRepo,
          personalRepo,
        ],
      },
    });

    const result = await service.getRepos();

    assert.equal(result.repos.at(-1).name, 'empty-public-system');
    assert.equal(result.repos.at(-1).pushedAt, emptyRepo.created_at);
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

  test('commit search requests public visibility and rejects private repository items', async () => {
    const privateItem = {
      ...rawCommits.items[0],
      sha: 'private1234567890',
      repository: {
        full_name: 'seandinwiddie/private-system',
        private: true,
        visibility: 'private',
      },
      html_url: 'https://github.com/seandinwiddie/private-system/commit/private1234567890',
    };
    const { calls, service } = createFixtureService({
      routes: {
        [COMMIT_ROUTE]: {
          total_count: 2,
          items: [...rawCommits.items, privateItem],
        },
      },
    });

    const commits = await service.getCommits();

    assert.ok(calls.some(({ route }) => route === COMMIT_ROUTE));
    assert.equal(commits.total, 1);
    assert.equal(commits.commits.length, 1);
    assert.equal(commits.commits[0].repo, 'seandinwiddie/portfolio');
    assert.equal(JSON.stringify(commits).includes('private-system'), false);
  });

  test('malformed successful resources retain stronger truthful cache entries', async () => {
    let clock = 0;
    let malformed = false;
    const personalRoute = '/users/seandinwiddie/repos?per_page=100&sort=pushed';
    const orgRoute = '/orgs/ForbocAI/repos?type=public&per_page=100&sort=pushed';
    const { service } = createFixtureService({
      now: () => clock,
      cacheTtlMs: 100,
      routes: {
        '/users/seandinwiddie': () => (malformed ? {} : rawProfile),
        [personalRoute]: () => (malformed ? {} : [personalRepo]),
        [orgRoute]: () => (malformed ? {} : [orgRepo]),
        '/users/seandinwiddie/events/public?per_page=100': () =>
          malformed ? {} : rawEvents,
        [COMMIT_ROUTE]: () => (malformed ? {} : rawCommits),
      },
    });

    const first = await Promise.all([
      service.getProfile(),
      service.getRepos(),
      service.getActivity(),
      service.getCommits(),
    ]);
    clock = 101;
    malformed = true;
    const retained = await Promise.all([
      service.getProfile(),
      service.getRepos(),
      service.getActivity(),
      service.getCommits(),
    ]);

    retained.forEach((resource) => assert.equal(resource.stale, true));
    assert.deepEqual(retained[0].profile, first[0].profile);
    assert.deepEqual(retained[1].repos, first[1].repos);
    assert.deepEqual(retained[2].events, first[2].events);
    assert.deepEqual(retained[3].commits, first[3].commits);
  });

  test('malformed optional profile fields reject before public projection', async () => {
    const privateMarker = 'private-nested-profile-marker';
    const malformedFields = [
      ['name', { privateMarker }],
      ['bio', [privateMarker]],
      ['location', { value: privateMarker }],
      ['blog', 42],
    ];

    for (const [field, value] of malformedFields) {
      const { service } = createFixtureService({
        routes: {
          '/users/seandinwiddie': { ...rawProfile, [field]: value },
        },
      });

      await assert.rejects(service.getProfile(), (error) => {
        assert.match(error.message, /profile response was incomplete/);
        assert.equal(error.message.includes(privateMarker), false);
        return true;
      });
    }
  });

  test('malformed successful collection rows reject before normalization', async () => {
    const personalRoute = '/users/seandinwiddie/repos?per_page=100&sort=pushed';
    const orgRoute = '/orgs/ForbocAI/repos?type=public&per_page=100&sort=pushed';
    const malformedRepo = { ...personalRepo };
    delete malformedRepo.pushed_at;
    const { service } = createFixtureService({
      routes: {
        [personalRoute]: [malformedRepo],
        [orgRoute]: [malformedRepo],
        '/users/seandinwiddie/events/public?per_page=100': [{}],
        [COMMIT_ROUTE]: {
          items: [{ repository: { private: false } }],
        },
      },
    });

    await assert.rejects(service.getRepos(), /GitHub repository sources unavailable/);
    await assert.rejects(service.getActivity(), /GitHub activity response was incomplete/);
    await assert.rejects(service.getCommits(), /GitHub commit search response was incomplete/);
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

  test('top-level cached provenance includes every summary resource', async () => {
    const { service } = createFixtureService();
    await Promise.all([
      service.getProfile(),
      service.getRepos(),
      service.getActivity(),
    ]);

    const mixed = await service.getSummary();

    assert.equal(mixed.availability.resources.profile.cached, true);
    assert.equal(mixed.availability.resources.repos.cached, true);
    assert.equal(mixed.availability.resources.activity.cached, true);
    assert.equal(mixed.availability.resources.contributions.cached, false);
    assert.equal(mixed.availability.resources.commits.cached, false);
    assert.equal(mixed.cached, false);
    assert.equal(mixed.cached, mixed.availability.cached);
  });

  test('failed refresh backs off consecutive resource reads', async () => {
    let clock = 0;
    let available = true;
    const { calls, service } = createFixtureService({
      now: () => clock,
      cacheTtlMs: 100,
      routes: {
        '/users/seandinwiddie': () => {
          if (!available) throw new Error('private GitHub outage detail');
          return rawProfile;
        },
      },
    });

    await service.getProfile();
    clock = 101;
    available = false;
    const failedRefresh = await service.getProfile();
    const callCount = calls.length;
    const cooldownRead = await service.getProfile();

    assert.equal(calls.length, callCount);
    assert.equal(failedRefresh.stale, true);
    assert.equal(cooldownRead.stale, true);
    assert.equal(cooldownRead.availability.errorCode, 'UPSTREAM_ERROR');

    clock = 202;
    await service.getProfile();
    assert.equal(calls.length, callCount + 1);
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
    const orgRoute = '/orgs/ForbocAI/repos?type=public&per_page=100&sort=pushed';
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
        '/orgs/ForbocAI/repos?type=public&per_page=100&sort=pushed': unavailable,
      },
    });

    await assert.rejects(service.getRepos(), /repository sources unavailable/);
  });

  test('stale partial data remains partial instead of being reported as healthy stale data', async () => {
    let clock = 0;
    let personalAvailable = true;
    const personalRoute = '/users/seandinwiddie/repos?per_page=100&sort=pushed';
    const orgRoute = '/orgs/ForbocAI/repos?type=public&per_page=100&sort=pushed';
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
    const orgRoute = '/orgs/ForbocAI/repos?type=public&per_page=100&sort=pushed';
    const { calls, service } = createFixtureService({
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
    const callCount = calls.length;
    const cooldownRead = await service.getRepos();

    assert.equal(refreshed.repos.length, 2);
    assert.equal(refreshed.stale, true);
    assert.equal(refreshed.availability.state, 'stale');
    assert.equal(refreshed.availability.errorCode, 'PARTIAL_UPSTREAM');
    assert.deepEqual(refreshed.availability.degradedSources, [orgRoute]);
    assert.equal(calls.length, callCount);
    assert.equal(cooldownRead.stale, true);
    assert.equal(cooldownRead.availability.errorCode, 'PARTIAL_UPSTREAM');
  });

  test('weaker partial refresh never replaces a stronger partial repo value', async () => {
    let clock = 0;
    let secondOrganizationAvailable = true;
    const oneRoute = '/orgs/One/repos?type=public&per_page=100&sort=pushed';
    const twoRoute = '/orgs/Two/repos?type=public&per_page=100&sort=pushed';
    const oneRepo = rawRepo({
      id: 31,
      owner: 'One',
      name: 'retained-public-system',
      language: 'TypeScript',
      pushedAt: '2026-08-30T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const unavailable = () => {
      throw new Error('private upstream detail');
    };
    const { service } = createFixtureService({
      now: () => clock,
      cacheTtlMs: 100,
      orgs: ['One', 'Two'],
      routes: {
        [oneRoute]: () =>
          secondOrganizationAvailable ? [oneRepo] : unavailable(),
        [twoRoute]: unavailable,
      },
    });

    const strongerPartial = await service.getRepos();
    clock = 101;
    secondOrganizationAvailable = false;
    const retained = await service.getRepos();

    assert.equal(strongerPartial.availability.state, 'partial');
    assert.equal(
      strongerPartial.repos.some(({ name }) => name === 'retained-public-system'),
      true
    );
    assert.equal(retained.availability.state, 'partial');
    assert.equal(retained.stale, true);
    assert.equal(
      retained.repos.some(({ name }) => name === 'retained-public-system'),
      true
    );
    assert.deepEqual(retained.availability.degradedSources.sort(), [oneRoute, twoRoute]);
  });

  test('commit failure degrades only the commit resource in the summary', async () => {
    const { service } = createFixtureService({
      routes: { [COMMIT_ROUTE]: jsonResponse({ error: 'down' }, 503) },
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
      '<h2 id="js-contribution-activity-description">4 contributions in the last year</h2>',
      '<td data-date="2026-08-30" data-level="2"></td>',
      '<td data-date="2026-08-29" data-level="1"></td>',
      '<tool-tip>3 contributions on August 30</tool-tip>',
      '<tool-tip>1 contribution on August 29</tool-tip>',
    ].join('\n');
    const parsed = parseCalendarHtml(html);

    assert.deepEqual(parsed.days.map((day) => day.date), ['2026-08-29', '2026-08-30']);
    assert.equal(parsed.total, 4);
    assert.equal(
      parseCalendarHtml(
        [
          '<td data-date="2026-08-30" data-level="1"></td>',
          '<td data-date="2026-08-29" data-level="1"></td>',
          '<tool-tip>7 contributions on August 30</tool-tip>',
          '<tool-tip>5 contributions on August 29</tool-tip>',
        ].join('\n')
      ).total,
      12
    );
    assert.equal(parseCalendarHtml('<html>no calendar</html>'), null);
  });

  test('public calendar transport stays unauthenticated and retains only bounded days', async () => {
    const dates = Array.from({ length: MAX_CONTRIBUTION_DAYS + 2 }, (_, index) =>
      new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10)
    );
    const html = [
      `${dates.length} contributions`,
      ...dates.toReversed().map(
        (date) => `<td data-date="${date}" data-level="1"></td>`
      ),
      ...dates.map((date) => `<tool-tip>1 contribution on ${date}</tool-tip>`),
    ].join('\n');
    const htmlCalendar = parseCalendarHtml(html);
    const calls = [];
    const publicCalendar = await createContributionLoader({
      // A caller-provided token must not change the public-viewer boundary.
      token: 'test-token',
      logger: quietLogger,
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init.headers });
        return jsonResponse(html);
      },
    })();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://github.com/users/seandinwiddie/contributions');
    assert.equal(Object.hasOwn(calls[0].headers, 'Authorization'), false);
    for (const bounded of [htmlCalendar, publicCalendar]) {
      assert.equal(bounded.days.length, MAX_CONTRIBUTION_DAYS);
      assert.equal(bounded.days[0].date, dates[2]);
      assert.equal(bounded.days.at(-1).date, dates.at(-1));
      assert.equal(bounded.source, 'html');
    }
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
