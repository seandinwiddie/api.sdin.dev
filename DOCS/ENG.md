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
* one route per non-reserved top-level authored key;
* `/github` for the aggregate client document; and
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

Reserved route names cannot be shadowed by authored keys. A collision must be
reported and skipped at composition rather than changing the meaning of a
built-in route.

The portfolio client contains schemas and presentation configuration but no
bundled authored-data fallback. Therefore changes to this JSON contract require
coordinated service tests, portfolio type/selector tests, and a deployed
consumer check.

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
| `src/components/securityPolicy.js` | Inert frozen security methods, origins, headers, defaults, and Helmet policy. |
| `src/entities/rateLimitStore.js` | Bounded process-local client-history entity with Map-order O(1) LRU refresh/eviction. |
| `src/security.js` | Security decisions and HTTP middleware-system composition. |
| `src/data/initialState.json` | Inert authored component data. |

Growth must split modules by component/entity/system ownership, not by generic
“utils”, “helpers”, or “handlers” buckets. Effects must not migrate into
normalizers or response-shape calculations.

## Functional-core policy

Normalization, filtering, tallying, ordering, state selection, and response
projection remain pure. The same input values produce the same serializable
output without hidden global mutation.

Per-instance services may close over cache state because the cache is an entity
owned by that service instance. Factories accept effects once at the boundary,
which keeps tests deterministic and prevents test processes from consuming live
GitHub quota. Errors cross the effect boundary as plain, classified HTTP
responses rather than implementation objects.

## GitHub resource contract

The GitHub system must:

* normalize snake_case upstream values to the stable camelCase client schema;
* include the configured user and configured organizations;
* exclude forked and archived repositories;
* deduplicate repositories by identity and order them by most recent push;
* derive owner/language tallies and the earliest repository date from the same
  normalized collection;
* expose only supported public activity kinds and never infer commit counts from
  push events;
* parse commit subjects without destroying the original subject; and
* omit private data because only public resources belong in this API.

Contribution loading selects GraphQL when the server has a GitHub token and the
public contribution HTML fragment otherwise. The HTML is an upstream markup
implementation detail, not a reliable API contract. Any request or parse failure
therefore resolves to an unavailable/null calendar and degraded metadata instead
of failing an otherwise useful summary.

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
2. a partial result may be cached only when no more complete stale value exists;
3. a partial refresh must never replace a complete stale value;
4. a failed refresh may serve the previous entry as stale; and
5. an uncached required-resource failure must reject rather than create a
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

Every outbound REST, GraphQL, and contribution-HTML request uses the shared
bounded-fetch effect. Invalid or non-positive duration configuration falls back
to a safe positive default.

One unavailable configured organization may produce a partial repository result
with its exact degraded source. All configured repository sources unavailable is
a required-resource failure. Commit failure degrades only commits in the
aggregate. Contribution failure degrades only contributions. Timeout and other
upstream failure classes remain distinguishable to clients without exposing a
credential or raw response body.

## Security boundary

The application owns one early HTTP-security boundary before cache and route
handlers. It must provide deliberate security headers and CORS policy, reject
unsupported methods, bound request size, and rate-limit abusive clients while
preserving ordinary read-only access and standards-compliant preflight/HEAD
behavior. Express's `X-Powered-By` fingerprint remains disabled.

The boundary order is intentional: Helmet applies hardened headers; every path
adds `Vary: Origin`; CORS is projected; non-preflight requests consume rate
capacity; declared size/framing and then method decisions reject invalid
requests; OPTIONS completes; and cache/business routes run last. Preflights
never consume rate capacity. Method and size rejections count toward quota and
carry the standard rate headers. Because framing precedes method selection, an
oversized unsupported-method request is `413`, not `405`. Only GET, HEAD, and
OPTIONS enter the service.

CORS accepts requests without an Origin as native/server clients. Browser
origins must be canonical HTTP(S) origins and follow the public-read or explicit
allowlist policy. Credentials are never enabled. Denial is expressed by the
absence of an allow-origin header, leaving standards-compliant browsers to
enforce the boundary without turning CORS into application authentication.

Invalid declared sizes fail as bad requests. Oversized content and
transfer-encoded bodies fail before route work. A method rejection advertises
the supported method set. Every policy rejection is `no-store` JSON.

Sliding-window rate histories are entity-owned, process-local, and bounded by
client count.
Map insertion order provides O(1) least-recently-used refresh and eviction before
inserting beyond that bound. Evaluated non-preflight requests publish draft-6
policy/limit/remaining/reset metadata; exhaustion returns retry metadata. A store
failure fails closed as service unavailable. Because this is deliberately
process-local, a multi-instance deployment must not market it as a global quota.

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
filesystem paths, stack traces, or internal dependency objects. Exact tunables,
defaults, and operational commands belong in [SCRIPTS.md](./SCRIPTS.md); response
semantics belong in the client README.

## Secret and privacy boundary

The optional GitHub token is a server-only upstream credential. It must never
appear in responses, cache keys exposed to clients, errors, logs, test evidence,
authored JSON, or documentation examples. The service collects no private GitHub
resources by design; an authenticated upstream request changes quota and the
calendar strategy, not the public-data scope.

Logs may identify the resource/path class that degraded but must not serialize
request headers or secrets. Internal and upstream failures return generic client
messages and only the public failure class; complete diagnostic detail remains
server-side.

## Test and release invariants

The deterministic suite must cover:

* startup/authored schema and every dynamic content route;
* readiness, cache headers, unknown JSON routes, and error classification;
* public contract keys and serializability;
* repository normalization/filtering/deduplication/order;
* single-flight, live, cached, stale, partial, and unavailable states;
* complete-stale preservation across a partial refresh;
* timeout classification and contribution degradation;
* aggregate resource isolation when commits or contributions fail; and
* every security header, method, CORS, request-bound, and rate-limit invariant.

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
4. expected private-revalidation and security headers;
5. JSON 404, unsupported-method, oversized-request, and rate-limit responses;
6. allowed-origin and denied-origin CORS behavior;
7. no leaked secret or stack/internal path; and
8. successful portfolio consumption of the same deployment.

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
