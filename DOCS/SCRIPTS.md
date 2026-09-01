# api.sdin.dev Scripts and Command Reference

**Canonical service command authority**

This document owns local setup, runtime, tests, configuration, maintenance, and
release-command information for `api.sdin.dev`. The root README is strictly an
API-client guide. [ENG.md](./ENG.md) defines service invariants without
duplicating invocation details.

Run commands from the `api.sdin.dev` repository root unless a section says
otherwise. `package.json` is the package-script source of truth; keep this file
in the same change whenever a script, environment variable, or operational
contract changes.

## Prerequisites and install

The service declares Node.js 20 or newer and uses `package-lock.json` for
reproducible npm installs.

```bash
npm ci
```

Success means npm exits zero without changing `package-lock.json`. Use
`npm install` only when intentionally changing dependencies or refreshing the
lockfile, then review both manifest and lockfile changes.

## Environment

| Variable | Default | Ownership and behavior |
| :---- | :---- | :---- |
| `PORT` | `3000` | Listen port when `src/api.js` starts the local process directly. |
| `GITHUB_USER` | `seandinwiddie` | GitHub account used for profile, personal repositories, activity, commits, and contributions. |
| `GITHUB_ORGS` | `ForbocAI` | Comma-separated organizations whose public non-fork, non-archived repositories are included. Whitespace, duplicates, and empty entries are removed; at most six organizations are queried. |
| `GITHUB_TOKEN` | unset | Optional server-side GitHub token for REST quota. It never enters the public contribution-calendar request. Treat it as a secret and never print or commit it. |
| `GITHUB_CACHE_TTL_MS` | `600000` | Positive in-process resource-cache lifetime in milliseconds; invalid/non-positive input falls back to the default. |
| `GITHUB_REQUEST_TIMEOUT_MS` | `5000` | Positive timeout in milliseconds applied to every GitHub REST and HTML contribution request; invalid/non-positive input falls back to the default. |
| `PRESENCE_CACHE_TTL_MS` | `300000` | Positive lifetime for one bounded public-presence snapshot. |
| `PRESENCE_REQUEST_TIMEOUT_MS` | `4000` | Positive timeout for each authored-channel `HEAD` probe. |
| `OBSERVATORY_CACHE_TTL_MS` | `60000` | Positive lifetime for the strongest retained aggregate Google snapshot. |
| `OBSERVATORY_REQUEST_TIMEOUT_MS` | `2500` | Positive per-stage timeout for OAuth, Analytics, and Search Console requests; sequential OAuth/report stages remain below the client's eight-second budget. |
| `GOOGLE_OAUTH_CLIENT_ID` | unset | Secret-side OAuth client identifier; all three OAuth values are required before Google effects run. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | unset | Secret OAuth client credential. Never print, commit, expose, or place in an Expo public variable. |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | unset | Secret refresh credential used only to mint short-lived server-side access tokens. |
| `GA4_SDIN_DEV_PROPERTY_ID` | unset | Numeric Analytics property identifier for the fixed `sdin.dev` aggregate channel; never returned publicly. |
| `GA4_SEANDINWIDDIE_COM_PROPERTY_ID` | unset | Numeric Analytics property identifier for the fixed `seandinwiddie.com` aggregate channel; never returned publicly. |
| `GSC_SDIN_DEV_SITE_URL` | unset | Search Console property URL or `sc-domain:` key for `sdin.dev`; never returned publicly. |
| `GSC_SEANDINWIDDIE_COM_SITE_URL` | unset | Search Console property URL or `sc-domain:` key for `seandinwiddie.com`; never returned publicly. |
| `API_CLIENT_IP_SOURCE` | `socket` (`vercel` in `vercel.json`) | Client key source for rate limiting. Only the exact value `vercel` enables one valid `x-vercel-forwarded-for` IP; missing, malformed, or comma-separated values fall back to the socket. Generic `X-Forwarded-For` is never trusted. |
| `API_CORS_ORIGINS` | unset | Comma-separated additional canonical HTTP(S) origins. Invalid origins are dropped; the required portfolio origins are always included. |
| `API_CORS_PUBLIC_READ` | `true` | When true, valid browser origins receive wildcard public-read CORS. `true`/`1`/`yes` and `false`/`0`/`no` are accepted case-insensitively; invalid text uses the default. |
| `API_MAX_REQUEST_BYTES` | `16384` | Positive maximum declared request size. Larger content lengths and transfer-encoded bodies are rejected before routes. |
| `API_RATE_LIMIT_MAX` | `120` | Positive requests allowed per client within one process-local sliding window. |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` | Positive process-local sliding-window duration in milliseconds. |
| `API_RATE_LIMIT_MAX_CLIENTS` | `10000` | Positive bound on process-local client histories; the oldest client entry is evicted before inserting beyond the bound. |

Example local overrides:

```bash
PORT=3001 GITHUB_USER=seandinwiddie GITHUB_ORGS=ForbocAI npm run dev
```

Keep `GITHUB_TOKEN` in the runtime platform's secret store. Do not place it in
authored JSON, committed environment files, test fixtures, logs, or docs.
Apply the same rule to every Google OAuth value. Property identifiers remain
server configuration and must not enter public responses or client bundles.
Verify configuration by response state, never by printing environment values.

`vercel.json` explicitly sets `API_CLIENT_IP_SOURCE=vercel`; production
verification must confirm the platform supplies a single
`x-vercel-forwarded-for` IP. Other environments remain on `socket` unless a
separately reviewed trusted-edge mode is implemented; never substitute generic
`X-Forwarded-For` parsing.

### HTTP security constants

`src/components/securityPolicy.js` fixes the non-environmental policy surface:

* Helmet `^8.3.0` owns the hardened response-header middleware, and Express's
  `X-Powered-By` header is disabled;
* allowed methods: `GET`, `HEAD`, and `OPTIONS`;
* required origins: `https://portfolio.sdin.dev` and `https://sdin.dev`;
* local origins: HTTP(S) on `localhost`, `127.0.0.1`, and `[::1]`;
* accepted CORS request headers: `Accept`, `Content-Type`, and `If-None-Match`;
* exposed response headers: `Cache-Control`, `ETag`, `RateLimit-Policy`,
  `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After`;
* preflight cache age: 86,400 seconds;
* no credentialed CORS; and
* a restrictive content security policy plus cross-origin resource permission
  for this public JSON resource service.

With public read enabled, valid HTTP(S) browser origins receive wildcard CORS.
With it disabled, only required, configured, and local development origins are
reflected. Requests without an `Origin` header remain valid native/server
clients. Malformed or denied browser origins receive no allow-origin header.
Every response includes `Vary: Origin`.

Ordinary responses use `Cache-Control: private, no-cache, max-age=0,
must-revalidate` and may use Express ETags for private conditional requests. No
ordinary route emits `s-maxage`. `/status` and every error or policy rejection
use `no-store`.

## Package scripts

| Command | Exact package expansion | Use and success expectation |
| :---- | :---- | :---- |
| `npm start` | `node src/api.js` | Starts one non-watching process. Success means authored JSON loads, the server binds the selected port, and startup reports its local URL. |
| `npm run dev` | `node --watch src/api.js` | Starts the same service with Node's watch mode for local iteration. Stop it manually when finished. |
| `npm test` | `node --test` | Runs all Node test files discovered by the built-in runner. Success is exit zero with no failed/cancelled tests. Counts may grow and must not be hard-coded as the pass criterion. |
| `npm run check:syntax` | `find src test -type f -name '*.js' -print0 \| xargs -0 -n1 node --check` | Parses every production and test JavaScript file without executing it. |
| `npm run verify` | `bash scripts/verify-all.sh` | Runs tests, complete source/test syntax, and whitespace validation without stopping after the first failed gate. |

The suite uses injected fetch, clock, timeout-signal, contribution, and GitHub
service effects. It must remain deterministic and must not spend GitHub quota or
depend on the public network.

## Focused validation

Use focused commands while diagnosing; run the full suite again afterward:

```bash
node --test test/api.test.js
node --test test/github.test.js
node --test test/security.test.js
node --test test/observatory.test.js
node --test test/presence.test.js
node --test test/http.test.js
node --check src/api.js
node --check src/contributions.js
node --check src/github.js
node --check src/http.js
node --check src/security.js
node --check src/components/observatoryPolicy.js
node --check src/components/securityPolicy.js
node --check src/entities/observatoryStore.js
node --check src/entities/presenceStore.js
node --check src/entities/rateLimitStore.js
node --check src/systems/observatory.js
node --check src/systems/presence.js
find src test -type f -name '*.js' -print0 | xargs -0 -n1 node --check
git diff --check
```

Each command must exit zero. Syntax checks do not replace behavior tests, and an
earlier green run does not validate later edits.

## Configuration ownership

| File | Authority |
| :---- | :---- |
| `package.json` | Runtime entrypoint, package scripts, Node engine, and dependency intent. |
| `package-lock.json` | Exact transitive dependency resolution for npm/CI. |
| `vercel.json` | Vercel function build mapping, catch-all route, production mode, and explicit trusted Vercel client-IP source selection. |
| `src/data/initialState.json` | Canonical authored portfolio document and ambient ECS world served by `/data` and key routes. |
| `src/components/observatoryPolicy.js` | Fixed Google endpoints, aggregate metrics, channel identities, and configuration names. |
| `src/components/securityPolicy.js` | Inert allowed-method/origin/header lists, Helmet policy, and security defaults. |

Change a value at its owner rather than adding a second environment/config
source. Any new environment variable must document its default, validation,
secret classification, runtime consumer, and test coverage here.

## Source and test ownership

| Path | Responsibility |
| :---- | :---- |
| `src/api.js` | Application composition, route/cache policy, JSON errors, and direct-process startup boundary. |
| `src/github.js` | Normalization, GitHub resource composition, single-flight cache, stale retry cooldown, stale/partial behavior, and all-resource availability projection. |
| `src/contributions.js` | Unauthenticated public-HTML contribution loading, privacy boundary, and bounded calendar normalization. |
| `src/http.js` | One bounded upstream-fetch effect and positive-duration normalization. |
| `src/components/observatoryPolicy.js` | Frozen Google observatory policy and fixed public-channel configuration. |
| `src/components/securityPolicy.js` | Serializable/frozen security policy components and defaults. |
| `src/entities/observatoryStore.js` | Strongest aggregate snapshot, single-flight refresh, explicit stale provenance, and retry cooldown. |
| `src/entities/presenceStore.js` | Public-presence snapshot, single-flight refresh, stale provenance, and retry cooldown. |
| `src/entities/rateLimitStore.js` | Factory-scoped RTK request-history entity with normalized clients, event-style observations, bounded LRU ordering, and admission/remaining/reset selectors; callers consume decisions rather than owning store state. |
| `src/security.js` | Pure policy decisions and client-IP parsing plus Helmet → Vary → CORS → rate (OPTIONS exempt) → size/framing → method → OPTIONS middleware composition. |
| `src/systems/observatory.js` | OAuth/Google effects, pure aggregate projection, reporting windows, privacy boundary, and availability composition. |
| `src/systems/presence.js` | Authored-target probes, bounded parallel composition, and state projection. |
| `test/api.test.js` | Real ephemeral HTTP-server route, cache-header, authored-contract, readiness, CORS, and error tests. |
| `test/github.test.js` | Pure/injected GitHub normalization, contract, cache, single-flight, stale cooldown, all-resource provenance, timeout, partial, commit, and contribution tests. |
| `test/security.test.js` | Pure policy plus ephemeral HTTP tests for headers, universal Vary, origin parsing, socket/Vercel client keys, public/restricted CORS, preflight, middleware precedence, methods, request bounds, rate reset/isolation/LRU, injected-store failure, private cache policy, and GET/HEAD behavior. |
| `test/observatory.test.js` | Aggregate period/trend normalization, privacy exclusions, configuration, availability, single-flight, strongest-stale preservation, and rejected/weaker cooldowns. |
| `test/presence.test.js` | Authored-only probing, redirect refusal, classification, cache provenance, stale cooldown, failure reduction, and seven-target bound. |
| `test/http.test.js` | Signed-32-bit timeout validation and bounded-fetch behavior. |

The service is aligned with the larger `Forboc.AI/api` ownership model at a
smaller scale: serializable contracts stay inert, resource entities own their
state, and systems compose effects at explicit boundaries. When a module grows,
split it along that ownership line rather than creating generic utility or
handler buckets.

## Maintenance commands

Read-only dependency inspection:

```bash
npm outdated
npm audit
npm audit --omit=dev
```

Intentional dependency update:

```bash
npm update
npm test
git diff --check
```

`npm update` writes dependency resolution. Review `package.json` and
`package-lock.json`, rerun every syntax/behavior/security gate, and recheck the
deployed response contract. Do not use `npm audit fix --force` as an unattended
shortcut; major dependency changes require deliberate compatibility review.

## Release and deployment

There is no deploy package script. `vercel.json` maps all paths to the server
entrypoint for the hosting platform, but source push, platform deployment, and
production verification remain separate actions. Never describe a successful
local test run as a deployment.

Final local sequence:

```bash
npm ci
npm run verify
```

After a candidate is deployed, verify the real service rather than a search or
deployment dashboard:

```bash
curl -fsS https://api.sdin.dev/status
curl -fsS https://api.sdin.dev/data
curl -fsS https://api.sdin.dev/github
curl -fsS https://api.sdin.dev/observatory
curl -fsS https://api.sdin.dev/presence
curl -sS -D - https://api.sdin.dev/definitely-not-a-route -o /dev/null
```

Confirm JSON shape, status/cache headers, freshness/availability semantics, and
unknown-route status. Do not print authorization headers or server environment
values while collecting evidence.

## Updating this reference

Every new route or response state needs client documentation in `README.md`, an
engineering invariant in `ENG.md`, deterministic tests, and any relevant
command/config update here. Every operational option needs one authority and a
safe default. Keep security-sensitive values redacted from examples and output.
