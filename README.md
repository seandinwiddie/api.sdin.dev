# api.sdin.dev

[api.sdin.dev](https://api.sdin.dev) is the public JSON service behind
[portfolio.sdin.dev](https://portfolio.sdin.dev). It provides the registry's
authored copy and ambient world plus normalized public GitHub missions,
activity, contributions, and commits.

## Endpoints

All content endpoints are read-only and return JSON. `HEAD` is available for
header-only checks, and a valid CORS preflight receives an empty `204`.

| Method | Path | Response |
| :---- | :---- | :---- |
| `GET` | `/` | Service readiness message. |
| `GET` | `/status` | Current service version, check time, and authored-data readiness. |
| `GET` | `/data` | Complete authored registry document. |
| `GET` | `/agent-manifest` | Self-describing resource catalog, provenance, safe link relations, and usage policy for automated clients. |
| `GET` | `/security-posture` | Bounded passive defensive-header observations plus sanitized authorized-assessment status for the authored digital estate. |
| `GET` | `/observatory` | Public aggregate Analytics and Search Console measurements and trends. |
| `GET` | `/presence` | Bounded reachability and latency observations for API-authored public channels. |
| `GET` | `/<content-key>` | One named top-level value from the authored document. |
| `GET` | `/github` | Aggregated profile, repositories, owners, languages, activity, contribution calendar, commits, and per-resource availability. |
| `GET` | `/github/profile` | Normalized public GitHub profile. |
| `GET` | `/github/repos` | Non-fork, non-archived public repositories across the configured user and organizations, with owner/language summaries. |
| `GET` | `/github/activity` | Recent supported public activity, grouped by repository and event kind. |
| `GET` | `/github/contributions` | Chronological contribution days, intensity levels, total, and source when available. |
| `GET` | `/github/commits` | Recent public commit subjects, repository links, dates, and conventional-commit type/scope when present. |

The content-key routes are `/bddTests`, `/brandName`, `/description`,
`/iniTheme`, `/registryCapabilities`, `/operatingProtocols`, `/presentation`,
`/themeToggle`, `/themeCustom`, `/ambientScene`, and `/dossier`.

## Availability and freshness

Every GitHub resource identifies whether its value is `live`, `cached`, `stale`,
`partial`, or `unavailable`. Resource responses include:

```json
{
  "cached": false,
  "stale": false,
  "availability": {
    "state": "live",
    "cached": false,
    "stale": false,
    "partial": false,
    "fetchedAt": "2026-08-30T00:00:00.000Z",
    "degradedSources": [],
    "errorCode": null
  }
}
```

The aggregate `/github` response adds `partial`, `checkedAt`, and an
`availability.resources` map. Clients can omit one unavailable panel without
misrepresenting the rest of the summary as unhealthy.

`errorCode` is `PARTIAL_UPSTREAM`, `UPSTREAM_TIMEOUT`, `UPSTREAM_ERROR`, or
`null`. A complete older value may be returned as stale when refresh fails. A
partial repository refresh never replaces a complete stale value or a prior
partial value with greater upstream-source coverage.
Failed and weaker refreshes enter a TTL-bounded stale cooldown, so repeated
public reads do not multiply upstream retry work during an outage.
If no usable required resource exists, the API returns `502` rather than a
healthy empty result.

Ordinary responses use private conditional revalidation. They may carry an
`ETag`, but are never stored as shared CDN content; each network request reaches
the service's security boundary before a client can reuse a `304`. `/status` and
all error responses are always `no-store` so an old OK or failure cannot be
mistaken for current state. GitHub's in-process resource cache still provides the
live/cached/stale provenance described above.

`/status` covers this service and its authored document. GitHub dependency
health belongs to each GitHub response's availability metadata.

## GitHub response notes

Repository objects contain only fields the portfolio consumes and use
client-friendly camelCase names. Repositories are deduplicated, exclude forks
and archived projects, and are ordered by most recent push. The configured
organization fan-out is capped at six and the public repository projection is
capped at 70 so configuration growth cannot create an unbounded request or
response surface.

The contribution calendar uses GitHub's unauthenticated public contribution
fragment even when the service has a token, and resolves to `null` when it
cannot be obtained. This lets a client omit the calendar without losing the
rest of the response and prevents server credentials from widening its viewer
scope. Public activity includes only event kinds the source proves; it does not
invent commit counts from push events.
Private repositories and private activity never appear in these public results.
Organization repository discovery requests only public records and rejects any
item that is not explicitly marked public before normalization.
Commit search enforces that boundary twice: the upstream query requests only
public repositories, and the response projector rejects any item whose
repository is not explicitly public.

## Presence observability

`/presence` checks only the public destinations authored in
`presentation.nexus.presences`. It does not accept a caller-supplied URL and it
does not follow redirects, keeping the observer outside the API's SSRF surface.
Checks are bounded, parallel, and briefly cached. Each channel reports a small
operational/limited/unreachable state, HTTP status when available, observed
latency, and check time; it does not claim traffic, audience, or conversion data
that the public source cannot prove. A retained stale snapshot also receives a
cooldown before another outbound probe set is eligible.

## Digital-estate security posture

`/security-posture` performs one bounded `HEAD` observation for each exact HTTPS
destination in `presentation.nexus.presences`. It never accepts a caller target,
never follows redirects, never reads a response body, never probes a private or
IP-literal destination, and briefly caches one normalized RTK snapshot. A
transport failure becomes an `unavailable` observation without DNS, TLS, socket,
or exception details.

The response reports only `present`, `missing`, or `unavailable` control states
for encrypted transport, HSTS, CSP, frame protection, content-type protection,
referrer policy, permissions policy, and cross-origin isolation. Header values,
certificate details, response bodies, redirect destinations, and server
fingerprints are not public. Coverage is evidence from one remote observation,
not a guarantee or security certification.

Authorized external, baseline, active-DAST, and manual-pentest results use a
separate aggregate contract. Public reads cannot start those assessments. The
fixed active allowlist contains only `https://portfolio.sdin.dev` and
`https://api.sdin.dev`; execution belongs to an owner-controlled CI/CLI lane
with one target at a time, a daily target cooldown, request-rate and duration
bounds, and no authenticated scan. The public API returns sanitized target,
profile, provider, observation/expiry time, severity counts, coverage, and trend
only. Raw alerts, paths, payloads, request/response evidence, and remediation
detail remain private. When no authorized result is published, counts are
`null`, not truthful-looking zeroes.

## Machine-readable discovery

`/agent-manifest` projects `presentation.runtime.resourceCatalog` into absolute
resource links. It includes a schema version, observation time, `/data`
provenance, JSON media type, read-only/no-auth usage policy, rate-limit header
names, and safe relations for the portfolio, source, documentation, authored
data, and security posture. Automated clients should discover routes here
instead of scraping the human README or the `404` recovery payload.

## Impact observatory

`/observatory` publishes aggregate Google Analytics and Search Console signals
for the fixed `sdin.dev` and `seandinwiddie.com` channels. It includes current
and prior 28-day measurements, change direction, a bounded daily trend, and
realtime active users when available. Honest zero, partial, unavailable, and
unconfigured states remain visible so the portfolio can show a baseline without
inventing growth. Failed or weaker refreshes retain the strongest snapshot and
defer the next Google fan-out for one cache interval.

OAuth credentials, Google property identifiers, raw search queries, visitor
dimensions, countries, path-level records, and upstream diagnostics never enter the public
response. Short-lived access tokens stay inside the server-side effect boundary.

Every `observatory.estates` record also carries the API-authored `repositories`
array for that site. Each attribution has a stable ID, canonical public GitHub
source URL, and `public-source` status; an empty array explicitly means that no
repository has been attributed. Clients do not infer ownership from hostnames.

## Error responses

Unknown paths return a JSON `404` with the requested path and the current
`availableEndpoints` list. Upstream GitHub failures return a JSON `502` with a
plain service error; a server-generated request ID correlates the response with
sanitized server-side events. Unexpected service failures return a JSON `500`
without exposing internal details.

Only `GET`, `HEAD`, and `OPTIONS` are accepted. Other methods return JSON `405`
with an `Allow` header and `allowedMethods`. Invalid declared request lengths
return `400`; oversized or transfer-encoded requests return JSON `413` with the
byte limit. Framing is checked before the method, so an oversized `POST` is a
`413`, not a `405`. Clients that exceed the read limit receive JSON `429` and
`Retry-After`. A security-state failure returns a generic JSON `503` without
exposing its internal cause.

The request perimeter also returns JSON `421` for an unrecognized authority,
`400` for a malformed or overlong request target, `403` for a malformed Origin
or an Origin denied by restricted mode, `406` when `Accept` excludes JSON, and
`415` when a supplied `Content-Type` is not JSON. Requests without an Origin
remain valid native/server clients. Public browser reads remain intentionally
non-credentialed and receive wildcard CORS after their Origin is structurally
validated.

When rate state can be evaluated, every request, including preflight, publishes
`RateLimit-Policy`, `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset`. Clients should follow those values instead of assuming a
fixed quota. Each response also carries a service-generated `X-Request-ID`,
hardened browser-feature and transport headers, explicit shared-CDN `no-store`,
`Vary: Origin`, and public read-only CORS without credential support.
