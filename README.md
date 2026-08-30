# api.sdin.dev

Express.js API serving portfolio content for [portfolio.sdin.dev](https://portfolio.sdin.dev).

## Description

Content lives in a single JSON file and is exposed through a small, stable set of
endpoints, so portfolio copy can be updated without touching API code.

## Endpoints

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/` | `{ "message": "Welcome to the API" }` |
| GET | `/status` | `{ "status": "OK" }` |
| GET | `/data` | The complete initial state |
| GET | `/<key>` | `{ "<key>": ... }` for each top-level key in the initial state |
| GET | `/github` | Live profile, repos and language breakdown in one payload |
| GET | `/github/profile` | Live GitHub profile |
| GET | `/github/repos` | Live repos across the user and their orgs, plus language and owner counts |
| GET | `/github/activity` | Recent public activity (pushes, issues, comments) tallied by repo and kind |
| GET | `/github/contributions` | Contribution calendar: 365 days of counts and levels, plus the year total |

Current dynamic endpoints: `/bddTests`, `/brandName`, `/description`, `/iniTheme`,
`/portfolioFeatures`, `/appProcedures`, `/themeToggle`, `/nav`, `/brandNameLoading`,
`/themeCustom`.

Unknown paths return **JSON** `404` with an `availableEndpoints` list -- not an HTML
error page, so clients can parse every response the same way.

## Live GitHub data

`/github*` aggregates the GitHub REST API. This is the layer that justifies the
API existing rather than the portfolio bundling a JSON file: it holds the token,
absorbs GitHub's rate limit (60 requests/hour unauthenticated) behind a cache,
trims ~100 fields per repo to the handful the UI renders, and serves a stale
cache if GitHub is unreachable so the portfolio degrades instead of breaking.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_USER` | `seandinwiddie` | Account to aggregate |
| `GITHUB_ORGS` | `ForbocAI` | Comma-separated orgs whose public repos count as this person's work |
| `GITHUB_TOKEN` | _(none)_ | Optional. Raises the rate limit from 60/hr to 5000/hr |
| `GITHUB_CACHE_TTL_MS` | `600000` | In-process cache lifetime |

An upstream GitHub failure returns **502** with a `detail` field, distinguishing
a dependency outage from a fault in this service. If one organisation is
unreachable the rest of the aggregate still resolves.

**On the contribution calendar:** GitHub exposes it through GraphQL (which needs a
token) but not through REST. With `GITHUB_TOKEN` set the GraphQL API is used;
without one the public HTML fragment at `/users/:login/contributions` is parsed.
That HTML is markup, not a contract, so every parse failure resolves to `null`
and the UI omits the calendar rather than breaking.

**On commit counts:** GitHub's public events feed no longer carries per-push
commit counts, so `/github/activity` reports pushes, issues and comments — what
the feed actually proves — rather than inventing a commit number. Only public
activity is visible; private repositories never appear.

## Project Structure

- `src/github.js`: GitHub aggregation, normalization and caching.
- `src/api.js`: the Express app. Exports the app and only calls `listen()` when run
  directly, so it works both as a local server and as a Vercel function.
- `src/data/initialState.json`: all served content.
- `test/api.test.js`: endpoint tests using the built-in `node:test` runner.

## Running

```bash
npm install
npm start   # http://localhost:3000
npm run dev # same, with --watch
npm test    # node:test, no test framework dependency
```

`PORT` overrides the listen port.

## Caching

Responses set `Cache-Control: public, max-age=0, s-maxage=300,
stale-while-revalidate=86400`. The payload is static per deployment, so the CDN
serves it and the function is invoked rarely.

## Deployment

Deployed on Vercel via `vercel.json`, which routes all paths to `src/api.js`.
