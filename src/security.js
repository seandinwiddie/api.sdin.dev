const cors = require('cors');
const helmet = require('helmet');
const net = require('node:net');

const {
  ALLOWED_METHODS,
  CORS_EXPOSED_HEADERS,
  CORS_REQUEST_HEADERS,
  DEFAULT_SECURITY_POLICY,
  HELMET_OPTIONS,
  LOCAL_DEVELOPMENT_HOSTS,
  REQUIRED_ORIGINS,
} = require('./components/securityPolicy');
const { createRateLimitStore } = require('./entities/rateLimitStore');

const allowedMethodSet = new Set(ALLOWED_METHODS);
const allowHeader = ALLOWED_METHODS.join(', ');
const numericText = /^(?:0|[1-9]\d*)$/;

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const booleanValue = (value, fallback) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  const values = { true: true, '1': true, yes: true, false: false, '0': false, no: false };
  return Object.hasOwn(values, normalized) ? values[normalized] : fallback;
};

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

const uniqueValidOrigins = (origins) =>
  [...new Set(origins)]
    .map(parseOrigin)
    .filter((parsed) => parsed.tag === 'valid')
    .map((parsed) => parsed.origin);

const securityPolicyFrom = (options = {}) => {
  const env = options.env ?? process.env;
  const corsOptions = options.cors ?? {};
  const rateLimitOptions = options.rateLimit ?? {};
  const configuredOrigins = uniqueValidOrigins([
    ...REQUIRED_ORIGINS,
    ...commaSeparated(env.API_CORS_ORIGINS),
    ...(corsOptions.allowedOrigins ?? []),
  ]);

  return Object.freeze({
    clientIpSource: (options.clientIpSource ?? env.API_CLIENT_IP_SOURCE) === 'vercel'
      ? 'vercel'
      : DEFAULT_SECURITY_POLICY.clientIpSource,
    cors: Object.freeze({
      allowPublicRead: corsOptions.allowPublicRead ?? booleanValue(
        env.API_CORS_PUBLIC_READ,
        DEFAULT_SECURITY_POLICY.cors.allowPublicRead
      ),
      allowedOrigins: Object.freeze(configuredOrigins),
      maxAgeSeconds: positiveInteger(
        corsOptions.maxAgeSeconds,
        DEFAULT_SECURITY_POLICY.cors.maxAgeSeconds
      ),
    }),
    maxRequestBytes: positiveInteger(
      options.maxRequestBytes ?? env.API_MAX_REQUEST_BYTES,
      DEFAULT_SECURITY_POLICY.maxRequestBytes
    ),
    rateLimit: Object.freeze({
      limit: positiveInteger(
        rateLimitOptions.limit ?? env.API_RATE_LIMIT_MAX,
        DEFAULT_SECURITY_POLICY.rateLimit.limit
      ),
      windowMs: positiveInteger(
        rateLimitOptions.windowMs ?? env.API_RATE_LIMIT_WINDOW_MS,
        DEFAULT_SECURITY_POLICY.rateLimit.windowMs
      ),
      maxClients: positiveInteger(
        rateLimitOptions.maxClients ?? env.API_RATE_LIMIT_MAX_CLIENTS,
        DEFAULT_SECURITY_POLICY.rateLimit.maxClients
      ),
    }),
  });
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

const rateLimitTransition = (policy) => (now) => (history) => {
  const activeHistory = history.filter((timestamp) => now - timestamp < policy.windowMs);
  const allowed = activeHistory.length < policy.limit;
  const nextHistory = allowed ? [...activeHistory, now] : activeHistory;
  const resetAt = (nextHistory[0] ?? now) + policy.windowMs;

  return {
    allowed,
    history: nextHistory,
    observedAt: now,
    remaining: Math.max(0, policy.limit - nextHistory.length),
    resetAt,
  };
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

const createRateLimitMiddleware = ({ store, clientKey, policy }) => {
  const admit = (req, res, next) => {
    try {
      const decision = store.consume(String(clientKey(req)));
      Object.entries(rateLimitHeaders(policy)(decision.observedAt)(decision))
        .forEach(([name, value]) => res.set(name, value));

      return decision.allowed
        ? next()
        : sendPolicyError(
            res.set('Retry-After', String(Math.max(1, Math.ceil((decision.resetAt - decision.observedAt) / 1000)))),
            { status: 429, error: 'Too Many Requests' },
            { retryAfterSeconds: Math.max(1, Math.ceil((decision.resetAt - decision.observedAt) / 1000)) }
          );
    } catch {
      return sendPolicyError(res, { status: 503, error: 'Service Unavailable' });
    }
  };

  return (req, res, next) => req.method === 'OPTIONS' ? next() : admit(req, res, next);
};

/** Composes pure policies with the HTTP and process-local state boundaries. */
const createSecurityMiddleware = (options = {}) => {
  const policy = securityPolicyFrom(options);
  const now = options.now ?? Date.now;
  const transition = rateLimitTransition(policy.rateLimit);
  const store = options.rateLimitStore ?? createRateLimitStore(now)(transition)(policy.rateLimit.maxClients);
  const clientKey = options.clientKey ?? clientKeyFrom(policy.clientIpSource);

  return [
    helmet(HELMET_OPTIONS),
    varyOrigin,
    cors(corsOptionsFrom(policy.cors)),
    createRateLimitMiddleware({ store, clientKey, policy: policy.rateLimit }),
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
  rateLimitTransition,
  requestSizeDecision,
  securityPolicyFrom,
  singleIp,
};
