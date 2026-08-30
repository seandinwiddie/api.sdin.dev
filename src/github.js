/**
 * GitHub aggregation.
 *
 * This is the layer that justifies the API existing at all: it holds the token,
 * absorbs GitHub's rate limit (60 requests/hour unauthenticated) behind a cache,
 * and trims ~100 fields per repo down to the handful the portfolio renders.
 * Callers never talk to GitHub directly.
 */

const GITHUB_API = 'https://api.github.com';
const USER = process.env.GITHUB_USER || 'seandinwiddie';
/** Organisations whose public repos count as this person's work. */
const ORGS = (process.env.GITHUB_ORGS || 'ForbocAI').split(',').map((o) => o.trim()).filter(Boolean);
const TOKEN = process.env.GITHUB_TOKEN;
const CACHE_TTL_MS = Number(process.env.GITHUB_CACHE_TTL_MS || 10 * 60 * 1000);
const { loadContributions } = require('./contributions');

/** Cold-start-local memo. The CDN is the real cache; this spares repeat calls in one instance. */
const cache = new Map();

const authHeaders = () => (TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {});

const requestHeaders = () => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  // GitHub rejects requests without a User-Agent.
  'User-Agent': 'api.sdin.dev',
  ...authHeaders(),
});

const fetchJson = async (path) => {
  const response = await fetch(`${GITHUB_API}${path}`, { headers: requestHeaders() });

  if (!response.ok) {
    throw new Error(`GitHub ${path} responded ${response.status} ${response.statusText}`);
  }

  return response.json();
};

const isFresh = (entry) => Boolean(entry) && entry.expires > Date.now();

/**
 * Serves fresh cache, else fetches. If the fetch fails but a stale entry exists,
 * the stale value is served rather than failing the request -- GitHub being down
 * should degrade the portfolio, not break it.
 */
const withCache = async (key, produce) => {
  const entry = cache.get(key);

  if (isFresh(entry)) {
    return { ...entry.value, cached: true };
  }

  try {
    const value = await produce();
    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return { ...value, cached: false };
  } catch (error) {
    if (entry) {
      console.warn(`GitHub fetch failed for ${key}; serving stale cache:`, error.message);
      return { ...entry.value, cached: true, stale: true };
    }
    throw error;
  }
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

const normalizeRepo = (raw) => ({
  id: String(raw.id),
  name: raw.name,
  fullName: raw.full_name,
  owner: raw.owner ? raw.owner.login : USER,
  description: raw.description,
  language: raw.language,
  stars: raw.stargazers_count,
  forks: raw.forks_count,
  topics: raw.topics || [],
  htmlUrl: raw.html_url,
  homepage: raw.homepage,
  pushedAt: raw.pushed_at,
});

const isOwnWork = (raw) => !raw.fork && !raw.archived;

const byMostRecentlyPushed = (a, b) => b.pushedAt.localeCompare(a.pushedAt);

/** Language -> repo count, most used first. A fold, not a loop. */
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

const loadProfile = async () => ({ profile: normalizeProfile(await fetchJson(`/users/${USER}`)) });

/** One source of repos: the user account, or an organisation they work in. */
const repoSources = () => [
  `/users/${USER}/repos?per_page=100&sort=pushed`,
  ...ORGS.map((org) => `/orgs/${org}/repos?per_page=100&sort=pushed`),
];

const loadRepos = async () => {
  // An org being unreachable (renamed, made private) must not lose the rest.
  const responses = await Promise.all(
    repoSources().map((path) =>
      fetchJson(path).catch((error) => {
        console.warn(`Skipping ${path}:`, error.message);
        return [];
      })
    )
  );

  const byId = responses
    .flat()
    .filter(isOwnWork)
    .map(normalizeRepo)
    .reduce((acc, repo) => ({ ...acc, [repo.id]: repo }), {});

  const repos = Object.values(byId).sort(byMostRecentlyPushed);
  return { repos, languages: languageBreakdown(repos), owners: ownerBreakdown(repos) };
};

/** Owner -> repo count, so the UI can show org work separately from personal. */
const ownerBreakdown = (repos) =>
  Object.entries(
    repos.reduce((counts, repo) => ({ ...counts, [repo.owner]: (counts[repo.owner] || 0) + 1 }), {})
  )
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));

// GitHub's public events feed no longer carries per-push commit counts, so this
// reports pushes and issue activity -- what the feed actually proves -- rather
// than inventing a commit number.
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

const tally = (events, key) =>
  Object.entries(events.reduce((acc, e) => ({ ...acc, [e[key]]: (acc[e[key]] || 0) + 1 }), {}))
    .map(([name, count]) => ({ [key]: name, count }))
    .sort((a, b) => b.count - a.count);

const loadActivity = async () => {
  const raw = await fetchJson(`/users/${USER}/events/public?per_page=100`);
  const events = raw.map(normalizeEvent).filter((e) => e.kind !== null);

  return {
    events: events.slice(0, 40),
    byRepo: tally(events, 'repo'),
    byKind: tally(events, 'kind'),
    total: events.length,
    since: events.length ? events[events.length - 1].at : null,
    until: events.length ? events[0].at : null,
  };
};

const getActivity = () => withCache('activity', loadActivity);

// The calendar changes at most once a day, and the HTML path is the expensive
// one, so it gets a longer life than the REST aggregates.
const getContributions = () =>
  withCache('contributions', async () => ({ contributions: await loadContributions() }));

const getProfile = () => withCache('profile', loadProfile);
const getRepos = () => withCache('repos', loadRepos);

/** Profile, repos and language breakdown in one round trip. */
const getSummary = async () => {
  const [profile, repos, activity, contributions] = await Promise.all([
    getProfile(),
    getRepos(),
    getActivity(),
    getContributions(),
  ]);
  return {
    profile: profile.profile,
    repos: repos.repos,
    languages: repos.languages,
    owners: repos.owners,
    activity,
    // null when the calendar could not be obtained; the UI omits it.
    contributions: contributions.contributions,
    cached: profile.cached && repos.cached && activity.cached,
    authenticated: Boolean(TOKEN),
  };
};

module.exports = { getProfile, getRepos, getActivity, getContributions, getSummary, cacheTtlMs: CACHE_TTL_MS };
