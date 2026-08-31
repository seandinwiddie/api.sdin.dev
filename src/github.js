/**
 * GitHub aggregation.
 *
 * Effects are supplied once at the boundary. The transformation core stays
 * pure, cache state stays private to the returned service, and every value
 * crossing the HTTP boundary is plain serializable data.
 */

const { createContributionLoader } = require('./contributions');
const { createBoundedFetch, positiveMilliseconds } = require('./http');

const GITHUB_API = 'https://api.github.com';
const DEFAULT_USER = process.env.GITHUB_USER || 'seandinwiddie';
const DEFAULT_ORGS = (process.env.GITHUB_ORGS || 'ForbocAI')
  .split(',')
  .map((org) => org.trim())
  .filter(Boolean);
const DEFAULT_TOKEN = process.env.GITHUB_TOKEN;
const DEFAULT_CACHE_TTL_MS = positiveMilliseconds(process.env.GITHUB_CACHE_TTL_MS, 10 * 60 * 1000);
const DEFAULT_REQUEST_TIMEOUT_MS = positiveMilliseconds(process.env.GITHUB_REQUEST_TIMEOUT_MS);

const isoAt = (milliseconds) => new Date(milliseconds).toISOString();

const requestHeaders = (token) => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'api.sdin.dev',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

const requestErrorMessage = (path, timeoutMs) => (error) => {
  const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
  return timedOut
    ? `GitHub ${path} timed out after ${timeoutMs}ms`
    : `GitHub ${path} request failed`;
};

const errorCodeOf = (error) =>
  /timed out/i.test(error?.message || '') ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR';

const createGithubRequester = ({ fetchImpl, token, timeoutMs, makeTimeoutSignal }) => {
  const boundedFetch = createBoundedFetch({ fetchImpl, timeoutMs, makeTimeoutSignal });

  return async (path) => {
    const response = await boundedFetch(`${GITHUB_API}${path}`, {
      headers: requestHeaders(token),
    }).catch((error) => {
      throw new Error(requestErrorMessage(path, timeoutMs)(error));
    });

    if (!response.ok) {
      throw new Error(`GitHub ${path} responded ${response.status} ${response.statusText}`);
    }

    return response.json().catch(() => {
      throw new Error(`GitHub ${path} returned invalid JSON`);
    });
  };
};

const degradedSourcesOf = (value) =>
  Array.isArray(value?.degradedSources) ? value.degradedSources : [];

const decorateEntry = (entry, context) => {
  const cached = context.mode !== 'live';
  const stale = context.mode === 'stale';
  const degradedSources = context.degradedSources ?? entry.degradedSources;
  const state = entry.partial ? 'partial' : stale ? 'stale' : context.mode;

  return {
    ...entry.value,
    cached,
    stale,
    availability: {
      state,
      cached,
      stale,
      partial: entry.partial,
      fetchedAt: isoAt(entry.fetchedAt),
      degradedSources,
      errorCode: context.errorCode ?? (entry.partial ? 'PARTIAL_UPSTREAM' : null),
    },
  };
};

/**
 * Per-instance TTL cache with stale-on-error and one producer per key. Partial
 * data may be cached as partial, but never replaces a complete stale value.
 */
const createResourceCache = ({ now, ttlMs, logger }) => {
  const entries = new Map();
  const inFlight = new Map();

  const isFresh = (entry) => Boolean(entry) && entry.expires > now();

  const entryFrom = (value) => {
    const fetchedAt = now();
    const degradedSources = degradedSourcesOf(value);
    return {
      value,
      fetchedAt,
      expires: fetchedAt + ttlMs,
      partial: degradedSources.length > 0,
      degradedSources,
    };
  };

  const produce = async (key, load) => {
    const previous = entries.get(key);

    try {
      const candidate = entryFrom(await load());

      if (candidate.partial && previous && !previous.partial) {
        logger.warn(`GitHub fetch for ${key} was partial; serving complete stale cache`);
        return decorateEntry(previous, {
          mode: 'stale',
          degradedSources: candidate.degradedSources,
          errorCode: 'PARTIAL_UPSTREAM',
        });
      }

      entries.set(key, candidate);
      return decorateEntry(candidate, { mode: 'live' });
    } catch (error) {
      if (previous) {
        logger.warn(`GitHub fetch failed for ${key}; serving stale cache:`, error.message);
        return decorateEntry(previous, {
          mode: 'stale',
          errorCode: errorCodeOf(error),
        });
      }

      throw error;
    }
  };

  const withCache = async (key, load) => {
    const entry = entries.get(key);

    if (isFresh(entry)) {
      return decorateEntry(entry, { mode: 'cached' });
    }

    const pending = inFlight.get(key);
    if (pending) {
      return pending;
    }

    const request = produce(key, load);
    inFlight.set(key, request);

    try {
      return await request;
    } finally {
      if (inFlight.get(key) === request) {
        inFlight.delete(key);
      }
    }
  };

  return { withCache };
};

const normalizeProfile = (raw) => ({
  login: raw.login,
  name: raw.name,
  bio: raw.bio,
  location: raw.location,
  blog: raw.blog,
  avatarUrl: raw.avatar_url,
  htmlUrl: raw.html_url,
  publicRepos: raw.public_repos,
  followers: raw.followers,
});

const normalizeRepo = (defaultOwner) => (raw) => ({
  id: String(raw.id),
  name: raw.name,
  fullName: raw.full_name,
  owner: raw.owner ? raw.owner.login : defaultOwner,
  description: raw.description,
  language: raw.language,
  stars: raw.stargazers_count,
  forks: raw.forks_count,
  topics: raw.topics || [],
  createdAt: raw.created_at,
  htmlUrl: raw.html_url,
  homepage: raw.homepage,
  pushedAt: raw.pushed_at,
});

const isOwnWork = (raw) => !raw.fork && !raw.archived;
const byMostRecentlyPushed = (a, b) => b.pushedAt.localeCompare(a.pushedAt);

const tally = (events, key) =>
  Object.entries(events.reduce((acc, event) => ({
    ...acc,
    [event[key]]: (acc[event[key]] || 0) + 1,
  }), {}))
    .map(([name, count]) => ({ [key]: name, count }))
    .sort((a, b) => b.count - a.count);

const languageBreakdown = (repos) =>
  Object.entries(
    repos.reduce(
      (counts, repo) =>
        repo.language ? { ...counts, [repo.language]: (counts[repo.language] || 0) + 1 } : counts,
      {}
    )
  )
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language));

const ownerBreakdown = (repos) =>
  Object.entries(
    repos.reduce((counts, repo) => ({
      ...counts,
      [repo.owner]: (counts[repo.owner] || 0) + 1,
    }), {})
  )
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));

const ACTIVITY_KINDS = {
  PushEvent: 'push',
  IssuesEvent: 'issue',
  IssueCommentEvent: 'comment',
  PullRequestEvent: 'pull request',
  CreateEvent: 'branch or tag',
  ReleaseEvent: 'release',
};

const normalizeEvent = (raw) => ({
  id: raw.id,
  kind: ACTIVITY_KINDS[raw.type] ?? null,
  repo: raw.repo.name,
  at: raw.created_at,
});

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/;

const parseSubject = (subject) => {
  const match = CONVENTIONAL.exec(subject);
  return match
    ? { type: match[1], scope: match[2] ?? null, summary: match[3] }
    : { type: null, scope: null, summary: subject };
};

const normalizeCommit = (raw) => {
  const subject = raw.commit.message.split('\n')[0];
  return {
    sha: raw.sha.slice(0, 7),
    repo: raw.repository.full_name,
    at: raw.commit.author.date,
    url: raw.html_url,
    ...parseSubject(subject),
    subject,
  };
};

const summaryStateOf = (resources) => {
  const states = Object.values(resources).map((resource) => resource.state);
  const rules = [
    { when: () => states.some((state) => state === 'unavailable' || state === 'partial'), value: 'partial' },
    { when: () => states.some((state) => state === 'stale'), value: 'stale' },
    { when: () => states.every((state) => state === 'cached'), value: 'cached' },
    { when: () => true, value: 'live' },
  ];
  return rules.find((rule) => rule.when()).value;
};

const unavailableCommits = (error, now) => ({
  commits: [],
  total: 0,
  byType: [],
  cached: false,
  stale: false,
  availability: {
    state: 'unavailable',
    cached: false,
    stale: false,
    partial: true,
    fetchedAt: isoAt(now()),
    degradedSources: ['commits'],
    errorCode: errorCodeOf(error),
  },
});

const createGithubService = ({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  user = DEFAULT_USER,
  orgs = DEFAULT_ORGS,
  token = DEFAULT_TOKEN,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  makeTimeoutSignal,
  loadContributionsImpl,
  logger = console,
} = {}) => {
  const ttlMs = positiveMilliseconds(cacheTtlMs, DEFAULT_CACHE_TTL_MS);
  const timeoutMs = positiveMilliseconds(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const fetchJson = createGithubRequester({ fetchImpl, token, timeoutMs, makeTimeoutSignal });
  const { withCache } = createResourceCache({ now, ttlMs, logger });
  const loadContributionCalendar = loadContributionsImpl ?? createContributionLoader({
    fetchImpl,
    user,
    token,
    timeoutMs,
    makeTimeoutSignal,
    logger,
  });

  const repoSources = () => [
    `/users/${user}/repos?per_page=100&sort=pushed`,
    ...orgs.map((org) => `/orgs/${org}/repos?per_page=100&sort=pushed`),
  ];

  const loadProfile = async () => ({
    profile: normalizeProfile(await fetchJson(`/users/${user}`)),
  });

  const loadRepos = async () => {
    const sources = repoSources();
    const settled = await Promise.all(
      sources.map((path) =>
        fetchJson(path).then(
          (data) => ({ tag: 'available', path, data }),
          (error) => ({ tag: 'unavailable', path, error })
        )
      )
    );
    const failures = settled.filter((result) => result.tag === 'unavailable');
    failures.forEach(({ path, error }) => logger.warn(`Skipping ${path}:`, error.message));

    if (failures.length === sources.length) {
      const timedOut = failures.some(({ error }) => errorCodeOf(error) === 'UPSTREAM_TIMEOUT');
      throw new Error(
        timedOut
          ? 'GitHub repository sources timed out'
          : 'GitHub repository sources unavailable'
      );
    }

    const byId = settled
      .filter((result) => result.tag === 'available')
      .flatMap((result) => result.data)
      .filter(isOwnWork)
      .map(normalizeRepo(user))
      .reduce((repos, repo) => ({ ...repos, [repo.id]: repo }), {});
    const repos = Object.values(byId).sort(byMostRecentlyPushed);

    return {
      repos,
      languages: languageBreakdown(repos),
      owners: ownerBreakdown(repos),
      since: repos.reduce(
        (earliest, repo) => (!earliest || repo.createdAt < earliest ? repo.createdAt : earliest),
        null
      ),
      degradedSources: failures.map((result) => result.path),
    };
  };

  const loadActivity = async () => {
    const raw = await fetchJson(`/users/${user}/events/public?per_page=100`);
    const events = raw.map(normalizeEvent).filter((event) => event.kind !== null);
    return {
      events: events.slice(0, 40),
      byRepo: tally(events, 'repo'),
      byKind: tally(events, 'kind'),
      total: events.length,
      since: events.length ? events[events.length - 1].at : null,
      until: events.length ? events[0].at : null,
    };
  };

  const loadCommits = async () => {
    const raw = await fetchJson(
      `/search/commits?q=author:${user}&sort=author-date&order=desc&per_page=50`
    );
    const commits = (raw.items || []).map(normalizeCommit);
    return {
      commits,
      total: raw.total_count ?? commits.length,
      byType: tally(commits.filter((commit) => commit.type), 'type'),
    };
  };

  const getProfile = () => withCache('profile', loadProfile);
  const getRepos = () => withCache('repos', loadRepos);
  const getActivity = () => withCache('activity', loadActivity);
  const getCommits = () => withCache('commits', loadCommits);
  const getContributions = () => withCache('contributions', async () => {
    const contributions = await loadContributionCalendar();
    return {
      contributions,
      degradedSources: contributions === null ? ['contributions'] : [],
    };
  });

  const getSummary = async () => {
    const [profile, repos, activity, contributions, commits] = await Promise.all([
      getProfile(),
      getRepos(),
      getActivity(),
      getContributions(),
      getCommits().catch((error) => {
        logger.warn('Commit search unavailable:', error.message);
        return unavailableCommits(error, now);
      }),
    ]);
    const resources = {
      profile: profile.availability,
      repos: repos.availability,
      activity: activity.availability,
      contributions: contributions.availability,
      commits: commits.availability,
    };
    const state = summaryStateOf(resources);
    const cached = profile.cached && repos.cached && activity.cached;
    const allResourcesCached = Object.values(resources).every((resource) => resource.cached);
    const stale = Object.values(resources).some((resource) => resource.stale);
    const partial = state === 'partial';

    return {
      profile: profile.profile,
      repos: repos.repos,
      languages: repos.languages,
      owners: repos.owners,
      since: repos.since,
      activity,
      contributions: contributions.contributions,
      commits,
      cached,
      stale,
      partial,
      availability: {
        state,
        cached: allResourcesCached,
        stale,
        partial,
        checkedAt: isoAt(now()),
        resources,
      },
      authenticated: Boolean(token),
    };
  };

  return {
    getProfile,
    getRepos,
    getActivity,
    getContributions,
    getCommits,
    getSummary,
    cacheTtlMs: ttlMs,
    requestTimeoutMs: timeoutMs,
  };
};

const defaultService = createGithubService();

module.exports = {
  ...defaultService,
  createGithubService,
};
