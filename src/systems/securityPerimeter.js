const { randomUUID } = require('node:crypto');

const { allPass } = require('functional-programming-composition');

const { PERMISSIONS_POLICY } = require('../components/securityPolicy');

const controlCharacter = /[\u0000-\u001f\u007f]/u;
const canonicalRequestPath = /^\/[A-Za-z0-9._~/-]*$/u;
const requestIdShape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const supportedContentType = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

const decision = (tag, status, error, event) =>
  Object.freeze({ tag, status, error, event });

const allowed = Object.freeze({ tag: 'allowed' });

const decodedTargetIsValid = (target) => {
  try {
    const decoded = decodeURI(target);
    return !controlCharacter.test(decoded) && !decoded.includes('\\');
  } catch {
    return false;
  }
};

const requestPathIsValid = (target) => {
  const [requestPath = ''] = target.split('?');
  const pathSegments = requestPath.split('/');
  return canonicalRequestPath.test(requestPath) &&
    !requestPath.includes('//') &&
    pathSegments.every((segment) => !['.', '..'].includes(segment));
};

const parseHost = (rawHost) => {
  const candidate = typeof rawHost === 'string' ? rawHost.trim() : '';
  const source = `http://${candidate}`;
  const parsed = candidate !== '' && URL.canParse(source) ? new URL(source) : null;
  const canonicalAuthority = parsed
    ? `${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}`
    : '';
  const hasAuthorityShape = Boolean(
    parsed &&
      candidate.toLowerCase() === canonicalAuthority &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      !controlCharacter.test(candidate)
  );

  return hasAuthorityShape
    ? {
        tag: 'valid',
        hostname: parsed.hostname.toLowerCase(),
        port: parsed.port,
      }
    : { tag: 'invalid' };
};

const isVercelPreviewHost = (hostname) =>
  hostname.endsWith('.vercel.app') && hostname !== 'vercel.app';

const authorityDecision = (policy) => (rawHost) => {
  const parsed = parseHost(rawHost);
  const exactHost = parsed.tag === 'valid' && policy.allowedHosts.includes(parsed.hostname);
  const previewHost = parsed.tag === 'valid' &&
    policy.allowVercelPreviews &&
    isVercelPreviewHost(parsed.hostname);

  return exactHost || previewHost
    ? allowed
    : decision('rejected', 421, 'Misdirected Request', 'authority_rejected');
};

const requestTargetDecision = (maxBytes) => (rawTarget) => {
  const target = typeof rawTarget === 'string' ? rawTarget : '';
  const targetShapeIsValid = allPass([
    (value) => value.startsWith('/'),
    (value) => !value.startsWith('//'),
    (value) => !value.includes('\\'),
    (value) => !value.includes('#'),
    (value) => !controlCharacter.test(value),
    requestPathIsValid,
    decodedTargetIsValid,
  ])(target);
  const withinBound = Buffer.byteLength(target, 'utf8') <= maxBytes;

  return targetShapeIsValid && withinBound
    ? allowed
    : decision('rejected', 400, 'Bad Request', 'request_target_rejected');
};

const qualityFrom = (parameters) => {
  const qualityParameter = parameters
    .map((parameter) => parameter.trim().toLowerCase())
    .find((parameter) => parameter.startsWith('q='));
  const quality = qualityParameter === undefined
    ? 1
    : Number(qualityParameter.slice(2));

  return Number.isFinite(quality) && quality > 0 && quality <= 1
    ? quality
    : 0;
};

const mediaRangeAcceptsJson = (entry) => {
  const [rawRange = '', ...parameters] = entry.split(';');
  const range = rawRange.trim().toLowerCase();
  const supportedRange = ['*/*', 'application/*', 'application/json'].includes(range);

  return supportedRange && qualityFrom(parameters) > 0;
};

const acceptDecision = (rawAccept) => {
  const accept = typeof rawAccept === 'string' ? rawAccept.trim() : '';
  const acceptsJson = accept === '' || accept.split(',').some(mediaRangeAcceptsJson);

  return acceptsJson
    ? allowed
    : decision('rejected', 406, 'Not Acceptable', 'accept_rejected');
};

const contentTypeDecision = (rawContentType) => {
  const contentType = typeof rawContentType === 'string' ? rawContentType.trim() : '';
  const acceptsContent = contentType === '' || supportedContentType.test(contentType);

  return acceptsContent
    ? allowed
    : decision('rejected', 415, 'Unsupported Media Type', 'content_type_rejected');
};

const representationDecision = ({ accept, contentType }) =>
  [acceptDecision(accept), contentTypeDecision(contentType)]
    .find((candidate) => candidate.tag === 'rejected') ?? allowed;

const originAdmissionDecision = (decideOrigin) => (rawOrigin) =>
  decideOrigin(rawOrigin).tag === 'allowed'
    ? allowed
    : decision('rejected', 403, 'Forbidden', 'origin_rejected');

const requestIdDecision = (createRequestId) => {
  try {
    const requestId = createRequestId();
    return typeof requestId === 'string' && requestIdShape.test(requestId)
      ? { tag: 'allowed', requestId }
      : decision('rejected', 503, 'Service Unavailable', 'request_id_unavailable');
  } catch {
    return decision('rejected', 503, 'Service Unavailable', 'request_id_unavailable');
  }
};

const auditRejection = (logger) => (event, requestId) => {
  const write = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : () => undefined;
  try {
    write('Security perimeter rejection', Object.freeze({ event, requestId }));
  } catch {
    return undefined;
  }
  return undefined;
};

const sendPerimeterError = (res, rejected) =>
  res
    .set('Cache-Control', 'no-store, max-age=0')
    .status(rejected.status)
    .json({ error: rejected.error });

const createPerimeterContextMiddleware = ({
  createRequestId = randomUUID,
  logger = console,
} = {}) => (req, res, next) => {
  const requestId = requestIdDecision(createRequestId);
  res.set({
    'CDN-Cache-Control': 'no-store',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Vercel-CDN-Cache-Control': 'no-store',
  });

  return requestId.tag === 'allowed'
    ? (() => {
        res.locals.securityRequestId = requestId.requestId;
        res.set('X-Request-ID', requestId.requestId);
        return next();
      })()
    : (() => {
        auditRejection(logger)(requestId.event, null);
        return sendPerimeterError(res, requestId);
      })();
};

const createDecisionMiddleware = (decide, logger) => (req, res, next) => {
  const result = decide(req);

  return result.tag === 'allowed'
    ? next()
    : (() => {
        auditRejection(logger)(result.event, res.locals.securityRequestId ?? null);
        return sendPerimeterError(res, result);
      })();
};

const createOriginPerimeterMiddleware = ({ decideOrigin, logger = console }) =>
  createDecisionMiddleware(
    (req) => originAdmissionDecision(decideOrigin)(req.get('origin')),
    logger
  );

const createRequestPerimeterMiddleware = ({ policy, logger = console }) => [
  createDecisionMiddleware(
    (req) => authorityDecision(policy.hosts)(req.get('host')),
    logger
  ),
  createDecisionMiddleware(
    (req) => requestTargetDecision(policy.maxRequestTargetBytes)(req.originalUrl),
    logger
  ),
  createDecisionMiddleware(
    (req) => representationDecision({
      accept: req.get('accept'),
      contentType: req.get('content-type'),
    }),
    logger
  ),
];

module.exports = {
  acceptDecision,
  authorityDecision,
  contentTypeDecision,
  createOriginPerimeterMiddleware,
  createPerimeterContextMiddleware,
  createRequestPerimeterMiddleware,
  originAdmissionDecision,
  parseHost,
  representationDecision,
  requestIdDecision,
  requestTargetDecision,
};
