'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const {
  createEstateObservatoryService,
  projectEstateObservatory,
} = require('../src/systems/estateObservatory');

const sites = [
  {
    id: 'registry',
    label: 'sdin.dev',
    url: 'https://sdin.dev',
    capabilities: { presence: true, analytics: true, searchConsole: true },
  },
  {
    id: 'lectures',
    label: 'Lectures',
    url: 'https://seandinwiddie.github.io/lectures/',
    capabilities: { presence: true, analytics: false, searchConsole: false },
  },
];

describe('estate observatory composition', () => {
  test('projects every authored destination with honest capability evidence', () => {
    const result = projectEstateObservatory(sites)({
      observatory: {
        checkedAt: '2026-08-31T00:00:00.000Z',
        availability: 'available',
        properties: [
          {
            id: 'registry',
            analytics: { availability: 'available', realtime: { activeUsers: 3 } },
            searchConsole: { availability: 'unconfigured', current: null },
          },
        ],
      },
      presence: {
        channels: [
          {
            id: 'registry',
            state: 'operational',
            httpStatus: 200,
            latencyMs: 42,
            checkedAt: '2026-08-31T00:00:00.000Z',
          },
        ],
      },
    });

    assert.deepEqual(result.estates.map(({ id, url }) => ({ id, url })), [
      { id: 'registry', url: 'https://sdin.dev' },
      { id: 'lectures', url: 'https://seandinwiddie.github.io/lectures/' },
    ]);
    assert.equal(
      result.estates[0].capabilities.analytics.realtime.activeUsers,
      3
    );
    assert.equal(
      result.estates[0].capabilities.searchConsole.availability,
      'unconfigured'
    );
    assert.deepEqual(result.estates[1].capabilities.analytics, {
      instrumented: false,
      availability: 'not-instrumented',
    });
    assert.deepEqual(result.estates[1].capabilities.searchConsole, {
      instrumented: false,
      availability: 'not-instrumented',
    });
    assert.equal(
      result.estates[1].capabilities.presence.availability,
      'unavailable'
    );
  });

  test('keeps aggregate observatory evidence when presence probing fails', async () => {
    const service = createEstateObservatoryService({
      sites,
      observatoryService: {
        getSummary: async () => ({ availability: 'available', properties: [] }),
      },
      presenceService: {
        getSummary: async () => {
          throw new Error('private presence transport detail');
        },
      },
    });

    const result = await service.getSummary();

    assert.equal(result.availability, 'available');
    assert.equal(result.estates.length, 2);
    result.estates.forEach((estate) => {
      assert.equal(estate.capabilities.presence.availability, 'unavailable');
    });
  });
});
