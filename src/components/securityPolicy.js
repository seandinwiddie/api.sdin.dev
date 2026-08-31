const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);

const REQUIRED_ORIGINS = Object.freeze([
  'https://portfolio.sdin.dev',
  'https://sdin.dev',
]);

const LOCAL_DEVELOPMENT_HOSTS = Object.freeze([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

const CORS_REQUEST_HEADERS = Object.freeze([
  'Accept',
  'Content-Type',
  'If-None-Match',
]);

const CORS_EXPOSED_HEADERS = Object.freeze([
  'Cache-Control',
  'ETag',
  'RateLimit-Policy',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
]);

const DEFAULT_SECURITY_POLICY = Object.freeze({
  clientIpSource: 'socket',
  cors: Object.freeze({
    allowPublicRead: true,
    maxAgeSeconds: 86_400,
  }),
  maxRequestBytes: 16_384,
  rateLimit: Object.freeze({
    limit: 120,
    windowMs: 60_000,
    maxClients: 10_000,
  }),
});

const HELMET_OPTIONS = Object.freeze({
  contentSecurityPolicy: Object.freeze({
    useDefaults: false,
    directives: Object.freeze({
      defaultSrc: Object.freeze(["'none'"]),
      baseUri: Object.freeze(["'none'"]),
      formAction: Object.freeze(["'none'"]),
      frameAncestors: Object.freeze(["'none'"]),
    }),
  }),
  crossOriginResourcePolicy: Object.freeze({ policy: 'cross-origin' }),
});

module.exports = {
  ALLOWED_METHODS,
  CORS_EXPOSED_HEADERS,
  CORS_REQUEST_HEADERS,
  DEFAULT_SECURITY_POLICY,
  HELMET_OPTIONS,
  LOCAL_DEVELOPMENT_HOSTS,
  REQUIRED_ORIGINS,
};
