const express = require('express');
const fs = require('fs');
const path = require('path');
const github = require('./github');
const { createObservatoryService } = require('./systems/observatory');
const { createPresenceService } = require('./systems/presence');
const { createSecurityMiddleware } = require('./security');
const { version } = require('../package.json');

const port = process.env.PORT || 3000;
const initialStateFile = path.join(__dirname, 'data', 'initialState.json');

let initialState;
try {
  initialState = JSON.parse(fs.readFileSync(initialStateFile, 'utf8'));
} catch (error) {
  console.error(`Failed to load ${initialStateFile}:`, error.message);
  throw new Error(`Cannot start API: ${initialStateFile} is missing or invalid JSON`);
}

const revalidatePrivately = (req, res, next) => {
  res.set('Cache-Control', 'private, no-cache, max-age=0, must-revalidate');
  next();
};

const noStoreResponse = (res) => res.set('Cache-Control', 'no-store, max-age=0');

const noStore = (req, res, next) => {
  noStoreResponse(res);
  next();
};

const jsonRoute = (load) => async (req, res, next) => {
  try {
    res.json(await load());
  } catch (error) {
    next(error);
  }
};

const presence = createPresenceService({
  targets: initialState.presentation.nexus.presences,
});
const observatory = createObservatoryService();

const RESERVED_PATHS = new Set([
  '',
  'status',
  'data',
  'github',
  'observatory',
  'presence',
]);

/** Express boundary with injectable GitHub and clock effects for deterministic tests. */
const createApp = ({
  githubService = github,
  observatoryService = observatory,
  presenceService = presence,
  logger = console,
  now = Date.now,
  securityOptions = {},
} = {}) => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(...createSecurityMiddleware(securityOptions));
  app.use(revalidatePrivately);

  app.get('/', (req, res) => {
    res.json({ message: 'api.sdin.dev ready' });
  });

  // This endpoint reports this service's readiness, not cached upstream health.
  // GitHub availability is carried by /github's resource metadata.
  app.get('/status', noStore, (req, res) => {
    res.json({
      status: 'OK',
      service: 'api.sdin.dev',
      version,
      checkedAt: new Date(now()).toISOString(),
      authoredData: {
        status: 'ready',
        keys: Object.keys(initialState).length,
      },
    });
  });

  app.get('/data', (req, res) => {
    res.json(initialState);
  });

  const githubRoutes = {
    '/github': githubService.getSummary,
    '/github/profile': githubService.getProfile,
    '/github/repos': githubService.getRepos,
    '/github/activity': githubService.getActivity,
    '/github/contributions': githubService.getContributions,
    '/github/commits': githubService.getCommits,
  };

  Object.entries(githubRoutes).forEach(([route, load]) => {
    app.get(route, jsonRoute(load));
  });

  app.get('/presence', jsonRoute(presenceService.getSummary));
  app.get('/observatory', jsonRoute(observatoryService.getSummary));

  Object.keys(initialState).forEach((key) => {
    if (RESERVED_PATHS.has(key)) {
      console.warn(`Skipping dynamic route /${key}: shadowed by a built-in route`);
      return;
    }
    app.get(`/${key}`, (req, res) => {
      res.json({ [key]: initialState[key] });
    });
  });

  const availableEndpoints = () => [
    '/',
    '/status',
    '/data',
    '/observatory',
    '/presence',
    ...Object.keys(githubRoutes),
    ...Object.keys(initialState)
      .filter((key) => !RESERVED_PATHS.has(key))
      .map((key) => `/${key}`),
  ];

  app.use((req, res) => {
    noStoreResponse(res).status(404).json({
      error: 'Not Found',
      path: req.path,
      availableEndpoints: availableEndpoints(),
    });
  });

  app.use((error, req, res, next) => {
    const isUpstream = /^GitHub /.test(error.message || '');
    logger.error(isUpstream ? 'Upstream GitHub failure:' : 'Unhandled error:', error);
    noStoreResponse(res).status(isUpstream ? 502 : 500).json({
      error: isUpstream ? 'Upstream Unavailable' : 'Internal Server Error',
    });
  });

  return app;
};

const app = createApp();

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = app;
module.exports.createApp = createApp;
