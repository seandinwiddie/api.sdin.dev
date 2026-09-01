'use strict';

const { pipe } = require('functional-programming-composition');

const MANIFEST_FIELDS = Object.freeze([
  'canonicalBaseUrl',
  'description',
  'kind',
  'links',
  'schemaVersion',
  'service',
  'usage',
]);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0;
const exactFields = (value, fields) =>
  isObject(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');

const canonicalHttpsOrigin = (value) => {
  const parsed = nonEmptyString(value) && URL.canParse(value)
    ? new URL(value)
    : null;
  return Boolean(parsed && parsed.protocol === 'https:' && parsed.origin === value);
};

const manifestDefinitionIssues = ({ definition, resourceCatalog }) => {
  const resources = Array.isArray(resourceCatalog?.resources)
    ? resourceCatalog.resources
    : [];
  const links = Array.isArray(definition?.links) ? definition.links : [];
  const usage = definition?.usage;
  return [
    ...(exactFields(definition, MANIFEST_FIELDS) ? [] : ['manifest-fields']),
    ...(/^\d+\.\d+\.\d+$/u.test(definition?.schemaVersion ?? '')
      ? []
      : ['manifest-schema']),
    ...(definition?.kind === 'public-api-manifest' ? [] : ['manifest-kind']),
    ...(definition?.service === 'api.sdin.dev' ? [] : ['manifest-service']),
    ...(nonEmptyString(definition?.description) ? [] : ['manifest-description']),
    ...(canonicalHttpsOrigin(definition?.canonicalBaseUrl)
      ? []
      : ['manifest-base-url']),
    ...(Array.isArray(definition?.links) ? [] : ['manifest-links-array']),
    ...(new Set(links.map(({ rel }) => rel)).size === links.length
      ? []
      : ['manifest-links-unique']),
    ...links.flatMap((link, index) => [
      ...(exactFields(link, ['href', 'rel', 'type'])
        ? []
        : [`manifest-link-${index}-fields`]),
      ...(/^[a-z][a-z0-9-]*$/u.test(link?.rel ?? '')
        ? []
        : [`manifest-link-${index}-rel`]),
      ...(
        nonEmptyString(link?.href) &&
        URL.canParse(link.href) &&
        new URL(link.href).protocol === 'https:'
          ? []
          : [`manifest-link-${index}-https`]
      ),
      ...(nonEmptyString(link?.type) ? [] : [`manifest-link-${index}-type`]),
    ]),
    ...(exactFields(usage, [
      'authentication',
      'rateLimitHeaders',
      'readOnly',
      'responseMediaType',
    ]) ? [] : ['manifest-usage-fields']),
    ...(usage?.readOnly === true ? [] : ['manifest-read-only']),
    ...(usage?.authentication === 'none' ? [] : ['manifest-authentication']),
    ...(usage?.responseMediaType === 'application/json'
      ? []
      : ['manifest-media-type']),
    ...(
      Array.isArray(usage?.rateLimitHeaders) &&
      usage.rateLimitHeaders.every(nonEmptyString)
        ? []
        : ['manifest-rate-limit-headers']
    ),
    ...(resourceCatalog?.version === 1 ? [] : ['manifest-catalog-version']),
    ...(Array.isArray(resourceCatalog?.resources)
      ? []
      : ['manifest-resources-array']),
    ...(resources.length > 0 ? [] : ['manifest-resources-empty']),
  ];
};

const requireValidManifest = (input) => {
  const issues = manifestDefinitionIssues(input);
  if (issues.length > 0) {
    throw new Error(`Invalid agent manifest definition: ${issues.join(', ')}`);
  }
  return input;
};

const projectResource = (canonicalBaseUrl, mediaType) => (resource) => Object.freeze({
  id: resource.id,
  rel: resource.id,
  method: resource.method,
  path: resource.path,
  href: new URL(resource.path, canonicalBaseUrl).href,
  domain: resource.domain,
  portfolio: resource.portfolio,
  mediaType,
});

const createAgentManifestService = ({
  definition,
  resourceCatalog,
  now = Date.now,
} = {}) => {
  requireValidManifest({ definition, resourceCatalog });
  const resources = pipe(
    resourceCatalog.resources,
    (entries) => entries.map(projectResource(
      definition.canonicalBaseUrl,
      definition.usage.responseMediaType
    )),
    Object.freeze
  );

  const getSummary = () => {
    const observedAt = new Date(now()).toISOString();
    return Object.freeze({
      schemaVersion: definition.schemaVersion,
      kind: definition.kind,
      service: definition.service,
      description: definition.description,
      canonicalBaseUrl: definition.canonicalBaseUrl,
      observedAt,
      provenance: Object.freeze({
        authority: '/data',
        catalogPath: '/data#presentation.runtime.resourceCatalog',
        observedAt,
      }),
      usage: definition.usage,
      resources,
      links: definition.links,
    });
  };

  return Object.freeze({ getSummary });
};

module.exports = {
  createAgentManifestService,
  manifestDefinitionIssues,
  projectResource,
};
