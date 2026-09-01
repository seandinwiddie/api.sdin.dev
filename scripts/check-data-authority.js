'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  fold,
  fromNullable,
  match,
  pipe,
} = require('functional-programming-composition');
const { OBSERVATORY_CHANNELS } = require('../src/components/observatoryPolicy');
const {
  AUTHORIZED_ASSESSMENT_POLICY,
  AUTHORIZED_DAST_TARGETS,
  PASSIVE_SECURITY_POSTURE_POLICY,
  SECURITY_POSTURE_POLICY,
  securityPosturePolicyIssues,
} = require('../src/components/securityPosturePolicy');
const { manifestDefinitionIssues } = require('../src/systems/agentManifest');
const { projectEstateObservatory } = require('../src/systems/estateObservatory');
const {
  securityAssessmentIssues,
  securityPostureDefinitionIssues,
} = require('../src/systems/securityPosture');

const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const COPY_BINDING = /(?:caption|copy|description|eyebrow|headline|heading|label|prompt|statement|subtitle|text|title)$/i;
const AUTHORED_KEY = /^(?:brandName|caption|copy|description|detail|eyebrow|headline|heading|label|message|name|prompt|statement|subtitle|summary|text|title|.*Label|.*Text)$/i;
const MACHINE_PATH_SEGMENTS = new Set(['activityKinds', 'resourceCatalog']);
const MACHINE_LITERAL = /^(?:[a-z][a-zA-Z0-9]*(?:[._:/-][a-zA-Z0-9]+)+|[A-Z0-9_-]+)$/;
const ROUTE_PATH = /^\/(?:[A-Za-z][A-Za-z0-9-]*(?:\/[A-Za-z][A-Za-z0-9-]*)*)?$/;
const RESOURCE_TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESOURCE_FIELDS = ['domain', 'id', 'method', 'path', 'portfolio'];
const SITE_FIELDS = ['capabilities', 'id', 'label', 'repositories', 'url'];
const SITE_CAPABILITY_FIELDS = ['analytics', 'presence', 'searchConsole'];
const SITE_REPOSITORY_FIELDS = ['id', 'sourceUrl', 'status'];
const JAVASCRIPT_TOKEN = /(?<string>"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|(?<lineComment>\/\/[^\r\n]*)|(?<blockComment>\/\*[\s\S]*?\*\/)/g;
const AUTHORITY_OBJECT = /\b(?:const|let|var)\s+(?:authoredData|fallbackData|fallbackPresentation|presentationData|runtimePresentation)\s*=\s*(?:\{|\[)/g;

const issue = (code) => (location) => (detail) => ({ code, location, detail });
const report = issue('DATA-AUTHORITY');
const routeReport = issue('ROUTE-CATALOG');
const portfolioReport = issue('PORTFOLIO-CONTRACT');
const estateReport = issue('ESTATE-CATALOG');
const manifestReport = issue('AGENT-MANIFEST');
const postureReport = issue('SECURITY-POSTURE');

const when = (predicate) => (value) => predicate ? [value] : [];

const listFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });

const relativeUnix = (root) => (filePath) =>
  path.relative(root, filePath).split(path.sep).join('/');

const readSourceDocuments = (srcRoot) =>
  listFiles(srcRoot)
    .filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath)))
    .map((filePath) => ({
      filePath,
      relativePath: relativeUnix(path.dirname(srcRoot))(filePath),
      source: fs.readFileSync(filePath, 'utf8'),
    }));

const flattenLeaves = (value, segments = []) =>
  Array.isArray(value)
    ? value.flatMap((entry, index) => flattenLeaves(entry, [...segments, String(index)]))
    : value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, entry]) =>
          flattenLeaves(entry, [...segments, key]))
      : [{ segments, value }];

const lastSemanticSegment = (segments) =>
  [...segments].reverse().find((segment) => !/^\d+$/.test(segment)) ?? '';

const containsMachinePath = (segments) =>
  segments.some((segment) => MACHINE_PATH_SEGMENTS.has(segment));

const hasHumanGlyphs = (value) =>
  typeof value === 'string' && /[A-Za-z]/.test(value);

const isHumanFacing = (value) =>
  hasHumanGlyphs(value) && !MACHINE_LITERAL.test(value);

const isAuthoredLeaf = ({ segments, value }) =>
  !containsMachinePath(segments) &&
  hasHumanGlyphs(value) &&
  (/\s/.test(value) || AUTHORED_KEY.test(lastSemanticSegment(segments))) &&
  !MACHINE_LITERAL.test(value);

const quoteWith = (quote) => (value) =>
  `${quote}${value
    .replaceAll('\\', '\\\\')
    .replaceAll(quote, `\\${quote}`)
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}${quote}`;

const literalForms = (value) => [
  JSON.stringify(value),
  quoteWith("'")(value),
  quoteWith('`')(value).replaceAll('${', '\\${'),
];

const staticStringTokens = (source) =>
  [...source.matchAll(JAVASCRIPT_TOKEN)]
    .filter((token) => Boolean(token.groups?.string))
    .filter((token) => !(token[0].startsWith('`') && token[0].includes('${')))
    .map((token) => ({ index: token.index ?? 0, raw: token[0] }));

const decodeStaticLiteral = (raw) =>
  raw
    .slice(1, -1)
    .replace(/\\([\\'"`])/g, '$1')
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t');

const bindingBefore = (source) => (index) => {
  const prefix = source.slice(Math.max(0, index - 160), index);
  const binding = prefix.match(
    /(?:(?:^|[,{])\s*|\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*(?::|=)\s*$/
  );
  return binding?.[1] ?? null;
};

const authoredLiteralIndex = (canonical) =>
  fold(
    flattenLeaves(canonical).filter(isAuthoredLeaf),
    {},
    (index, entry) =>
      fold(literalForms(entry.value), index, (next, literal) => ({
        ...next,
        [literal]: [...(next[literal] ?? []), entry.segments.join('.')],
      }))
  );

const mirroredLiteralIssues = (canonical, documents) => {
  const literalIndex = authoredLiteralIndex(canonical);
  return documents.flatMap((document) =>
    staticStringTokens(document.source).flatMap((token) =>
      when(Boolean(literalIndex[token.raw]))(
        report(document.relativePath)(
          `mirrors authored JSON value from ${literalIndex[token.raw]?.join(', ')}`
        )
      )
    )
  );
};

const embeddedCopyIssues = (documents) =>
  documents.flatMap((document) => {
    const bindingAt = bindingBefore(document.source);
    const literalIssues = staticStringTokens(document.source).flatMap((token) => {
      const binding = bindingAt(token.index);
      const value = decodeStaticLiteral(token.raw);
      return when(Boolean(binding && COPY_BINDING.test(binding) && isHumanFacing(value)))(
        report(document.relativePath)(
          `embeds presentation copy in ${binding}; author it in src/data/initialState.json`
        )
      );
    });
    const objectIssues = [...document.source.matchAll(AUTHORITY_OBJECT)].map((match) =>
      report(document.relativePath)(
        `declares ${match[0].split(/\s+/)[1]} as a static authored-data object`
      )
    );
    return [...literalIssues, ...objectIssues];
  });

const jsonLocationIssues = (srcRoot, dataRoot) =>
  listFiles(srcRoot)
    .filter((filePath) => path.extname(filePath) === '.json')
    .flatMap((filePath) =>
      when(!path.resolve(filePath).startsWith(`${path.resolve(dataRoot)}${path.sep}`))(
        report(relativeUnix(path.dirname(srcRoot))(filePath))(
          'JSON runtime data must live under src/data'
        )
      )
    );

const duplicateValues = (values) =>
  Object.entries(
    fold(values, {}, (counts, value) => ({
      ...counts,
      [value]: (counts[value] ?? 0) + 1,
    }))
  )
    .filter(([, count]) => count > 1)
    .map(([value]) => value);

const resourceCatalogOf = (canonical) =>
  canonical?.presentation?.runtime?.resourceCatalog;

const validResourceObject = (resource) =>
  resource !== null && typeof resource === 'object' && !Array.isArray(resource);

const resourceSchemaIssues = (resource, index) => {
  const location = `presentation.runtime.resourceCatalog.resources.${index}`;
  const object = validResourceObject(resource) ? resource : {};
  return [
    ...when(validResourceObject(resource) === false)(
      routeReport(location)('resource must be a JSON object')
    ),
    ...when(Object.keys(object).sort().join(',') !== RESOURCE_FIELDS.join(','))(
      routeReport(location)(`resource fields must be exactly ${RESOURCE_FIELDS.join(', ')}`)
    ),
    ...when(!RESOURCE_TOKEN.test(object.id ?? ''))(
      routeReport(`${location}.id`)('id must be a kebab-case resource token')
    ),
    ...when(!/^[A-Z]+$/.test(object.method ?? ''))(
      routeReport(`${location}.method`)('method must be uppercase')
    ),
    ...when(!ROUTE_PATH.test(object.path ?? ''))(
      routeReport(`${location}.path`)('path must be an absolute static API path')
    ),
    ...when(!RESOURCE_TOKEN.test(object.domain ?? ''))(
      routeReport(`${location}.domain`)('domain must be a kebab-case resource token')
    ),
    ...when(typeof object.portfolio !== 'boolean')(
      routeReport(`${location}.portfolio`)('portfolio must be boolean')
    ),
  ];
};

const routePair = (resource) =>
  `${resource?.method ?? '<missing>'} ${resource?.path ?? '<missing>'}`;

const uniqueRoutes = (resources) =>
  Object.values(
    fold(resources, {}, (index, resource) => ({
      ...index,
      [routePair(resource)]: resource,
    }))
  );

const catalogSchemaIssues = (catalog) => {
  const resources = Array.isArray(catalog?.resources) ? catalog.resources : [];
  return [
    ...when(catalog?.version !== 1)(
      routeReport('presentation.runtime.resourceCatalog.version')('version must equal 1')
    ),
    ...when(!Array.isArray(catalog?.resources))(
      routeReport('presentation.runtime.resourceCatalog.resources')(
        'resources must be an array'
      )
    ),
    ...resources.flatMap(resourceSchemaIssues),
    ...duplicateValues(resources.map((resource) => resource?.id)).map((id) =>
      routeReport('presentation.runtime.resourceCatalog.resources')(
        `duplicate resource id ${id}`
      )
    ),
    ...duplicateValues(resources.map(routePair)).map((pair) =>
      routeReport('presentation.runtime.resourceCatalog.resources')(
        `duplicate method/path ${pair}`
      )
    ),
  ];
};

const siteSchemaIssues = (site, index) => {
  const location = `presentation.nexus.presences.${index}`;
  const object = validResourceObject(site) ? site : {};
  const capabilities = validResourceObject(object.capabilities)
    ? object.capabilities
    : {};
  const repositories = Array.isArray(object.repositories)
    ? object.repositories
    : [];
  return [
    ...when(!validResourceObject(site))(
      estateReport(location)('site must be a JSON object')
    ),
    ...when(Object.keys(object).sort().join(',') !== SITE_FIELDS.join(','))(
      estateReport(location)(`site fields must be exactly ${SITE_FIELDS.join(', ')}`)
    ),
    ...when(!RESOURCE_TOKEN.test(object.id ?? ''))(
      estateReport(`${location}.id`)('id must be a kebab-case site token')
    ),
    ...when(typeof object.label !== 'string' || object.label.trim().length === 0)(
      estateReport(`${location}.label`)('label must be non-empty text')
    ),
    ...when(
      typeof object.url !== 'string' ||
        !URL.canParse(object.url) ||
        new URL(object.url).protocol !== 'https:'
    )(
      estateReport(`${location}.url`)('destination must be a canonical HTTPS URL')
    ),
    ...when(
      Object.keys(capabilities).sort().join(',') !== SITE_CAPABILITY_FIELDS.join(',')
    )(
      estateReport(`${location}.capabilities`)(
        `capability fields must be exactly ${SITE_CAPABILITY_FIELDS.join(', ')}`
      )
    ),
    ...SITE_CAPABILITY_FIELDS.flatMap((capability) =>
      when(typeof capabilities[capability] !== 'boolean')(
        estateReport(`${location}.capabilities.${capability}`)(
          'instrumentation flag must be boolean'
        )
      )
    ),
    ...when(capabilities.presence !== true)(
      estateReport(`${location}.capabilities.presence`)(
        'every public signal destination must be presence-monitored'
      )
    ),
    ...when(!Array.isArray(object.repositories))(
      estateReport(`${location}.repositories`)('repositories must be an array')
    ),
    ...duplicateValues(repositories.map((repository) => repository?.id)).map((id) =>
      estateReport(`${location}.repositories`)(`duplicate repository id ${id}`)
    ),
    ...repositories.flatMap((repository, repositoryIndex) => {
      const repositoryLocation = `${location}.repositories.${repositoryIndex}`;
      const source = typeof repository?.sourceUrl === 'string' &&
        URL.canParse(repository.sourceUrl)
        ? new URL(repository.sourceUrl)
        : null;
      return [
        ...when(!validResourceObject(repository))(
          estateReport(repositoryLocation)('repository must be a JSON object')
        ),
        ...when(
          Object.keys(validResourceObject(repository) ? repository : {})
            .sort()
            .join(',') !== SITE_REPOSITORY_FIELDS.join(',')
        )(
          estateReport(repositoryLocation)(
            `repository fields must be exactly ${SITE_REPOSITORY_FIELDS.join(', ')}`
          )
        ),
        ...when(!RESOURCE_TOKEN.test(repository?.id ?? ''))(
          estateReport(`${repositoryLocation}.id`)(
            'id must be a kebab-case repository token'
          )
        ),
        ...when(!(
          source &&
          source.protocol === 'https:' &&
          source.hostname === 'github.com' &&
          /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.pathname) &&
          source.search === '' &&
          source.hash === ''
        ))(
          estateReport(`${repositoryLocation}.sourceUrl`)(
            'sourceUrl must be a canonical public GitHub repository URL'
          )
        ),
        ...when(repository?.status !== 'public-source')(
          estateReport(`${repositoryLocation}.status`)(
            'status must be public-source'
          )
        ),
      ];
    }),
  ];
};

const siteCatalogIssues = (sites) => {
  const entries = Array.isArray(sites) ? sites : [];
  return [
    ...when(!Array.isArray(sites))(
      estateReport('presentation.nexus.presences')(
        'public site catalog must be an array'
      )
    ),
    ...entries.flatMap(siteSchemaIssues),
    ...duplicateValues(entries.map((site) => site?.id)).map((id) =>
      estateReport('presentation.nexus.presences')(`duplicate public site id ${id}`)
    ),
    ...duplicateValues(entries.map((site) => site?.url)).map((url) =>
      estateReport('presentation.nexus.presences')(
        `duplicate public site destination ${url}`
      )
    ),
  ];
};

const estateParityIssues = (sites, estates) => {
  const siteIds = new Set((sites ?? []).map(({ id }) => id));
  const estateIds = new Set((estates ?? []).map(({ id }) => id));
  const sitesById = Object.fromEntries((sites ?? []).map((site) => [site.id, site]));
  return [
    ...duplicateValues((estates ?? []).map(({ id }) => id)).map((id) =>
      estateReport('observatory.estates')(`duplicate observatory estate id ${id}`)
    ),
    ...(sites ?? [])
      .filter(({ id }) => !estateIds.has(id))
      .map(({ id }) =>
        estateReport('observatory.estates')(`missing observatory estate ${id}`)
      ),
    ...(estates ?? [])
      .filter(({ id }) => !siteIds.has(id))
      .map(({ id }) =>
        estateReport('observatory.estates')(`orphaned observatory estate ${id}`)
      ),
    ...(estates ?? [])
      .filter(({ id }) => siteIds.has(id))
      .flatMap((estate) =>
        [
          ...when(sitesById[estate.id].url !== estate.url)(
            estateReport(`observatory.estates.${estate.id}`)(
              `destination mismatch: catalog ${sitesById[estate.id].url} versus estate ${estate.url}`
            )
          ),
          ...when(
            JSON.stringify(sitesById[estate.id].repositories) !==
              JSON.stringify(estate.repositories)
          )(
            estateReport(`observatory.estates.${estate.id}.repositories`)(
              'repository attribution differs from the authored site catalog'
            )
          ),
        ]
      ),
  ];
};

const instrumentationParityIssues = (sites) => {
  const expectedIds = (sites ?? [])
    .filter(({ capabilities }) =>
      capabilities?.analytics || capabilities?.searchConsole)
    .map(({ id }) => id);
  const configuredIds = OBSERVATORY_CHANNELS.map(({ siteId }) => siteId);
  return [
    ...expectedIds
      .filter((id) => !configuredIds.includes(id))
      .map((id) =>
        estateReport('src/components/observatoryPolicy.js')(
          `missing Google instrumentation policy for site ${id}`
        )
      ),
    ...configuredIds
      .filter((id) => !expectedIds.includes(id))
      .map((id) =>
        estateReport('src/components/observatoryPolicy.js')(
          `orphaned Google instrumentation policy for site ${id}`
        )
      ),
  ];
};

const implementedRoutesOf = (app) =>
  (app?._router?.stack ?? [])
    .filter((layer) => Boolean(layer.route))
    .flatMap((layer) =>
      Object.keys(layer.route.methods ?? {}).map((method) => ({
        method: method.toUpperCase(),
        path: String(layer.route.path),
      }))
    );

const valuesAt = (key) => (resources) =>
  [...new Set(resources.map((resource) => resource[key]))];

const compareRouteSets = (scope) => (expected, actual) => {
  const expectedPairs = new Set(expected.map(routePair));
  const actualPairs = new Set(actual.map(routePair));
  const expectedPaths = new Set(expected.map((resource) => resource.path));
  const actualPaths = new Set(actual.map((resource) => resource.path));
  const sharedPaths = [...expectedPaths].filter((routePath) => actualPaths.has(routePath));
  const mismatchedPaths = sharedPaths.filter((routePath) => {
    const expectedMethods = valuesAt('method')(
      expected.filter((resource) => resource.path === routePath)
    );
    const actualMethods = valuesAt('method')(
      actual.filter((resource) => resource.path === routePath)
    );
    return expectedMethods.sort().join(',') !== actualMethods.sort().join(',');
  });
  const mismatchSet = new Set(mismatchedPaths);
  return [
    ...duplicateValues(actual.map(routePair)).map((pair) =>
      routeReport(scope)(`duplicate implemented method/path ${pair}`)
    ),
    ...mismatchedPaths.map((routePath) =>
      routeReport(scope)(
        `method mismatch at ${routePath}: catalog ${valuesAt('method')(
          expected.filter((resource) => resource.path === routePath)
        ).join(',')} versus implementation ${valuesAt('method')(
          actual.filter((resource) => resource.path === routePath)
        ).join(',')}`
      )
    ),
    ...uniqueRoutes(expected)
      .filter((resource) => !actualPairs.has(routePair(resource)))
      .filter((resource) => !mismatchSet.has(resource.path))
      .map((resource) => routeReport(scope)(`missing implementation ${routePair(resource)}`)),
    ...uniqueRoutes(actual)
      .filter((resource) => !expectedPairs.has(routePair(resource)))
      .filter((resource) => !mismatchSet.has(resource.path))
      .map((resource) => routeReport(scope)(`orphaned implementation ${routePair(resource)}`)),
  ];
};

const parsePortfolioEndpoints = (source) => {
  const heads = [...source.matchAll(
    /([A-Za-z_$][\w$]*)\s*:\s*builder\.(query|mutation)\b/g
  )];
  const entries = heads.map((head, index) => ({
    endpoint: head[1],
    block: source.slice(head.index, heads[index + 1]?.index ?? source.length),
  }));
  const parsed = entries.map(({ endpoint, block }) => {
    const stringQuery = block.match(
      /\bquery\s*:\s*\([^)]*\)\s*=>\s*(['"])(\/[^'"]*)\1/
    );
    const objectQuery = block.match(
      /\bquery\s*:\s*\([^)]*\)\s*=>\s*\(\s*\{[\s\S]*?\burl\s*:\s*(['"])(\/[^'"]*)\1/
    );
    const method = block.match(/\bmethod\s*:\s*(['"])([A-Za-z]+)\1/)?.[2] ?? 'GET';
    const routePath = stringQuery?.[2] ?? objectQuery?.[2] ?? null;
    return { endpoint, method: method.toUpperCase(), path: routePath };
  });
  return {
    resources: parsed
      .filter((resource) => resource.path !== null)
      .map(({ method, path: routePath }) => ({ method, path: routePath })),
    issues: parsed
      .filter((resource) => resource.path === null)
      .map((resource) =>
        portfolioReport(resource.endpoint)('endpoint query must expose a static relative path')
      ),
  };
};

const portfolioContractIssues = (catalog, portfolioRoot) => {
  const apiSourcePath = path.join(
    portfolioRoot,
    'src/features/systems/substrate/kernel/api/apiApi.ts'
  );
  const sourceExists = fs.existsSync(apiSourcePath);
  const parsed = sourceExists
    ? parsePortfolioEndpoints(fs.readFileSync(apiSourcePath, 'utf8'))
    : { resources: [], issues: [] };
  const expected = (catalog?.resources ?? []).filter((resource) => resource.portfolio);
  return [
    ...when(!sourceExists)(
      portfolioReport(relativeUnix(portfolioRoot)(apiSourcePath))(
        'portfolio RTK Query API source was not found'
      )
    ),
    ...parsed.issues,
    ...compareRouteSets('portfolio RTK Query resource coverage')(
      expected,
      parsed.resources
    ).map((entry) => ({ ...entry, code: 'PORTFOLIO-CONTRACT' })),
  ];
};

const repositoryAudit = (repoRoot) => {
  const srcRoot = path.join(repoRoot, 'src');
  const dataRoot = path.join(srcRoot, 'data');
  const canonicalPath = path.join(dataRoot, 'initialState.json');
  const securityAssessmentsPath = path.join(dataRoot, 'securityAssessments.json');
  const securityPosturePolicyPath = path.join(dataRoot, 'securityPosturePolicy.json');
  const canonicalExists = fs.existsSync(canonicalPath);
  const securityAssessmentsExist = fs.existsSync(securityAssessmentsPath);
  const securityPosturePolicyExists = fs.existsSync(securityPosturePolicyPath);
  const canonical = canonicalExists
    ? JSON.parse(fs.readFileSync(canonicalPath, 'utf8'))
    : {};
  const securityAssessments = securityAssessmentsExist
    ? JSON.parse(fs.readFileSync(securityAssessmentsPath, 'utf8'))
    : {};
  const securityPosturePolicy = securityPosturePolicyExists
    ? JSON.parse(fs.readFileSync(securityPosturePolicyPath, 'utf8'))
    : {};
  const documents = readSourceDocuments(srcRoot);
  const catalog = resourceCatalogOf(canonical);
  const sites = canonical?.presentation?.nexus?.presences ?? [];
  const app = require(path.join(srcRoot, 'api.js'));
  const resources = Array.isArray(catalog?.resources) ? catalog.resources : [];
  const projectedEstates = projectEstateObservatory(sites)({
    observatory: { properties: [] },
    presence: { channels: [] },
  }).estates;
  return {
    catalog,
    documents,
    issues: [
      ...when(!canonicalExists)(
        report(relativeUnix(repoRoot)(canonicalPath))('canonical authored JSON is missing')
      ),
      ...when(!securityAssessmentsExist)(
        postureReport(relativeUnix(repoRoot)(securityAssessmentsPath))(
          'sanitized security assessment JSON is missing'
        )
      ),
      ...when(!securityPosturePolicyExists)(
        postureReport(relativeUnix(repoRoot)(securityPosturePolicyPath))(
          'security posture policy JSON is missing'
        )
      ),
      ...when(canonical === null || Array.isArray(canonical) || typeof canonical !== 'object')(
        report(relativeUnix(repoRoot)(canonicalPath))('canonical authored JSON must be an object')
      ),
      ...jsonLocationIssues(srcRoot, dataRoot),
      ...mirroredLiteralIssues(canonical, documents),
      ...embeddedCopyIssues(documents),
      ...catalogSchemaIssues(catalog),
      ...siteCatalogIssues(sites),
      ...manifestDefinitionIssues({
        definition: canonical?.presentation?.runtime?.agentManifest,
        resourceCatalog: catalog,
      }).map((detail) =>
        manifestReport('presentation.runtime.agentManifest')(detail)
      ),
      ...securityPostureDefinitionIssues({
        sites,
        definition: canonical?.presentation?.runtime?.securityPosture,
      }).map((detail) =>
        postureReport('presentation.runtime.securityPosture')(detail)
      ),
      ...securityAssessmentIssues(securityAssessments).map((detail) =>
        postureReport('src/data/securityAssessments.json')(detail)
      ),
      ...securityPosturePolicyIssues(securityPosturePolicy).map((detail) =>
        postureReport('src/data/securityPosturePolicy.json')(detail)
      ),
      ...when(JSON.stringify(SECURITY_POSTURE_POLICY) !==
        JSON.stringify(securityPosturePolicy))(
        postureReport('src/components/securityPosturePolicy.js')(
          'runtime posture policy must equal the JSON authority'
        )
      ),
      ...when(PASSIVE_SECURITY_POSTURE_POLICY !== SECURITY_POSTURE_POLICY.passive)(
        postureReport('src/components/securityPosturePolicy.js')(
          'passive policy must be a direct JSON projection'
        )
      ),
      ...when(AUTHORIZED_ASSESSMENT_POLICY !== SECURITY_POSTURE_POLICY.assessment)(
        postureReport('src/components/securityPosturePolicy.js')(
          'assessment policy must be a direct JSON projection'
        )
      ),
      ...when(AUTHORIZED_DAST_TARGETS !==
        SECURITY_POSTURE_POLICY.assessment.authorizedTargets)(
        postureReport('src/components/securityPosturePolicy.js')(
          'authorized targets must be a direct JSON projection'
        )
      ),
      ...instrumentationParityIssues(sites),
      ...estateParityIssues(sites, projectedEstates),
      ...compareRouteSets('API Express implementation')(
        resources,
        implementedRoutesOf(app)
      ),
    ],
  };
};

const argumentAfter = (flag) => (args) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};

const formatIssues = (issues) =>
  issues.length === 0
    ? '[data-authority] API src, authored JSON, site catalog, and route catalog are coherent'
    : [
        `[data-authority] ${issues.length} violation(s)`,
        ...issues.map(({ code, location, detail }) => `- ${code} ${location}: ${detail}`),
      ].join('\n');

const runCli = () => {
  const repoRoot = path.resolve(__dirname, '..');
  const audit = repositoryAudit(repoRoot);
  const portfolioRoot = pipe(
    process.argv.slice(2),
    argumentAfter('--portfolio-root'),
    fromNullable
  );
  const portfolioIssues = match(
    portfolioRoot,
    (root) => portfolioContractIssues(audit.catalog, path.resolve(repoRoot, root)),
    () => []
  );
  const issues = [...audit.issues, ...portfolioIssues];
  console.log(formatIssues(issues));
  process.exitCode = issues.length === 0 ? 0 : 1;
};

require.main === module && runCli();

module.exports = {
  catalogSchemaIssues,
  compareRouteSets,
  embeddedCopyIssues,
  estateParityIssues,
  implementedRoutesOf,
  manifestDefinitionIssues,
  mirroredLiteralIssues,
  parsePortfolioEndpoints,
  portfolioContractIssues,
  repositoryAudit,
  resourceCatalogOf,
  securityAssessmentIssues,
  securityPostureDefinitionIssues,
  securityPosturePolicyIssues,
  siteCatalogIssues,
};
