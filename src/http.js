const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

const positiveMilliseconds = (value, fallback = DEFAULT_REQUEST_TIMEOUT_MS) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Effect boundary for fetch. The timeout-signal factory is injectable so tests
 * can exercise timeout behavior without sleeping or touching the network.
 */
const createBoundedFetch = ({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  makeTimeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
} = {}) => {
  const boundedTimeoutMs = positiveMilliseconds(timeoutMs);

  return (url, init = {}) =>
    fetchImpl(url, {
      ...init,
      signal: makeTimeoutSignal(boundedTimeoutMs),
    });
};

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  createBoundedFetch,
  positiveMilliseconds,
};
