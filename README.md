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
partial repository refresh never replaces a complete stale repository value.
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
and archived projects, and are ordered by most recent push.

The contribution calendar uses GitHub's contribution data when available and
resolves to `null` when it cannot be obtained, allowing a client to omit the
calendar without losing the rest of the response. Public activity includes only
event kinds the source proves; it does not invent commit counts from push events.
Private repositories and private activity never appear in these public results.

## Error responses

Unknown paths return a JSON `404` with the requested path and the current
`availableEndpoints` list. Upstream GitHub failures return a JSON `502` with a
plain service error; diagnostics stay in server-side logs. Unexpected service
failures return a JSON `500` without exposing internal details.

Only `GET`, `HEAD`, and `OPTIONS` are accepted. Other methods return JSON `405`
with an `Allow` header and `allowedMethods`. Invalid declared request lengths
return `400`; oversized or transfer-encoded requests return JSON `413` with the
byte limit. Framing is checked before the method, so an oversized `POST` is a
`413`, not a `405`. Clients that exceed the read limit receive JSON `429` and
`Retry-After`. A security-state failure returns a generic JSON `503` without
exposing its internal cause.

When rate state can be evaluated, each non-preflight response publishes
`RateLimit-Policy`, `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset`. Clients should follow those values instead of assuming a
fixed quota. The service also supplies hardened browser headers,
`Vary: Origin` on every response, and public read-only CORS without credential
support.
