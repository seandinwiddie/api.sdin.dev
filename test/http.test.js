const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  createBoundedFetch,
  positiveMilliseconds,
} = require('../src/http');

describe('bounded HTTP effect', () => {
  test('accepts only positive integer delays supported by AbortSignal.timeout', () => {
    assert.equal(positiveMilliseconds(1), 1);
    assert.equal(positiveMilliseconds(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
    [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMEOUT_MS + 1].forEach(
      (value) => assert.equal(positiveMilliseconds(value), DEFAULT_REQUEST_TIMEOUT_MS)
    );
    assert.equal(positiveMilliseconds('invalid', 2500), 2500);
    assert.equal(
      positiveMilliseconds('invalid', MAX_TIMEOUT_MS + 1),
      DEFAULT_REQUEST_TIMEOUT_MS
    );
  });

  test('normalizes malformed configuration before constructing the timeout signal', async () => {
    let observedDelay = null;
    const boundedFetch = createBoundedFetch({
      timeoutMs: 0.5,
      makeTimeoutSignal: (delay) => {
        observedDelay = delay;
        return undefined;
      },
      fetchImpl: async () => ({ ok: true }),
    });

    await boundedFetch('https://example.test');
    assert.equal(observedDelay, DEFAULT_REQUEST_TIMEOUT_MS);
  });
});
