'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, test } = require('node:test');
const {
  catalogSchemaIssues,
  compareRouteSets,
  embeddedCopyIssues,
  estateParityIssues,
  implementedRoutesOf,
  mirroredLiteralIssues,
  parsePortfolioEndpoints,
  repositoryAudit,
  siteCatalogIssues,
} = require('../scripts/check-data-authority');
const app = require('../src/api');

const repoRoot = path.resolve(__dirname, '..');

describe('API-authored data authority', () => {
  test('keeps every runtime source, JSON document, and Express route coherent', () => {
    const audit = repositoryAudit(repoRoot);

    assert.deepEqual(audit.issues, []);
    assert.equal(audit.catalog.resources.length, 24);
    assert.equal(implementedRoutesOf(app).length, 24);
    assert.equal(
      audit.catalog.resources.filter((resource) => resource.portfolio).length,
      7
    );
  });

  test('rejects mirrored and newly embedded authored presentation copy', () => {
    const canonical = {
      presentation: {
        headline: 'Registry signal interrupted',
      },
    };
    const mirrored = [{
      relativePath: 'src/mirrored.js',
      source: "const fallback = 'Registry signal interrupted';",
    }];
    const embedded = [{
      relativePath: 'src/embedded.js',
      source: "const panel = { headline: 'Welcome operator' };",
    }];

    assert.match(mirroredLiteralIssues(canonical, mirrored)[0].detail, /mirrors authored/);
    assert.match(embeddedCopyIssues(embedded)[0].detail, /embeds presentation copy/);
  });

  test('preserves executable identifiers and protocol mechanics as code', () => {
    const executableConfiguration = [{
      relativePath: 'src/components/policy.js',
      source: [
        "const status = 'ready';",
        "const metric = { name: 'activeUsers' };",
        "const channel = { label: 'sdin.dev' };",
        "const methods = ['GET', 'HEAD'];",
      ].join('\n'),
    }];

    assert.deepEqual(embeddedCopyIssues(executableConfiguration), []);
  });

  test('accumulates catalog schema, duplicate, missing, orphan, and method failures', () => {
    const malformedCatalog = {
      version: 2,
      resources: [
        { id: 'data', method: 'GET', path: '/data', domain: 'registry', portfolio: true },
        { id: 'data', method: 'GET', path: '/data', domain: 'registry', portfolio: true },
      ],
    };
    const expected = [
      { method: 'GET', path: '/data' },
      { method: 'GET', path: '/status' },
    ];
    const actual = [
      { method: 'POST', path: '/data' },
      { method: 'GET', path: '/extra' },
      { method: 'GET', path: '/extra' },
    ];
    const schemaDetails = catalogSchemaIssues(malformedCatalog).map(({ detail }) => detail);
    const parityDetails = compareRouteSets('fixture')(expected, actual)
      .map(({ detail }) => detail);

    assert.ok(schemaDetails.includes('version must equal 1'));
    assert.ok(schemaDetails.includes('duplicate resource id data'));
    assert.ok(schemaDetails.includes('duplicate method/path GET /data'));
    assert.ok(parityDetails.some((detail) => detail.includes('duplicate implemented')));
    assert.ok(parityDetails.some((detail) => detail.includes('method mismatch at /data')));
    assert.ok(parityDetails.includes('missing implementation GET /status'));
    assert.ok(parityDetails.includes('orphaned implementation GET /extra'));
  });

  test('extracts framework-neutral method/path pairs from the portfolio RTK Query boundary', () => {
    const portfolioApi = `
      endpoints: (builder) => ({
        getInitialState: builder.query<AppData, void>({ query: () => '/data' }),
        getGithubSummary: builder.query<GithubSummary, void>({ query: () => '/github' }),
        getGithubCommits: builder.query<GithubCommits, void>({ query: () => '/github/commits' }),
        getApiStatus: builder.query<ApiStatus, void>({ query: () => '/status' }),
        getObservatory: builder.query<Observatory, void>({ query: () => '/observatory' }),
        getPresence: builder.query<Presence, void>({ query: () => '/presence' }),
        getSecurityPosture: builder.query<SecurityPosture, void>({ query: () => '/security-posture' }),
      })
    `;
    const parsed = parsePortfolioEndpoints(portfolioApi);

    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.resources, [
      { method: 'GET', path: '/data' },
      { method: 'GET', path: '/github' },
      { method: 'GET', path: '/github/commits' },
      { method: 'GET', path: '/status' },
      { method: 'GET', path: '/observatory' },
      { method: 'GET', path: '/presence' },
      { method: 'GET', path: '/security-posture' },
    ]);
  });

  test('enforces public-channel and observatory-estate destination parity', () => {
    const sites = [
      {
        id: 'registry',
        label: 'sdin.dev',
        url: 'https://sdin.dev',
        capabilities: { presence: true, analytics: true, searchConsole: true },
        repositories: [{
          id: 'seandinwiddie-portfolio',
          sourceUrl: 'https://github.com/seandinwiddie/portfolio',
          status: 'public-source',
        }],
      },
      {
        id: 'lectures',
        label: 'Lectures',
        url: 'https://example.com/lectures',
        capabilities: { presence: false, analytics: false, searchConsole: false },
        repositories: [],
      },
    ];
    const estates = [
      { id: 'registry', url: 'https://wrong.example', repositories: [] },
      { id: 'orphan', url: 'https://orphan.example', repositories: [] },
      { id: 'orphan', url: 'https://orphan.example', repositories: [] },
    ];
    const schemaDetails = siteCatalogIssues(sites).map(({ detail }) => detail);
    const parityDetails = estateParityIssues(sites, estates).map(({ detail }) => detail);

    assert.ok(
      schemaDetails.includes('every public signal destination must be presence-monitored')
    );
    assert.ok(parityDetails.includes('duplicate observatory estate id orphan'));
    assert.ok(parityDetails.includes('missing observatory estate lectures'));
    assert.ok(parityDetails.includes('orphaned observatory estate orphan'));
    assert.ok(parityDetails.some((detail) => detail.startsWith('destination mismatch')));
  });
});
