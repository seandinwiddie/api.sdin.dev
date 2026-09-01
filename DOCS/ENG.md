# api.sdin.dev — Engineering and Quality Contract

**Canonical service specification**

This document defines the architecture, HTTP contracts, resilience rules, and
release standard for `api.sdin.dev`. The root README describes only the public
client experience. [SCRIPTS.md](./SCRIPTS.md) is the sole authority for setup,
environment, commands, maintenance, and deployment verification.

## Service mission

`api.sdin.dev` is the runtime data authority for the portfolio. It serves one
authored portfolio document and normalizes public GitHub resources into stable,
serializable client contracts. It protects clients from upstream field churn,
timeouts, partial organization failures, and GitHub-specific naming.

The service remains read-only. It does not accept portfolio-authoring mutations,
proxy arbitrary upstream URLs, or expose a configured GitHub credential.

## Contract surface

The route families are:

* `/status` for uncached service and authored-data readiness;
* `/data` for the complete authored portfolio document;
* `/agent-manifest` for schema-versioned machine discovery, provenance, links,
  usage policy, and the catalog-derived resource inventory;
* `/security-posture` for bounded authored-estate observations and sanitized
  owner-authorized assessment status;
* one route per non-reserved top-level authored key;
* `/github` for the aggregate client document;
* `/observatory` for bounded public aggregate Analytics and Search Console
  signals;
* `/presence` for bounded public-channel reachability observations; and
* focused `/github/profile`, `/github/repos`, `/github/activity`,
  `/github/contributions`, and `/github/commits` resources.

All ordinary responses and errors are JSON. Unknown routes include the requested
path and a current endpoint inventory. Dependency failures are distinguishable
from internal faults. The endpoint inventory must derive from registered static
routes and valid authored keys so documentation and error recovery do not become
a manually maintained second route list.

The public response contract must remain backward-compatible unless a versioned
migration is intentional. Adding availability metadata is compatible; silently
renaming or removing existing data fields is not.

## Authored-data authority

`src/data/initialState.json` is the sole authored portfolio-data authority for
this service. Startup must parse it before accepting requests and fail closed if
the file is missing or invalid. `/data`, dynamic key routes, and `/status`
readiness all project this same in-memory document.

`brandName` owns the portfolio shell's primary public header identity and is
exactly `Portfolio.sdin.dev`. Lore-oriented registry names remain presentation
metadata and must not replace that public product identity.

`presentation.runtime.sound` owns the sound control's visible enabled/disabled
copy and its action-oriented accessibility labels. The portfolio client owns
the serializable visitor preference and gesture-gated audio effect; those
runtime concerns must not be mirrored into authored API data.

`presentation.runtime.telemetry.labels.feed` is exactly `GH + GOOGLE LIVE`, so
the compact rail names both public signal authorities. The client may project
the authored live suffix against dynamic sync, stale, or unavailable state, but
must not replace the API-owned source label with local copy.

Ambient motion tables define a continuously alive but quiet field: long,
phase-separated cycles keep passive geometry from moving in lockstep, while
small drift values preserve reading and hit geometry. Faster transit and beacon
novelty remains sparse; semantic RTK activity pulses carry the sharper response.

`presentation.runtime.resourceCatalog` is the framework-neutral method/path
authority for every registered HTTP resource. Each entry has a stable resource
and domain identity plus an explicit portfolio-consumer flag; it does not expose
Redux endpoint names. The source-wide authority checker compares that catalog
with the Express route stack so missing, duplicate, orphaned, and method-drifted
resources fail verification.

`presentation.runtime.agentManifest` owns machine-facing service identity,
canonical authority, safe link relations, media policy, and rate-header names.
The `/agent-manifest` system derives its resource collection from the canonical
resource catalog and adds only observation provenance; it cannot become a
second manually maintained route list.

`presentation.runtime.securityPosture` owns the public description, defensive
control rubric, and links. `src/data/securityAssessments.json` is the separate
schema-versioned authority for deployable sanitized assessment status; scheduled
owner automation can replace that one aggregate JSON document without rewriting
portfolio presentation data. `src/data/securityPosturePolicy.json` owns target
confinement, profiles and states, severity and trend vocabularies, passive effect
timeouts, scan limits, and reviewed active-rule capabilities. JavaScript only
validates those values, freezes them recursively, and projects behavior from
them. Startup and the data-authority gate validate the JSON authorities together
and fail closed on drift, raw-finding fields, unsafe URLs, or an unsupported
rubric or capability.

The same checker recursively scans every JavaScript or TypeScript module under
`src`, requires source JSON to remain under `src/data`, rejects mirrored
canonical prose and newly embedded presentation-copy bindings, and accumulates
all violations in one run. Executable schema mechanics and route behavior remain
code, while authored presentation, assessment, and security-posture configuration
remain validated JSON under `src/data`.

`presentation.nexus.presences` is the single public-site catalog for Open Signal
Channel links, bounded presence probes, and Observatory estate inventory. Every
site declares presence, Analytics, and Search Console instrumentation capability.
Each site also owns an explicit repository-attribution array. Entries contain a
stable ID, canonical public GitHub source URL, and `public-source` status; an
empty array is an intentional no-attribution state. The estate projection
carries this authored array verbatim so consumers never infer source ownership
from domains or display labels.
The estate projector carries real aggregate and presence evidence when it
exists, reports `unavailable` or `unconfigured` when configured instrumentation
has no evidence, and reports `not-instrumented` for capabilities with no
property. It never manufactures zero metrics. Verification requires exact
site-ID and destination parity between this catalog and projected estates.

Reserved route names cannot be shadowed by authored keys. A collision must be
reported and skipped at composition rather than changing the meaning of a
built-in route.

The portfolio client contains schemas and presentation configuration but no
bundled authored-data fallback. Therefore changes to this JSON contract require
coordinated service tests, portfolio type/selector tests, and a deployed
consumer check.

Current portfolio resource ownership is:

| API resource domain | Method and path | Portfolio RTK Query owner |
| :---- | :---- | :---- |
| Registry | `GET /data` | `getInitialState` document cache |
| GitHub | `GET /github` | `getGithubSummary` document cache |
| Commit archive | `GET /github/commits` | `getGithubCommits` document cache |
| Service | `GET /status` | `getApiStatus` document cache |
| Observatory | `GET /observatory` | `getObservatory` document cache |
| Presence | `GET /presence` | `getPresence` document cache |
| Security posture | `GET /security-posture` | `getSecurityPosture` document cache |

This table documents client ownership; the JSON catalog remains portable to any
consumer framework. Cross-repository validation reads the portfolio API
boundary without importing portfolio source into the service runtime.

## Ownership architecture

The runtime is Node.js 20+ CommonJS on Express. The HTTP boundary uses the CORS
package and Helmet 8.3.x; upstream access uses the platform Fetch/AbortSignal
APIs. These dependencies serve explicit ownership boundaries and must not
become alternate policy authorities.

The service aligns with the general `Forboc.AI/api`
components/entities/systems/effect-boundary model, adapted to a much smaller
read-only service:

* **Components/contracts** are inert JSON-compatible request-independent values:
  authored content, normalized profile/repository/activity/commit/calendar
  records, and availability metadata.
* **Entities/resources** own cache entries, in-flight work, timestamps, partial
  markers, degraded sources, and resource-specific normalization.
* **Systems** compose HTTP routes, GitHub resources, contribution strategies,
  cache policy, and application startup.
* **Effects** are explicit and injectable at the edge: upstream fetch, clock,
  timeout-signal creation, contribution loading, logging, filesystem startup,
  and HTTP listening.

The physical modules apply those roles at compact scale:

| Module | Ownership |
| :---- | :---- |
| `src/api.js` | Application composition, route/cache policy, error boundary, and process startup. |
| `src/github.js` | Normalization, resource entities, cache state, aggregate projections, and GitHub orchestration. |
| `src/contributions.js` | Contribution-calendar strategy and normalization. |
| `src/http.js` | Bounded upstream-fetch effect. |
| `src/components/observatoryPolicy.js` | Frozen Google endpoint, metric, channel, and configuration contracts. |
| `src/components/securityPolicy.js` | Inert frozen security methods, origins, headers, defaults, and Helmet policy. |
| `src/data/securityPosturePolicy.json` | Exact passive/assessment target, vocabulary, rate, cooldown, duration, privacy, and active-rule capabilities. |
| `src/components/securityPosturePolicy.js` | Pure fail-closed schema/invariant validation, recursive freeze, and named policy projections. |
| `src/entities/observatoryStore.js` | Loss-averse observatory snapshot, single-flight refresh, and stale provenance. |
| `src/entities/presenceStore.js` | Bounded public-presence snapshot and single-flight refresh. |
| `src/entities/rateLimitStore.js` | Factory-scoped RTK client-history authority with normalized entities, event reducers, bounded LRU order, and decision selectors. |
| `src/entities/securityPostureStore.js` | RTK-normalized per-site evidence, serializable snapshot metadata, single-flight refresh, and stale cooldown provenance. |
| `src/security.js` | Security decisions and HTTP middleware-system composition. |
| `src/systems/securityPerimeter.js` | Separate least-capability request perimeter for authority, target, Origin, representation, response capabilities, request identity, and rejection auditing. |
| `src/systems/agentManifest.js` | Pure catalog-to-resource-link projection and machine-readable provenance. |
| `src/systems/estateObservatory.js` | Pure site-catalog join across public presence and aggregate Observatory evidence. |
| `src/systems/observatory.js` | Google effect orchestration and privacy-preserving aggregate projections. |
| `src/systems/presence.js` | Authored-target probing, state classification, and summary projection. |
| `src/systems/securityPosture.js` | Exact-authored-target passive observation, defensive-evidence projection, aggregate assessment sanitization, and posture orchestration. |
| `src/data/initialState.json` | Inert authored component data. |
| `scripts/check-data-authority.js` | Recursive authored-copy, JSON-location, Express/catalog, and optional portfolio-client contract audit. |

Growth must split modules by component/entity/system ownership, not by generic
“utils”, “helpers”, or “handlers” buckets. Effects must not migrate into
normalizers or response-shape calculations.

## Functional-core policy

Normalization, filtering, tallying, ordering, state selection, and response
projection remain pure. The same input values produce the same serializable
output without hidden global mutation.

The service is an intentional production consumer of
`functional-programming-composition`. `allPass` owns timeout validity;
`multiMatch` and `orElse` own bounded status/availability classification;
`fold` owns aggregate reductions; `pipe` owns normalization pipelines; and
`Either` values keep Google transport failure outside successful value
projections. Use the weakest lawful abstraction and keep fetch/token work at
the system boundary. The TypeScript lectures may link to these source examples;
the runtime never depends on curriculum content.

The security-posture entity uses Redux Toolkit because the serializable
observation snapshot is shared durable process state: `createEntityAdapter`
normalizes sites, event-style reducers own snapshot/stale transitions, and
selectors reconstruct the public document. The in-flight Promise, fetch,
timeout signal, and clock stay outside Redux. This preserves RTK's event →
reducer → selector data flow without placing a non-serializable capability in
state. Pure FP projections evaluate controls, weighted coverage, aggregate
severity, trends, and public allowlists before the Express effect boundary.

Per-instance services may close over cache state because the cache is an entity
owned by that service instance. Factories accept effects once at the boundary,
which keeps tests deterministic and prevents test processes from consuming live
GitHub quota. Errors cross the effect boundary as plain, classified HTTP
responses rather than implementation objects.

## GitHub resource contract

The GitHub system must:

* normalize snake_case upstream values to the stable camelCase client schema;
* validate endpoint-specific successful-response shapes before normalization so
  malformed `2xx` payloads cannot become truthful-looking empty resources;
* include the configured user and configured organizations;
* cap configured organizations at six (seven repository sources including the
  user) and cap the public repository projection at 70;
* request only public organization repositories and fail closed unless every
  projected repository is explicitly public, then exclude forks and archives;
* deduplicate repositories by identity and order them by most recent push;
* derive owner/language tallies and the earliest repository date from the same
  normalized collection;
* expose only supported public activity kinds and never infer commit counts from
  push events;
* constrain commit search to `is:public` and fail closed unless each projected
  item's repository explicitly reports `private: false`;
* parse commit subjects without destroying the original subject; and
* omit private data because only public resources belong in this API.

Contribution loading always uses the unauthenticated public contribution HTML
fragment. A configured server token must never widen that viewer scope to
private or internal contribution activity. The HTML is an upstream markup
implementation detail, not a reliable API contract. Any request or parse
failure therefore resolves to an unavailable/null calendar and degraded
metadata instead of failing an otherwise useful summary.

## Cache and availability contract

Each GitHub resource has a private TTL cache and one in-flight producer per
cache key. Concurrent misses share that producer. A fresh cache hit performs no
upstream call.

Every focused resource reports:

* `cached`, `stale`, and `availability.state`;
* whether the value is partial;
* when the represented resource was fetched;
* exact degraded upstream paths; and
* a stable error code or `null`.

Allowed states are `live`, `cached`, `stale`, `partial`, and `unavailable`.
Allowed upstream codes are `PARTIAL_UPSTREAM`, `UPSTREAM_TIMEOUT`, and
`UPSTREAM_ERROR`.

Refresh policy is loss-averse:

1. a complete live result replaces the previous entry;
2. a partial result may be cached only when no stronger stale value exists;
3. a partial refresh must never replace a complete value or a partial value
   with greater upstream-source coverage;
4. a failed or weaker refresh must serve the retained entry through a fresh
   TTL cooldown so public polling cannot create an upstream retry storm;
5. cooldown reads must remain explicitly `cached` and `stale`, preserving the
   failed refresh's degraded sources and error code; and
6. an uncached required-resource failure must reject rather than create a
   healthy-looking empty cache entry.

The aggregate `/github` response preserves usable resources when commits or the
calendar are unavailable and carries an `availability.resources` map. Its
summary state follows the most serious represented resource condition; clients
must never need to infer health from empty arrays.

## HTTP caching contract

Every ordinary response uses `private, no-cache, max-age=0, must-revalidate`.
Shared-cache directives such as `s-maxage` are forbidden so every network
request reaches the security and rate-limit boundary. Express ETags remain
available for private conditional requests and `304` responses. `/status` and
every error or policy rejection are `no-store` because cached readiness or a
cached failure is not current state.

GitHub's in-process TTL, single-flight, and stale cache remains the data
resilience authority. HTTP revalidation must not rewrite its
`availability.state`: an in-process stale value stays labeled stale even when
the HTTP representation is conditionally reusable by one client.

## Timeout and partial-failure contract

Every outbound REST and contribution-HTML request uses the shared
bounded-fetch effect. Invalid or non-positive duration configuration falls back
to a safe positive default.

One unavailable configured organization may produce a partial repository result
with its exact degraded source. All configured repository sources unavailable is
a required-resource failure. Commit failure degrades only commits in the
aggregate. Contribution failure degrades only contributions. Timeout and other
upstream failure classes remain distinguishable to clients without exposing a
credential or raw response body.

## Public observatory contract

The observatory reads two fixed API-owned channels and publishes only aggregate
evidence suitable for a public interface. Each configured channel may provide
current and prior 28-day Analytics and Search Console totals, bounded daily
series, percentage/absolute direction, and realtime active-user count. The
system counts a report attempt as successful only after its expected metric and
dimension headers or Search Console row shape passes structural validation.
Structurally valid empty reports remain legitimate zero evidence; malformed
successful payloads remain unavailable and cannot replace stronger cached data.
The reporting calendar closes at the prior America/Los_Angeles day so a partial
current day cannot masquerade as a comparable period.

Availability is explicit: `available`, `partial`, `unavailable`, or
`unconfigured`, plus independent `cached` and `stale` provenance. Zero is a
valid measured baseline. A zero prior value yields no invented percentage. A
complete cached snapshot survives a weaker refresh or later transport outage;
weaker evidence cannot overwrite stronger history. Failed or weaker refreshes
advance a stale cooldown before another Google fan-out is eligible. The OAuth
stage and report stage each have a 2.5-second default timeout, keeping their
sequential worst case comfortably inside the portfolio's eight-second request
budget.

Every estate projects its API-authored `repositories` attribution. The array is
never joined from live GitHub results or inferred from a hostname: it contains
only stable IDs, canonical public source URLs, and `public-source` status from
the site catalog. Exact catalog/projection parity is a verification invariant,
including intentional empty arrays.

Raw queries, path-level records, countries, visitor dimensions, Google property
identifiers, OAuth material, transport diagnostics, and access tokens must not
cross the response boundary. Daily series contain dates and aggregate metrics
only and stay bounded to the reporting window.

## Public presence contract

Presence targets come exclusively from `presentation.nexus.presences`; callers
cannot submit a URL. The catalog and returned collection are bounded to seven
channels. Checks run in parallel through the bounded-fetch effect, use `HEAD`,
never follow redirects, and reduce results to `operational`, `limited`, or
`unreachable` plus status, latency, and check time. A short-lived cache and one
in-flight refresh prevent an interface poll from multiplying outbound work.
If a refresh rejects after a usable snapshot exists, the retained stale value
receives a fresh cooldown before another probe fan-out is eligible.

## Digital-estate security posture contract

`/security-posture` is an observatory, not a targetable scanner. Its passive
system accepts no request parameters and probes only the exact public HTTPS
destinations already owned by `presentation.nexus.presences`. Construction
rejects IP literals, local names, credentials, non-default ports, duplicate
destinations, and catalogs above the fixed twelve-site ceiling. Each effect is
a time-bounded `HEAD` with `redirect: manual`; no response body, redirect
destination, certificate detail, server fingerprint, or raw header value enters
the public component.

The FP core reduces safe Fetch evidence into an eight-control rubric:
encrypted transport, positive HSTS, CSP, frame protection, `nosniff`, a
recognized referrer policy, permissions policy, and COOP/COEP cross-origin
isolation. A control is only `present`, `missing`, or `unavailable`. Weighted
coverage reports what this observation saw and must never be named a
certification, compliance grade, vulnerability result, or proof that a site is
secure. A successful HTTPS Fetch proves only that the runtime completed that
transport; the API does not invent TLS versions, certificate metadata, or
server-side state unavailable to Fetch.

One RTK entity store owns the normalized serializable site snapshot and cache
metadata. Exactly one in-flight refresh exists outside Redux. Fresh readers use
the cached snapshot; if a refresh-level failure follows a usable value, that
value is returned with `cached: true`, `stale: true`, and a renewed cooldown.
Per-site transport faults are ordinary `unavailable` evidence and never expose
the underlying exception.

External assessment publication is a separate trust zone. The public GET never
starts Sucuri, ZAP, another provider, or a manual pentest. Owner-controlled
automation may assess only `https://portfolio.sdin.dev` and
`https://api.sdin.dev`; JSON-authored, fail-closed policy permits one target at
a time, at most one run per target per day, at most two requests per second, a
500 ms minimum delay, twelve total minutes, one minute per active rule, and a
fixed reviewed active-rule allowlist. Authenticated scanning remains disabled.
These limits are capabilities, not request-time options, and public callers
cannot widen them.

The `src/data/securityAssessments.json` input boundary accepts only document
schema/state/update time plus per-target schema version, assessment ID,
exact target tuple, profile, active flag, observation/expiry time, state,
five aggregate severity counts, aggregate coverage, policy-parity limits,
provider, and aggregate trend. It recomputes `alertsTotal`, projects only the
allowlist, marks expired evidence from `validUntil`, and always emits
`rawFindingsPublic: false`. Any finding title, URL/path, parameter, payload,
request/response sample, cookie, token, stack trace, remediation note, or other
unrecognized field aborts startup instead of entering the public document.
The serverless ingestion path is an owner-only scheduled workflow that validates
and atomically replaces this one sanitized file, commits it, and lets deployment
publish the new immutable snapshot. There is no assessment POST endpoint and no
ephemeral function-instance write pretending to be durable state.
Unavailable assessments use `null` counts; zero means a completed assessment
measured zero alerts at that severity.

This separation follows the official guidance rather than overstating remote
coverage. [Sucuri SiteCheck](https://sitecheck.sucuri.net/) says its remote view
is limited to browser-visible evidence and cannot detect server-side findings.
The official [ZAP Baseline Scan](https://www.zaproxy.org/docs/docker/baseline-scan/)
is short-lived spidering followed by passive analysis and performs no active
attacks. ZAP's
[Automation Framework](https://www.zaproxy.org/docs/automate/automation-framework/)
separates passive-wait and active-scan jobs, while its
[alert-job guidance](https://www.zaproxy.org/docs/desktop/addons/automation-framework/test-alert/)
explicitly states that active scanning attacks a target and requires
permission. Provider output therefore enters only through separately
authorized automation and this API's aggregate sanitizer.

## Machine discovery contract

`/agent-manifest` is the stable JSON entry point for automated consumers. Its
schema version, canonical base URL, service description, safe link relations,
read-only/no-auth policy, response media type, and rate-limit header names are
API-authored JSON. The resource array is derived from the same catalog checked
against Express, with an absolute `href` and stable `rel` for every method/path.
Each response includes an observation timestamp and `/data` provenance. No
secret, private assessment detail, raw report location, or undocumented route
may appear. Textual crawler artifacts may link here, but they do not replace
the JSON authority.

## Security boundary

The application owns two early, composable HTTP-security layers before cache and
route handlers. `src/security.js` owns Helmet, CORS, request framing, methods,
trusted client identity, and RTK rate state. The separate
`src/systems/securityPerimeter.js` owns the request capability envelope:
authority, target shape, Origin admission, JSON representation negotiation,
browser-feature denial, server-generated request identity, and sanitized
rejection auditing. Express's `X-Powered-By` fingerprint remains disabled.

This is an OpenBSD-inspired application security model, not a claim that a
Node.js function on Vercel executes OpenBSD system calls. The design imports the
relevant principles: secure defaults, a small declared capability set, no
request-time widening, separate policy/state/effect ownership, and fail-closed
behavior. OpenBSD's [`pledge(2)`](https://man.openbsd.org/pledge.2) makes
undeclared subsystems unavailable and only permits later restriction;
[`unveil(2)`](https://man.openbsd.org/unveil.2) exposes only a declared namespace
and can then be locked; and OpenBSD documents continuous proactive auditing and
disabled non-essential services in its
[security goals](https://www.openbsd.org/security.html). The deploy platform
continues to own the actual process, filesystem, network, and TLS sandbox.

The boundary order is intentional: Helmet applies hardened headers; a trusted
UUID request context and deny-all browser capability headers are established;
every path adds `Vary: Origin`; CORS is projected without granting credentials;
every request, including a malformed-Origin request or preflight, consumes rate
capacity; malformed or disallowed Origins then fail; host, target, and
representation promises are checked; declared size/framing and then method
decisions reject invalid requests; OPTIONS completes; and business routes run
last. Method, size, target, Origin, media, and preflight work therefore count
toward quota and carry standard rate headers whenever rate state is available.
Because framing precedes method selection, an oversized unsupported-method
request is `413`, not `405`. Only GET, HEAD, and OPTIONS enter the service.

CORS accepts requests without an Origin as native/server clients. Browser
origins must be canonical HTTP(S) origins and follow the public-read or explicit
allowlist policy. Credentials are never enabled. A malformed Origin, or an
origin outside a restricted policy, receives JSON `403`; this is an explicit
server decision rather than reliance on a browser omitting access to a `200`.
Public-read mode remains intentionally general because every published resource
is public and non-credentialed.

The request authority must name `api.sdin.dev`, a local development host, an
explicit configured host, or a syntactically valid Vercel preview host when that
capability is enabled; other authorities receive `421`. The request target must
be origin-form with a canonical ASCII route path, validly encoded query,
no dot/double-slash segments or decoded control characters/backslashes, and at
most 2,048 bytes by default. `Accept` must permit JSON or a compatible wildcard;
an incompatible value receives `406`. A supplied `Content-Type` must be
`application/json` with at most UTF-8 charset metadata or receives `415`.
Invalid declared sizes fail as bad requests. Oversized content and
transfer-encoded bodies fail before route work. A method rejection advertises
the supported method set. Every policy rejection is `no-store` JSON.

Security environment values use defaults only when absent. An explicitly
invalid boolean, positive integer, client-IP source, origin, or host is an
applicative validation failure; all independent faults are accumulated and
startup aborts without printing their values. Requests cannot weaken or extend
the frozen policy. This keeps configuration mistakes from silently turning
into a permissive runtime.

Sliding-window rate histories are entity-owned, process-local, and bounded by
client count. Each security composition creates one Redux Toolkit store for its
warm-instance lifetime. A normalized entity adapter owns client histories while
an ordered identifier collection provides least-recently-used refresh and
eviction before inserting beyond the bound. Event-style reducers receive only a
client key and observed timestamp; policy, histories, and the last admission are
plain serializable values. Selectors project the last admission, derive remaining
capacity and reset time, and assemble the complete middleware decision. The
clock, Express objects, logging, promises, and every other capability remain
outside Redux.

Evaluated requests publish draft-6 policy/limit/remaining/reset metadata;
exhaustion returns retry metadata. A missing or malformed RTK decision and every
store failure fail closed as service unavailable. The store is intentionally non-durable: cold starts,
instance recycling, and parallel instances begin independent histories. A
multi-instance deployment must never market this boundary as a global quota.

The default client key is the socket address and Express proxy trust remains
disabled. Only an explicit Vercel mode may read `x-vercel-forwarded-for`; it
accepts exactly one syntactically valid IP and falls back to the socket for a
missing, malformed, or comma-separated value. Generic `X-Forwarded-For` is never
trusted. `vercel.json` must select that Vercel mode explicitly while direct and
non-Vercel execution retains the socket default. Production verification must
prove the chosen boundary distinguishes visitors without accepting a spoofable
client key.

Security policy must be deterministic under an injected clock where time
affects behavior. Rejections must use JSON and must not leak credentials,
filesystem paths, stack traces, raw error objects, request headers, or internal
dependency objects. Security logs carry only a fixed event code and a
server-generated request ID. `X-Request-ID` gives operators and clients a shared
correlation value without trusting caller input. `Permissions-Policy` denies
unused browser capabilities; frame denial, one-year preload HSTS, no-referrer,
no-sniff, CSP, private revalidation, and explicit CDN `no-store` directives form
defense in depth for JSON clients.

The HTTP contracts follow the official OWASP
[REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
for method, length, media, error, header, CORS, and rate controls; the
[API Security Top 10 misconfiguration guidance](https://owasp.org/API-Security/editions/2023/en/0xa8-security-misconfiguration/)
for repeatable hardening across the proxy/application chain; and
[ASVS](https://owasp.org/www-project-application-security-verification-standard/)
as the verification framework. Exact tunables, defaults, and operational
commands belong in [SCRIPTS.md](./SCRIPTS.md); response semantics belong in the
client README.

## Secret and privacy boundary

The optional GitHub token is a server-only upstream credential. It must never
appear in responses, cache keys exposed to clients, errors, logs, test evidence,
authored JSON, or documentation examples. The service collects no private
GitHub resources by design; authenticated REST requests change quota, not the
public-data scope. Contribution loading remains an unauthenticated public-viewer
request regardless of token configuration.

Google OAuth client/refresh credentials and short-lived access tokens remain
inside the observatory effect boundary under the same rule. Analytics property
identifiers and Search Console property keys are server configuration, not
public response fields. Public observatory documents contain only fixed channel
identity, aggregate metrics, bounded date series, and availability provenance.

Logs may identify the resource/path class that degraded but must not serialize
request headers or secrets. Internal and upstream failures return generic client
messages and only the public failure class; complete diagnostic detail remains
server-side.

## Test and release invariants

The deterministic suite must cover:

* startup/authored schema and every dynamic content route;
* source-wide JSON authority, presentation-copy isolation, resource-catalog
  schema, and Express method/path parity;
* readiness, cache headers, unknown JSON routes, and error classification;
* public contract keys and serializability;
* repository normalization/filtering/deduplication/order;
* aggregate-only observatory normalization, period math, privacy exclusion,
  partial/unconfigured states, bounded trends, single-flight, and strongest
  stale preservation;
* authored-only presence probing, seven-target enforcement, classification,
  cache provenance, and redirect refusal;
* public-site schema, Google instrumentation-policy ownership, exact
  channel/estate destination and repository-attribution parity, and
  non-fabricated capability states;
* security-posture catalog confinement, unsafe-target rejection, passive
  method/redirect/body limits, pure header-state projection, RTK
  normalization, single-flight, stale cooldown, sanitized severity/trend, and
  raw-finding rejection;
* agent-manifest definition validation, catalog-derived links, schema and
  provenance fields, and route/catalog parity;
* single-flight, live, cached, stale, partial, and unavailable states;
* complete-stale preservation across a partial refresh;
* timeout classification and contribution degradation;
* aggregate resource isolation when commits or contributions fail; and
* every security header, method, host, target, Origin, media, request-identity,
  configuration, request-bound, and rate-limit invariant; and
* the candidate-file secret scan, frozen security-policy checker, and current
  production-dependency audit.

Tests use an ephemeral real HTTP listener for boundary behavior and injected
effects for upstream behavior. They must not require a fixed port, network
access, sleep-based timing, or a live GitHub token.

The settled tree must pass the complete Node behavior suite, syntax checks,
whitespace validation, dependency review appropriate to the change, and a
client-contract review against the portfolio. Exact invocations and environment
coverage live in [SCRIPTS.md](./SCRIPTS.md).

## Production acceptance

A candidate is production-verified only after the active deployed service shows:

1. uncached current readiness;
2. complete authored data and focused content routes;
3. valid live/cached/stale/partial GitHub response semantics;
4. honest aggregate observatory and bounded presence responses, including
   privacy exclusions, repository attribution, and stale/unconfigured semantics;
5. the schema-versioned agent manifest and catalog-derived resource links;
6. bounded security-posture evidence with exact authored targets, cache/stale
   provenance, and no raw assessment details;
7. expected private-revalidation and security headers;
8. JSON 404, unsupported-method, oversized-request, and rate-limit responses;
9. allowed-origin CORS and explicit denied-origin behavior;
10. authority, target, Accept, Content-Type, and request-ID perimeter behavior;
11. no leaked secret, raw error, or stack/internal path; and
12. successful portfolio consumption of the same deployment.

Local suite success, source push, platform deployment, and production HTTP
verification are separate milestones and must be reported separately.

## Change policy

* Add or change response fields at their canonical projector and update tests,
  the client README, and portfolio schemas together.
* Keep the authored JSON, not duplicated source literals, authoritative for
  portfolio content.
* Add new upstream effects through the shared bounded boundary and classify
  their failure/availability behavior before exposing them.
* Add security tunables with validated safe defaults and document them only in
  the scripts/config authority.
* Prefer forward migrations over compatibility shims when the client and service
  can move together; explicitly version a breaking public contract.
* Never weaken a test or acceptance criterion merely to make an implementation
  pass.
