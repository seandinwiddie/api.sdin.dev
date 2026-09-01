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
| `API_ALLOWED_HOSTS` | unset | Comma-separated additional hostnames admitted by the request-authority perimeter. Values are host authorities, not URLs. |
| `API_ALLOW_VERCEL_PREVIEWS` | `true` | Allows syntactically valid subdomains of `vercel.app` as request authorities so reviewed preview deployments remain testable. |
| `API_CORS_ORIGINS` | unset | Comma-separated additional canonical HTTP(S) origins; the required portfolio origins are always included. |
| `API_CORS_PUBLIC_READ` | `true` | When true, every canonical HTTP(S) browser origin may read the intentionally public, non-credentialed API. `true`/`1`/`yes` and `false`/`0`/`no` are accepted case-insensitively. |
| `API_CORS_MAX_AGE_SECONDS` | `86400` | Positive preflight cache duration. |
| `API_MAX_REQUEST_BYTES` | `16384` | Positive maximum declared request size. Larger content lengths and transfer-encoded bodies are rejected before routes. |
| `API_MAX_REQUEST_TARGET_BYTES` | `2048` | Positive byte bound for the complete origin-form request target, including its query. |
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

Security variables are fail-closed configuration. Defaults apply when a value
is absent. A present but invalid client-IP source, boolean, positive integer,
origin, or host prevents application composition and reports only the variable
name; the configured value is never echoed.

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
* required authority: `api.sdin.dev`, plus local development hosts and reviewed
  Vercel preview authorities;
* required origins: `https://portfolio.sdin.dev` and `https://sdin.dev`;
* local origins: HTTP(S) on `localhost`, `127.0.0.1`, and `[::1]`;
* accepted CORS request headers: `Accept`, `Content-Type`, and `If-None-Match`;
* exposed response headers: `Cache-Control`, `ETag`, `RateLimit-Policy`,
  `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After`;
* exposed correlation header: `X-Request-ID`, generated by the service and
  never accepted from the caller;
* preflight cache age: 86,400 seconds;
* no credentialed CORS; and
* a restrictive content security policy, frame denial, one-year preload HSTS,
  no-referrer, cross-origin resource permission, and a `Permissions-Policy`
  that denies unused browser capabilities.

With public read enabled, valid HTTP(S) browser origins receive wildcard CORS.
With it disabled, only required, configured, and local development origins are
reflected. Requests without an `Origin` header remain valid native/server
clients. Malformed Origins and Origins denied by a restricted policy receive
JSON `403`. Every response includes `Vary: Origin`.

The separate request perimeter requires a recognized authority, bounded
origin-form target with a canonical ASCII route path and valid query encoding,
and JSON-compatible representation headers.
An invalid authority returns `421`, an invalid target `400`, an `Accept` value
that excludes JSON `406`, and a supplied non-JSON `Content-Type` `415`. Every
request, including OPTIONS, consumes rate capacity. A missing or malformed rate
decision is a security-state failure and returns generic JSON `503`.

Ordinary responses use `Cache-Control: private, no-cache, max-age=0,
must-revalidate` and may use Express ETags for private conditional requests. No
ordinary route emits `s-maxage`. `/status` and every error or policy rejection
use `no-store`. `CDN-Cache-Control` and `Vercel-CDN-Cache-Control` also deny
shared storage at the platform boundary.

### Security observatory and assessment policy

`src/data/securityPosturePolicy.json` owns the passive and assessment
capabilities that no public request or assessment record can widen.
`src/components/securityPosturePolicy.js` validates the complete schema and
least-capability invariants, then recursively freezes the document before any
system or checker can consume it:

* passive observations accept at most twelve authored public HTTPS sites, use
  one bodyless `HEAD` each, and never follow redirects;
* the authorized active target allowlist is exactly
  `https://portfolio.sdin.dev` and `https://api.sdin.dev`;
* active assessment is owner-CI/CLI-only, one target at a time, at most one run
  per target per day, at most two requests per second, and never authenticated;
* the minimum request delay is 500 ms, total duration is at most twelve minutes,
  and each reviewed active rule receives at most one minute;
* the baseline spider, passive wait, and active phase are bounded to one, two,
  and five minutes respectively, with at most five public aggregate alerts per
  rule; and
* raw findings are never public.

These JSON values are safety policy, not environment variables. Change them only
with focused policy, automation, sanitizer, and deployed-target review. A
public `GET /security-posture` may refresh the passive authored-site snapshot;
it must never start baseline, active, external-provider, or manual assessment
work. Owner automation publishes only a sanitized schema-versioned aggregate
record into the authored JSON contract. Keep raw scanner output in an
access-controlled private artifact or delete it; never copy it into `src/data`,
logs, deployment variables, or public CI artifacts.

## Package scripts

| Command | Exact package expansion | Use and success expectation |
| :---- | :---- | :---- |
| `npm start` | `node src/api.js` | Starts one non-watching process. Success means authored JSON loads, the server binds the selected port, and startup reports its local URL. |
| `npm run dev` | `node --watch src/api.js` | Starts the same service with Node's watch mode for local iteration. Stop it manually when finished. |
| `npm test` | `node --test` | Runs all Node test files discovered by the built-in runner. Success is exit zero with no failed/cancelled tests. Counts may grow and must not be hard-coded as the pass criterion. |
| `npm run check:data-authority` | `node scripts/check-data-authority.js` | Recursively scans API `src`, validates JSON placement and authored-copy isolation, then compares the JSON resource catalog with registered Express method/path pairs. |
| `npm run check:dependencies` | `npm audit --omit=dev --audit-level=low` | Consults the current npm advisory database and fails on any low-or-higher production dependency vulnerability. This is intentionally network-dependent. |
| `npm run check:portfolio-contract` | `node scripts/check-data-authority.js --portfolio-root ../portfolio` | Adds a read-only comparison between catalog entries marked for the portfolio and the sibling RTK Query API boundary. |
| `npm run check:security` | `node scripts/check-security.js` | Verifies the frozen least-capability policy and scans tracked plus non-ignored candidate files for sensitive file types and high-confidence credential signatures without printing matched values. |
| `npm run check:syntax` | `find src test scripts -type f -name '*.js' -print0 \| xargs -0 -n1 node --check` | Parses every production, test, and checker JavaScript file without executing it. |
| `npm run verify` | `bash scripts/verify-all.sh` | Runs tests, authored-data authority, security/secret policy, current production dependency review, complete JavaScript syntax, and whitespace validation without stopping after the first failed gate. |

The behavior suite uses injected fetch, clock, timeout-signal, contribution, and
GitHub service effects. It remains deterministic and does not spend GitHub
quota. The distinct production-dependency gate intentionally consults npm's
current advisory service and therefore requires network access.

## Focused validation

Use focused commands while diagnosing; run the full suite again afterward:

```bash
node --test test/api.test.js
node --test test/agentManifest.test.js
node --test test/dataAuthority.test.js
node --test test/estateObservatory.test.js
node --test test/github.test.js
node --test test/security.test.js
node --test test/securityChecker.test.js
node --test test/securityPosture.test.js
node --test test/observatory.test.js
node --test test/presence.test.js
node --test test/http.test.js
npm run check:data-authority
npm run check:security
npm run check:dependencies
npm run check:portfolio-contract
find src test scripts -type f -name '*.js' -print0 | xargs -0 -n1 node --check
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
| `src/data/securityAssessments.json` | Sanitized, schema-versioned aggregate DAST and pentest publication document; raw findings are forbidden. |
| `src/data/securityPosturePolicy.json` | Passive fetch capabilities, exact owned assessment allowlist, profiles/states, severity/trend vocabulary, safety caps, cooldown, and reviewed active-rule IDs. |
| `src/components/observatoryPolicy.js` | Fixed Google endpoints, aggregate metrics, channel identities, and configuration names. |
| `src/components/securityPolicy.js` | Inert allowed-method/origin/header lists, Helmet policy, and security defaults. |
| `src/components/securityPosturePolicy.js` | Pure schema/invariant validation plus recursive freeze and named projections of the JSON-authored posture policy. |

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
| `src/components/securityPosturePolicy.js` | Fail-closed validation, recursive freezing, and pure projections for `src/data/securityPosturePolicy.json`. |
| `src/entities/observatoryStore.js` | Strongest aggregate snapshot, single-flight refresh, explicit stale provenance, and retry cooldown. |
| `src/entities/presenceStore.js` | Public-presence snapshot, single-flight refresh, stale provenance, and retry cooldown. |
| `src/entities/rateLimitStore.js` | Factory-scoped RTK request-history entity with normalized clients, event-style observations, bounded LRU ordering, and admission/remaining/reset selectors; callers consume decisions rather than owning store state. |
| `src/entities/securityPostureStore.js` | RTK-normalized per-site security evidence, serializable snapshot state, single-flight effect ownership, and stale cooldown. |
| `src/security.js` | Applicative fail-closed configuration, pure Origin/size/method/client-IP/rate decisions, and Helmet → perimeter context → CORS projection → all-request rate → Origin admission → request perimeter → framing → method → OPTIONS composition. |
| `src/systems/securityPerimeter.js` | Host/target/Origin/media capability decisions, UUID request context, deny-all browser capability headers, and value-free rejection audit events. |
| `src/systems/agentManifest.js` | Catalog-derived machine resource links, stable schema metadata, safe link relations, and provenance. |
| `src/systems/estateObservatory.js` | Pure composition of the authored public-site catalog with presence and privacy-safe aggregate evidence. |
| `src/systems/observatory.js` | OAuth/Google effects, pure aggregate projection, reporting windows, privacy boundary, and availability composition. |
| `src/systems/presence.js` | Authored-target probes, bounded parallel composition, and state projection. |
| `src/systems/securityPosture.js` | Authored-only passive observation, defensive-header projection, aggregate assessment sanitizer, public policy projection, and cache orchestration. |
| `scripts/check-data-authority.js` | Recursive source/JSON authority and route-catalog parity checker, with an optional portfolio RTK Query contract reader. |
| `scripts/check-security.js` | Frozen policy invariant and candidate secret/file scanner; findings include only path and rule. |
| `test/api.test.js` | Real ephemeral HTTP-server route, cache-header, authored-contract, readiness, CORS, and error tests. |
| `test/agentManifest.test.js` | Machine-manifest schema, safe-link, catalog projection, provenance, and fail-closed authority tests. |
| `test/dataAuthority.test.js` | Live repository authority/parity gate plus focused fixtures for copy drift, executable-config exclusions, catalog failures, and client endpoint extraction. |
| `test/estateObservatory.test.js` | Site-to-estate projection, honest uninstrumented/unavailable capability state, real evidence preservation, and presence-failure degradation. |
| `test/github.test.js` | Pure/injected GitHub normalization, contract, cache, single-flight, stale cooldown, all-resource provenance, timeout, partial, commit, and contribution tests. |
| `test/security.test.js` | Pure policy plus ephemeral HTTP tests for fail-closed configuration, headers, authority, target, Origin, JSON negotiation, request identity, socket/Vercel client keys, CORS, quota-bearing preflight, methods, framing, rate reset/isolation/LRU/invariants, private cache policy, and GET/HEAD behavior. |
| `test/securityChecker.test.js` | Least-capability policy and redacted secret-scanner behavior. |
| `test/securityPosture.test.js` | Passive target confinement, header-value privacy, assessment allowlist/sanitization, RTK serializability, single-flight, stale cooldown, and unsafe-target rejection. |
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
curl -fsS https://api.sdin.dev/agent-manifest
curl -fsS https://api.sdin.dev/github
curl -fsS https://api.sdin.dev/observatory
curl -fsS https://api.sdin.dev/presence
curl -fsS https://api.sdin.dev/security-posture
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
