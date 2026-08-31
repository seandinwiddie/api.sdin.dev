const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  MAX_PRESENCE_TARGETS,
  createPresenceService,
  stateOfStatus,
  summarize,
} = require('../src/systems/presence');
const { createPresenceStore } = require('../src/entities/presenceStore');

const targets = [
  { id: 'alpha', label: 'Alpha', url: 'https://alpha.example' },
  { id: 'beta', label: 'Beta', url: 'https://beta.example' },
];

describe('presence observability', () => {
  test('backs off consecutive reads after a failed refresh', async () => {
    let clock = 0;
    let calls = 0;
    const store = createPresenceStore({ now: () => clock, ttlMs: 10 });
    const produce = async () => {
      calls += 1;
      if (calls > 1) throw new Error('private upstream detail');
      return { channels: [{ state: 'operational' }] };
    };

    await store.read(produce);
    clock = 11;
    const failedRefresh = await store.read(produce);
    const cooldownRead = await store.read(produce);

    assert.equal(calls, 2);
    assert.deepEqual(failedRefresh, {
      channels: [{ state: 'operational' }],
      cached: true,
      stale: true,
    });
    assert.deepEqual(cooldownRead, failedRefresh);

    clock = 22;
    await store.read(produce);
    assert.equal(calls, 3);
  });

  test('classifies transport results with a compact honest vocabulary', () => {
    assert.equal(stateOfStatus(204), 'operational');
    assert.equal(stateOfStatus(302), 'operational');
    assert.equal(stateOfStatus(403), 'limited');
    assert.equal(stateOfStatus(503), 'unreachable');
    assert.deepEqual(
      summarize([
        { state: 'operational' },
        { state: 'limited' },
        { state: 'unreachable' },
      ]),
      { channels: 3, operational: 1, limited: 1, unreachable: 1 }
    );
  });

  test('probes only authored targets in parallel without following redirects', async () => {
    let clock = 0;
    const calls = [];
    const service = createPresenceService({
      targets,
      now: () => (clock += 5),
      cacheTtlMs: 100,
      makeTimeoutSignal: () => undefined,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { status: url.includes('alpha') ? 200 : 403 };
      },
    });

    const first = await service.getSummary();
    const second = await service.getSummary();

    assert.equal(first.cached, false);
    assert.equal(first.stale, false);
    assert.equal(second.cached, true);
    assert.equal(second.stale, false);
    assert.equal(calls.length, 2);
    calls.forEach(({ init }) => {
      assert.equal(init.method, 'HEAD');
      assert.equal(init.redirect, 'manual');
    });
    assert.deepEqual(
      first.channels.map(({ id, state }) => ({ id, state })),
      [
        { id: 'alpha', state: 'operational' },
        { id: 'beta', state: 'limited' },
      ]
    );
  });

  test('rejects an authored target catalog beyond the bounded probe fan-out', () => {
    const overflow = Array.from({ length: MAX_PRESENCE_TARGETS + 1 }, (_, index) => ({
      id: `target-${index}`,
      label: `Target ${index}`,
      url: `https://target-${index}.example`,
    }));

    assert.throws(
      () => createPresenceService({ targets: overflow }),
      /safety bound/
    );
  });

  test('reduces transport failures without leaking failure details', async () => {
    const service = createPresenceService({
      targets: [targets[0]],
      now: () => 1_800_000_000_000,
      makeTimeoutSignal: () => undefined,
      fetchImpl: async () => {
        throw new Error('private DNS and socket detail');
      },
    });

    const result = await service.getSummary();

    assert.deepEqual(result.channels[0], {
      ...targets[0],
      state: 'unreachable',
      httpStatus: null,
      latencyMs: null,
      checkedAt: '2027-01-15T08:00:00.000Z',
    });
    assert.equal(JSON.stringify(result).includes('private DNS'), false);
  });
});
