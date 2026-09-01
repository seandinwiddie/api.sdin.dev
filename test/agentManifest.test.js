'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const initialState = require('../src/data/initialState.json');
const {
  createAgentManifestService,
  manifestDefinitionIssues,
} = require('../src/systems/agentManifest');

describe('agent manifest', () => {
  test('projects stable catalog resources with provenance and safe link relations', () => {
    const definition = initialState.presentation.runtime.agentManifest;
    const resourceCatalog = initialState.presentation.runtime.resourceCatalog;
    const service = createAgentManifestService({
      definition,
      resourceCatalog,
      now: () => Date.parse('2026-08-31T21:00:00.000Z'),
    });

    const result = service.getSummary();

    assert.equal(result.schemaVersion, '1.0.0');
    assert.equal(result.kind, 'public-api-manifest');
    assert.equal(result.observedAt, '2026-08-31T21:00:00.000Z');
    assert.equal(result.provenance.authority, '/data');
    assert.equal(result.usage.readOnly, true);
    assert.equal(result.usage.authentication, 'none');
    assert.equal(result.resources.length, resourceCatalog.resources.length);
    assert.deepEqual(
      result.resources.find(({ id }) => id === 'security-posture-summary'),
      {
        id: 'security-posture-summary',
        rel: 'security-posture-summary',
        method: 'GET',
        path: '/security-posture',
        href: 'https://api.sdin.dev/security-posture',
        domain: 'security-posture',
        portfolio: true,
        mediaType: 'application/json',
      }
    );
    assert.equal(
      result.links.find(({ rel }) => rel === 'source').href,
      'https://github.com/seandinwiddie/api.sdin.dev'
    );
  });

  test('fails closed on non-HTTPS authority or duplicate relations', () => {
    const definition = initialState.presentation.runtime.agentManifest;
    const resourceCatalog = initialState.presentation.runtime.resourceCatalog;
    const malformed = {
      ...definition,
      canonicalBaseUrl: 'http://api.sdin.dev',
      links: [definition.links[0], definition.links[0]],
    };

    assert.deepEqual(
      manifestDefinitionIssues({
        definition: malformed,
        resourceCatalog,
      }).filter((issue) => ['manifest-base-url', 'manifest-links-unique'].includes(issue)),
      ['manifest-base-url', 'manifest-links-unique']
    );
    assert.throws(
      () => createAgentManifestService({
        definition: malformed,
        resourceCatalog,
      }),
      /manifest-base-url/u
    );
  });
});
