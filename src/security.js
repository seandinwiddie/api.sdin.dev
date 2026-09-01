const cors = require('cors');
const helmet = require('helmet');
const net = require('node:net');
const {
  allPass,
  ap,
  failure,
  success,
} = require('functional-programming-composition');

const {
  ALLOWED_METHODS,
  CORS_EXPOSED_HEADERS,
  CORS_REQUEST_HEADERS,
  DEFAULT_SECURITY_POLICY,
  HELMET_OPTIONS,
  LOCAL_DEVELOPMENT_HOSTS,
  REQUIRED_HOSTS,
  REQUIRED_ORIGINS,
} = require('./components/securityPolicy');
const { createRateLimitStore } = require('./entities/rateLimitStore');
const {
  createOriginPerimeterMiddleware,
  createPerimeterContextMiddleware,
  createRequestPerimeterMiddleware,
  parseHost,
} = require('./systems/securityPerimeter');

const allowedMethodSet = new Set(ALLOWED_METHODS);
const allowHeader = ALLOWED_METHODS.join(', ');
const numericText = /^(?:0|[1-9]\d*)$/;

const commaSeparated = (value) =>
  String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const parseOrigin = (rawOrigin) => {
  const isString = typeof rawOrigin === 'string';
  const parsed = isString && URL.canParse(rawOrigin) ? new URL(rawOrigin) : null;
  const canonical = parsed?.origin;
  const supportedProtocol = ['http:', 'https:'].includes(parsed?.protocol);
  const hasOriginShape = Boolean(
    parsed &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      canonical === rawOrigin
  );

  return supportedProtocol && hasOriginShape
    ? {
        tag: 'valid',
        origin: canonical,
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
      }
    : { tag: 'invalid' };
};

const isLocalDevelopmentOrigin = (parsed) =>
  parsed.tag === 'valid' &&
  ['http:', 'https:'].includes(parsed.protocol) &&
  LOCAL_DEVELOPMENT_HOSTS.includes(parsed.hostname);

const isConfigured = (value) =>
  value !== undefined && value !== null && String(value).trim() !== '';

const configuredValue = (primary) => (secondary) =>
  isConfigured(primary) ? primary : secondary;

const validValue = (name) => (predicate) => (value) =>
  predicate(value) ? success(value) : failure(name);

const positiveIntegerValidation = (name) => (value) => (fallback) => {
  const candidate = isConfigured(value) ? Number(value) : fallback;
  return validValue(name)(
    (parsed) => Number.isSafeInteger(parsed) && parsed > 0
  )(candidate);
};

const booleanValidation = (name) => (value) => (fallback) => {
  const normalized = isConfigured(value)
    ? String(value).trim().toLowerCase()
    : String(fallback);
  const values = Object.freeze({
    true: true,
    '1': true,
    yes: true,
    false: false,
    '0': false,
    no: false,
  });

  return Object.hasOwn(values, normalized)
    ? success(values[normalized])
    : failure(name);
};

const clientIpSourceValidation = (value) => {
  const candidate = isConfigured(value)
    ? String(value).trim().toLowerCase()
    : DEFAULT_SECURITY_POLICY.clientIpSource;

  return validValue('API_CLIENT_IP_SOURCE')(
    (source) => ['socket', 'vercel'].includes(source)
  )(candidate);
};

const listValue = (value, fallback = []) =>
  value === undefined
    ? fallback
    : Array.isArray(value)
      ? value
      : null;

const configuredOriginsValidation = (envValue) => (optionValue) => {
  const optionOrigins = listValue(optionValue);
  const origins = optionOrigins === null
    ? []
    : [
        ...REQUIRED_ORIGINS,
        ...commaSeparated(envValue),
        ...optionOrigins,
      ];
  const parsed = origins.map(parseOrigin);
  const valid = optionOrigins !== null && parsed.every((origin) => origin.tag === 'valid');

  return valid
    ? success(Object.freeze([...new Set(parsed.map((origin) => origin.origin))]))
    : failure('API_CORS_ORIGINS');
};

const configuredHostsValidation = (envValue) => (optionValue) => {
  const optionHosts = listValue(optionValue);
  const hosts = optionHosts === null
    ? []
    : [
        ...REQUIRED_HOSTS,
        ...LOCAL_DEVELOPMENT_HOSTS,
        ...commaSeparated(envValue),
        ...optionHosts,
      ];
  const parsed = hosts.map(parseHost);
  const valid = optionHosts !== null && parsed.every((host) => host.tag === 'valid');

  return valid
    ? success(Object.freeze([...new Set(parsed.map((host) => host.hostname))]))
    : failure('API_ALLOWED_HOSTS');
};

const appendValidatedEntry = (validatedRecord, [key, validatedValue]) =>
  ap(
    ap(
      success((record) => (value) => Object.freeze({ ...record, [key]: value })),
      validatedRecord
    ),
    validatedValue
  );

const collectValidations = (entries) =>
  entries.reduce(appendValidatedEntry, success(Object.freeze({})));

const securityValuesValidationFrom = (options) => {
  const env = options.env ?? process.env;
  const corsOptions = options.cors ?? {};
  const hostOptions = options.hosts ?? {};
  const rateLimitOptions = options.rateLimit ?? {};

  return collectValidations([
    ['clientIpSource', clientIpSourceValidation(
      configuredValue(options.clientIpSource)(env.API_CLIENT_IP_SOURCE)
    )],
    ['allowPublicRead', booleanValidation('API_CORS_PUBLIC_READ')(
      configuredValue(corsOptions.allowPublicRead)(env.API_CORS_PUBLIC_READ)
    )(DEFAULT_SECURITY_POLICY.cors.allowPublicRead)],
    ['allowedOrigins', configuredOriginsValidation(env.API_CORS_ORIGINS)(
      corsOptions.allowedOrigins
    )],
    ['corsMaxAgeSeconds', positiveIntegerValidation('API_CORS_MAX_AGE_SECONDS')(
      configuredValue(corsOptions.maxAgeSeconds)(env.API_CORS_MAX_AGE_SECONDS)
    )(DEFAULT_SECURITY_POLICY.cors.maxAgeSeconds)],
    ['allowedHosts', configuredHostsValidation(env.API_ALLOWED_HOSTS)(
      hostOptions.allowedHosts
    )],
    ['allowVercelPreviews', booleanValidation('API_ALLOW_VERCEL_PREVIEWS')(
      configuredValue(hostOptions.allowVercelPreviews)(env.API_ALLOW_VERCEL_PREVIEWS)
    )(DEFAULT_SECURITY_POLICY.hosts.allowVercelPreviews)],
    ['maxRequestBytes', positiveIntegerValidation('API_MAX_REQUEST_BYTES')(
      configuredValue(options.maxRequestBytes)(env.API_MAX_REQUEST_BYTES)
    )(DEFAULT_SECURITY_POLICY.maxRequestBytes)],
    ['maxRequestTargetBytes', positiveIntegerValidation('API_MAX_REQUEST_TARGET_BYTES')(
      configuredValue(options.maxRequestTargetBytes)(env.API_MAX_REQUEST_TARGET_BYTES)
    )(DEFAULT_SECURITY_POLICY.maxRequestTargetBytes)],
    ['rateLimit', positiveIntegerValidation('API_RATE_LIMIT_MAX')(
      configuredValue(rateLimitOptions.limit)(env.API_RATE_LIMIT_MAX)
    )(DEFAULT_SECURITY_POLICY.rateLimit.limit)],
    ['rateWindowMs', positiveIntegerValidation('API_RATE_LIMIT_WINDOW_MS')(
      configuredValue(rateLimitOptions.windowMs)(env.API_RATE_LIMIT_WINDOW_MS)
    )(DEFAULT_SECURITY_POLICY.rateLimit.windowMs)],
    ['rateMaxClients', positiveIntegerValidation('API_RATE_LIMIT_MAX_CLIENTS')(
      configuredValue(rateLimitOptions.maxClients)(env.API_RATE_LIMIT_MAX_CLIENTS)
    )(DEFAULT_SECURITY_POLICY.rateLimit.maxClients)],
  ]);
};

const policyFromValues = (values) => Object.freeze({
  clientIpSource: values.clientIpSource,
  cors: Object.freeze({
    allowPublicRead: values.allowPublicRead,
    allowedOrigins: values.allowedOrigins,
    maxAgeSeconds: values.corsMaxAgeSeconds,
  }),
  hosts: Object.freeze({
    allowedHosts: values.allowedHosts,
    allowVercelPreviews: values.allowVercelPreviews,
  }),
  maxRequestBytes: values.maxRequestBytes,
  maxRequestTargetBytes: values.maxRequestTargetBytes,
  rateLimit: Object.freeze({
    limit: values.rateLimit,
    windowMs: values.rateWindowMs,
    maxClients: values.rateMaxClients,
  }),
});

const requireValidSecurityValues = (validation) =>
  validation._tag === 'Success'
    ? validation.value
    : (() => {
        throw new Error(
          `Invalid security configuration: ${[...new Set(validation.errors)].join(', ')}`
        );
      })();

const securityPolicyFrom = (options = {}) => {
  const values = requireValidSecurityValues(securityValuesValidationFrom(options));
  return policyFromValues(values);
};

const originDecision = (policy) => (rawOrigin) => {
  const nativeClient = rawOrigin === undefined || rawOrigin === null;
  const parsed = nativeClient ? { tag: 'native' } : parseOrigin(rawOrigin);
  const explicitlyAllowed = parsed.tag === 'valid' && policy.allowedOrigins.includes(parsed.origin);
  const allowed = nativeClient || (
    parsed.tag === 'valid' &&
    (policy.allowPublicRead || explicitlyAllowed || isLocalDevelopmentOrigin(parsed))
  );

  return {
    tag: allowed ? 'allowed' : 'denied',
    corsOrigin: allowed && policy.allowPublicRead ? '*' : allowed && !nativeClient ? rawOrigin : false,
  };
};

const methodDecision = (method, preflightMethod) => {
  const normalized = String(method ?? '').toUpperCase();
  const requested = String(preflightMethod ?? '').toUpperCase();
  const methodAllowed = allowedMethodSet.has(normalized);
  const preflightAllowed = normalized !== 'OPTIONS' || requested === '' || allowedMethodSet.has(requested);
  return methodAllowed && preflightAllowed
    ? { tag: 'allowed' }
    : { tag: 'rejected', status: 405, error: 'Method Not Allowed' };
};

const requestSizeDecision = (maxBytes) => ({ contentLength, transferEncoding }) => {
  const hasTransferEncoding = String(transferEncoding ?? '').trim() !== '';
  const rawLength = contentLength === undefined ? '0' : String(contentLength).trim();
  const validLength = numericText.test(rawLength) && Number.isSafeInteger(Number(rawLength));
  const bytes = validLength ? Number(rawLength) : null;
  const decisions = [
    { when: () => hasTransferEncoding, value: { tag: 'oversized', status: 413, error: 'Payload Too Large' } },
    { when: () => !validLength, value: { tag: 'invalid', status: 400, error: 'Bad Request' } },
    { when: () => bytes > maxBytes, value: { tag: 'oversized', status: 413, error: 'Payload Too Large' } },
    { when: () => true, value: { tag: 'allowed', bytes } },
  ];
  return decisions.find((decision) => decision.when()).value;
};

const rateLimitHeaders = (policy) => (now) => (decision) => {
  const windowSeconds = Math.ceil(policy.windowMs / 1000);
  const resetSeconds = Math.max(0, Math.ceil((decision.resetAt - now) / 1000));
  return {
    'RateLimit-Policy': `${policy.limit};w=${windowSeconds}`,
    'RateLimit-Limit': String(policy.limit),
    'RateLimit-Remaining': String(decision.remaining),
    'RateLimit-Reset': String(resetSeconds),
  };
};

const rateLimitDecisionIsValid = (policy) => allPass([
  (value) => value !== null && typeof value === 'object',
  (value) => typeof value.allowed === 'boolean',
  (value) => Number.isSafeInteger(value.observedAt) && value.observedAt >= 0,
  (value) => Number.isSafeInteger(value.remaining) && value.remaining >= 0,
  (value) => value.remaining <= policy.limit,
  (value) => Number.isSafeInteger(value.resetAt),
  (value) => value.resetAt > value.observedAt,
]);

const corsOptionsFrom = (policy) => ({
  origin: (origin, callback) => callback(null, originDecision(policy)(origin).corsOrigin),
  methods: ALLOWED_METHODS,
  allowedHeaders: CORS_REQUEST_HEADERS,
  exposedHeaders: CORS_EXPOSED_HEADERS,
  maxAge: policy.maxAgeSeconds,
  credentials: false,
  optionsSuccessStatus: 204,
  preflightContinue: true,
});

const varyOrigin = (req, res, next) => {
  res.vary('Origin');
  next();
};

const sendPolicyError = (res, decision, extra = {}) =>
  res
    .set('Cache-Control', 'no-store, max-age=0')
    .status(decision.status)
    .json({ error: decision.error, ...extra });

const createMethodMiddleware = () => (req, res, next) => {
  const decision = methodDecision(req.method, req.get('access-control-request-method'));
  return decision.tag === 'allowed'
    ? next()
    : sendPolicyError(res.set('Allow', allowHeader), decision, { allowedMethods: ALLOWED_METHODS });
};

const createRequestSizeMiddleware = (maxBytes) => (req, res, next) => {
  const decision = requestSizeDecision(maxBytes)({
    contentLength: req.get('content-length'),
    transferEncoding: req.get('transfer-encoding'),
  });
  return decision.tag === 'allowed'
    ? next()
    : sendPolicyError(res, decision, decision.tag === 'oversized' ? { limitBytes: maxBytes } : {});
};

const finishOptions = (req, res, next) =>
  req.method === 'OPTIONS'
    ? res.set('Allow', allowHeader).status(204).end()
    : next();

const socketClientKey = (req) => `socket:${req.socket?.remoteAddress || 'unknown'}`;

const singleIp = (value) => {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return !candidate.includes(',') && net.isIP(candidate) !== 0 ? candidate : null;
};

const clientKeyFrom = (source) => (req) => {
  const vercelIp = source === 'vercel'
    ? singleIp(req.get('x-vercel-forwarded-for'))
    : null;
  return vercelIp ? `vercel:${vercelIp}` : socketClientKey(req);
};

const createRateLimitMiddleware = ({ store, clientKey, policy, logger = console }) => {
  const admit = (req, res, next) => {
    try {
      const decision = store.consume(String(clientKey(req)));
      const decisionIsValid = rateLimitDecisionIsValid(policy)(decision);
      const admittedDecision = decisionIsValid
        ? decision
        : (() => {
            throw new Error('Invalid rate-limit decision');
          })();

      Object.entries(rateLimitHeaders(policy)(admittedDecision.observedAt)(admittedDecision)).forEach(
        ([name, value]) => res.set(name, value)
      );

      return admittedDecision.allowed
        ? next()
        : sendPolicyError(
            res.set('Retry-After', String(Math.max(1, Math.ceil(
              (admittedDecision.resetAt - admittedDecision.observedAt) / 1000
            )))),
            { status: 429, error: 'Too Many Requests' },
            { retryAfterSeconds: Math.max(1, Math.ceil(
              (admittedDecision.resetAt - admittedDecision.observedAt) / 1000
            )) }
          );
    } catch {
      const write = typeof logger?.warn === 'function'
        ? logger.warn.bind(logger)
        : () => undefined;
      try {
        write('Security state unavailable', Object.freeze({
          event: 'rate_limit_state_unavailable',
          requestId: res.locals.securityRequestId ?? null,
        }));
      } catch {
        // Logging is deliberately weaker than the fail-closed HTTP decision.
      }
      return sendPolicyError(res, { status: 503, error: 'Service Unavailable' });
    }
  };

  return admit;
};

/** Composes pure policies with the HTTP and process-local state boundaries. */
const createSecurityMiddleware = (options = {}) => {
  const policy = securityPolicyFrom(options);
  const now = options.now ?? Date.now;
  const store = options.rateLimitStore ?? createRateLimitStore(now)(policy.rateLimit);
  const clientKey = options.clientKey ?? clientKeyFrom(policy.clientIpSource);
  const logger = options.logger ?? console;
  const decideOrigin = originDecision(policy.cors);

  return [
    helmet(HELMET_OPTIONS),
    createPerimeterContextMiddleware({
      createRequestId: options.createRequestId,
      logger,
    }),
    varyOrigin,
    cors(corsOptionsFrom(policy.cors)),
    createRateLimitMiddleware({ store, clientKey, policy: policy.rateLimit, logger }),
    createOriginPerimeterMiddleware({ decideOrigin, logger }),
    ...createRequestPerimeterMiddleware({ policy, logger }),
    createRequestSizeMiddleware(policy.maxRequestBytes),
    createMethodMiddleware(),
    finishOptions,
  ];
};

module.exports = {
  clientKeyFrom,
  createSecurityMiddleware,
  methodDecision,
  originDecision,
  parseOrigin,
  rateLimitHeaders,
  requestSizeDecision,
  rateLimitDecisionIsValid,
  securityValuesValidationFrom,
  securityPolicyFrom,
  singleIp,
};
