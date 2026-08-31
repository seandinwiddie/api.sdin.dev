/**
 * GitHub aggregation.
 *
 * Effects are supplied once at the boundary. The transformation core stays
 * pure, cache state stays private to the returned service, and every value
 * crossing the HTTP boundary is plain serializable data.
 */

const { createContributionLoader } = require('./contributions');
const { createBoundedFetch, positiveMilliseconds } = require('./http');
const {
  _,
  fold,
  multiMatch,
  orElse,
} = require('functional-programming-composition');

const GITHUB_API = 'https://api.github.com';
const MAX_GITHUB_ORGS = 6;
const MAX_PUBLIC_REPOSITORIES = 70;
const DEFAULT_USER = process.env.GITHUB_USER || 'seandinwiddie';
const normalizeOrganizations = (orgs) =>
  [...new Set((orgs ?? []).map((org) => String(org).trim()).filter(Boolean))]
    .slice(0, MAX_GITHUB_ORGS);
const DEFAULT_ORGS = normalizeOrganizations(
  (process.env.GITHUB_ORGS || 'ForbocAI').split(',')
);
const DEFAULT_TOKEN = process.env.GITHUB_TOKEN;
const DEFAULT_CACHE_TTL_MS = positiveMilliseconds(process.env.GITHUB_CACHE_TTL_MS, 10 * 60 * 1000);
const DEFAULT_REQUEST_TIMEOUT_MS = positiveMilliseconds(process.env.GITHUB_REQUEST_TIMEOUT_MS);

const publicCommitSearchPath = (user) => {
  const query = new URLSearchParams({
    q: `author:${user} is:public`,
    sort: 'author-date',
    order: 'desc',
    per_page: '50',
  });
  return `/search/commits?${query.toString()}`;
};

const isPublicCommitItem = (item) =>
  item?.repository?.private === false;

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

const requirePayload = (predicate, resource) => (value) => {
  if (!predicate(value)) {
    throw new Error(`GitHub ${resource} response was incomplete`);
  }
  return value;
};

const isNullableString = (value) => value === null || typeof value === 'string';

const isProfilePayload = (value) =>
  typeof value?.login === 'string' &&
  value.login.length > 0 &&
  isNullableString(value.name) &&
  isNullableString(value.bio) &&
  isNullableString(value.location) &&
  isNullableString(value.blog) &&
  typeof value.avatar_url === 'string' &&
  typeof value.html_url === 'string' &&
  Number.isInteger(value.public_repos) &&
  value.public_repos >= 0 &&
  Number.isInteger(value.followers) &&
  value.followers >= 0;

const isRepositoryItem = (value) =>
  (value?.private !== false || value.visibility !== 'public') ||
  (
    (typeof value.id === 'number' || typeof value.id === 'string') &&
    typeof value.name === 'string' &&
    typeof value.full_name === 'string' &&
    typeof value.owner?.login === 'string' &&
    isNullableString(value.description) &&
    isNullableString(value.language) &&
    Number.isInteger(value.stargazers_count) &&
    Number.isInteger(value.forks_count) &&
    Array.isArray(value.topics) &&
    typeof value.created_at === 'string' &&
    typeof value.html_url === 'string' &&
    isNullableString(value.homepage) &&
    Object.hasOwn(value, 'pushed_at') &&
    isNullableString(value.pushed_at) &&
    typeof value.fork === 'boolean' &&
    typeof value.archived === 'boolean'
  );

const isActivityItem = (value) =>
  typeof value?.id === 'string' &&
  typeof value.type === 'string' &&
  typeof value.repo?.name === 'string' &&
  typeof value.created_at === 'string';

const isCommitItem = (value) =>
  typeof value?.sha === 'string' &&
  typeof value.repository?.full_name === 'string' &&
  typeof value.repository.private === 'boolean' &&
  typeof value.commit?.message === 'string' &&
  typeof value.commit?.author?.date === 'string' &&
  typeof value.html_url === 'string';

const requireProfilePayload = requirePayload(isProfilePayload, 'profile');
const requireRepositoriesPayload = requirePayload(
  (value) => Array.isArray(value) && value.every(isRepositoryItem),
  'repositories'
);
const requireActivityPayload = requirePayload(
  (value) => Array.isArray(value) && value.every(isActivityItem),
  'activity'
);
const requireCommitSearchPayload = requirePayload(
  (value) => Array.isArray(value?.items) && value.items.every(isCommitItem),
  'commit search'
);

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
      staleContext: null,
    };
  };

  const deferEntry = (key, entry, context) => {
    const deferred = {
      ...entry,
      expires: now() + ttlMs,
      staleContext: context,
    };
    entries.set(key, deferred);
    return decorateEntry(deferred, context);
  };

  const produce = async (key, load) => {
    const previous = entries.get(key);

    try {
      const candidate = entryFrom(await load());

      const candidateIsWeaker =
        candidate.partial &&
        previous &&
        candidate.degradedSources.length > previous.degradedSources.length;

      if (candidateIsWeaker) {
        logger.warn(`GitHub fetch for ${key} lost source coverage; serving stronger stale cache`);
        return deferEntry(key, previous, {
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
        return deferEntry(key, previous, {
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
      return decorateEntry(entry, entry.staleContext ?? { mode: 'cached' });
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
  pushedAt: raw.pushed_at ?? raw.created_at,
});

const isExplicitlyPublicRepository = (raw) =>
  raw?.private === false && raw.visibility === 'public';

const isOwnWork = (raw) =>
  isExplicitlyPublicRepository(raw) && !raw.fork && !raw.archived;
const byMostRecentlyPushed = (a, b) => b.pushedAt.localeCompare(a.pushedAt);

const tally = (events, key) =>
  Object.entries(
    fold(events, {}, (counts, event) => ({
      ...counts,
      [event[key]]: (counts[event[key]] || 0) + 1,
    }))
  )
    .map(([name, count]) => ({ [key]: name, count }))
    .sort((a, b) => b.count - a.count);

const languageBreakdown = (repos) =>
  Object.entries(
    fold(
      repos,
      {},
      (counts, repo) =>
        repo.language ? { ...counts, [repo.language]: (counts[repo.language] || 0) + 1 } : counts,
    )
  )
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language));

const ownerBreakdown = (repos) =>
  Object.entries(
    fold(repos, {}, (counts, repo) => ({
      ...counts,
      [repo.owner]: (counts[repo.owner] || 0) + 1,
    }))
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
  return orElse(
    multiMatch(states, [
      [
        (values) =>
          values.some((state) => state === 'unavailable' || state === 'partial'),
        () => 'partial',
      ],
      [(values) => values.some((state) => state === 'stale'), () => 'stale'],
      [(values) => values.every((state) => state === 'cached'), () => 'cached'],
      [_, () => 'live'],
    ]),
    'live'
  );
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
  const configuredOrgs = normalizeOrganizations(orgs);
  const fetchJson = createGithubRequester({ fetchImpl, token, timeoutMs, makeTimeoutSignal });
  const { withCache } = createResourceCache({ now, ttlMs, logger });
  const loadContributionCalendar = loadContributionsImpl ?? createContributionLoader({
    fetchImpl,
    user,
    timeoutMs,
    makeTimeoutSignal,
    logger,
  });

  const repoSources = () => [
    `/users/${user}/repos?per_page=100&sort=pushed`,
    ...configuredOrgs.map(
      (org) => `/orgs/${org}/repos?type=public&per_page=100&sort=pushed`
    ),
  ];

  const loadProfile = async () => ({
    profile: normalizeProfile(
      requireProfilePayload(await fetchJson(`/users/${user}`))
    ),
  });

  const loadRepos = async () => {
    const sources = repoSources();
    const settled = await Promise.all(
      sources.map((path) =>
        fetchJson(path).then(requireRepositoriesPayload).then(
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
    const repos = Object.values(byId)
      .sort(byMostRecentlyPushed)
      .slice(0, MAX_PUBLIC_REPOSITORIES);

    return {
      repos,
      languages: languageBreakdown(repos),
      owners: ownerBreakdown(repos),
      since: fold(
        repos,
        null,
        (earliest, repo) => (!earliest || repo.createdAt < earliest ? repo.createdAt : earliest),
      ),
      degradedSources: failures.map((result) => result.path),
    };
  };

  const loadActivity = async () => {
    const raw = requireActivityPayload(
      await fetchJson(`/users/${user}/events/public?per_page=100`)
    );
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
    const raw = requireCommitSearchPayload(
      await fetchJson(publicCommitSearchPath(user))
    );
    const commits = raw.items
      .filter(isPublicCommitItem)
      .map(normalizeCommit);
    return {
      commits,
      total: commits.length,
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
      cached: allResourcesCached,
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
  MAX_GITHUB_ORGS,
  MAX_PUBLIC_REPOSITORIES,
  createGithubService,
  normalizeOrganizations,
};
