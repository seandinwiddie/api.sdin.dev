/**
 * Public-presence observability.
 *
 * Targets come exclusively from the authored API document. Callers cannot
 * supply URLs, redirects are never followed, and failures are reduced to a
 * small serializable state vocabulary at this effect boundary.
 */

const { createPresenceStore } = require('../entities/presenceStore');
const { createBoundedFetch, positiveMilliseconds } = require('../http');
const {
  _,
  fold,
  multiMatch,
  orElse,
} = require('functional-programming-composition');

const DEFAULT_CACHE_TTL_MS = positiveMilliseconds(
  process.env.PRESENCE_CACHE_TTL_MS,
  5 * 60 * 1000
);
const DEFAULT_REQUEST_TIMEOUT_MS = positiveMilliseconds(
  process.env.PRESENCE_REQUEST_TIMEOUT_MS,
  4000
);
const MAX_PRESENCE_TARGETS = 7;

const isoAt = (milliseconds) => new Date(milliseconds).toISOString();

const stateOfStatus = (status) =>
  orElse(
    multiMatch(status, [
      [(value) => value >= 200 && value < 400, () => 'operational'],
      [(value) => [401, 403, 405, 429].includes(value), () => 'limited'],
      [_, () => 'unreachable'],
    ]),
    'unreachable'
  );

const summarize = (channels) => {
  const counts = fold(
    channels,
    { operational: 0, limited: 0, unreachable: 0 },
    (summary, { state }) => ({ ...summary, [state]: summary[state] + 1 }),
  );

  return {
    channels: channels.length,
    ...counts,
  };
};

const normalizeTarget = ({ id, label, url }) => ({ id, label, url });

const createPresenceService = ({
  targets,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  makeTimeoutSignal,
  store = createPresenceStore({ now, ttlMs: cacheTtlMs }),
} = {}) => {
  const authoredTargets = Object.freeze((targets ?? []).map(normalizeTarget));
  if (authoredTargets.length > MAX_PRESENCE_TARGETS) {
    throw new RangeError(
      `Presence target catalog exceeds the ${MAX_PRESENCE_TARGETS}-channel safety bound`
    );
  }
  const boundedFetch = createBoundedFetch({
    fetchImpl,
    timeoutMs: requestTimeoutMs,
    makeTimeoutSignal,
  });

  const probe = async (target) => {
    const startedAt = now();

    try {
      const response = await boundedFetch(target.url, {
        method: 'HEAD',
        redirect: 'manual',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'api.sdin.dev-presence-observer',
        },
      });
      const checkedAt = now();

      return {
        ...target,
        state: stateOfStatus(response.status),
        httpStatus: response.status,
        latencyMs: Math.max(0, checkedAt - startedAt),
        checkedAt: isoAt(checkedAt),
      };
    } catch {
      const checkedAt = now();
      return {
        ...target,
        state: 'unreachable',
        httpStatus: null,
        latencyMs: null,
        checkedAt: isoAt(checkedAt),
      };
    }
  };

  const observe = async () => {
    const channels = await Promise.all(authoredTargets.map(probe));
    const checkedAt = now();

    return {
      checkedAt: isoAt(checkedAt),
      summary: summarize(channels),
      channels,
    };
  };

  return Object.freeze({
    getSummary: () => store.read(observe),
  });
};

module.exports = {
  MAX_PRESENCE_TARGETS,
  createPresenceService,
  stateOfStatus,
  summarize,
};
