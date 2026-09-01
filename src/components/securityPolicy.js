const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);

const REQUIRED_ORIGINS = Object.freeze([
  'https://portfolio.sdin.dev',
  'https://sdin.dev',
]);

const REQUIRED_HOSTS = Object.freeze([
  'api.sdin.dev',
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
  'X-Request-ID',
]);

const PERMISSIONS_POLICY = Object.freeze([
  'accelerometer=()',
  'ambient-light-sensor=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'usb=()',
  'web-share=()',
  'xr-spatial-tracking=()',
]).join(', ');

const DEFAULT_SECURITY_POLICY = Object.freeze({
  clientIpSource: 'socket',
  cors: Object.freeze({
    allowPublicRead: true,
    maxAgeSeconds: 86_400,
  }),
  hosts: Object.freeze({
    allowVercelPreviews: true,
  }),
  maxRequestBytes: 16_384,
  maxRequestTargetBytes: 2_048,
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
  frameguard: Object.freeze({ action: 'deny' }),
  hsts: Object.freeze({
    maxAge: 31_536_000,
    includeSubDomains: true,
    preload: true,
  }),
  referrerPolicy: Object.freeze({ policy: 'no-referrer' }),
});

module.exports = {
  ALLOWED_METHODS,
  CORS_EXPOSED_HEADERS,
  CORS_REQUEST_HEADERS,
  DEFAULT_SECURITY_POLICY,
  HELMET_OPTIONS,
  LOCAL_DEVELOPMENT_HOSTS,
  PERMISSIONS_POLICY,
  REQUIRED_HOSTS,
  REQUIRED_ORIGINS,
};
