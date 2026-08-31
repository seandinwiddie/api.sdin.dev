const { allPass } = require('functional-programming-composition');

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
// Node timer delays above signed 32-bit range overflow to 1 ms.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const validTimeout = allPass([
  Number.isInteger,
  (value) => value > 0,
  (value) => value <= MAX_TIMEOUT_MS,
]);

const positiveMilliseconds = (value, fallback = DEFAULT_REQUEST_TIMEOUT_MS) => {
  const parsed = Number(value);
  const parsedFallback = Number(fallback);
  return validTimeout(parsed)
    ? parsed
    : (validTimeout(parsedFallback) ? parsedFallback : DEFAULT_REQUEST_TIMEOUT_MS);
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
  MAX_TIMEOUT_MS,
  createBoundedFetch,
  positiveMilliseconds,
};
