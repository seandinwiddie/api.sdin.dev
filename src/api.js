const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { getProfile, getRepos, getActivity, getContributions, getSummary } = require('./github');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());

// Read the initial state JSON file. A malformed or missing file used to throw at
// module load, which on Vercel surfaces as an opaque 500 on every route with no
// indication of the cause.
const initialStateFile = path.join(__dirname, 'data', 'initialState.json');

let initialState;
try {
  initialState = JSON.parse(fs.readFileSync(initialStateFile, 'utf8'));
} catch (error) {
  console.error(`Failed to load ${initialStateFile}:`, error.message);
  throw new Error(`Cannot start API: ${initialStateFile} is missing or invalid JSON`);
}

/** Authored content is static per deployment; GitHub data changes slowly. */
const cacheFor = (seconds) => (req, res, next) => {
  res.set('Cache-Control', `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=86400`);
  next();
};

app.use(cacheFor(300));

// Homepage route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the API' });
});

// Status page route
app.get('/status', (req, res) => {
  res.json({ status: 'OK' });
});

// Endpoint to fetch all data
app.get('/data', (req, res) => {
  res.json(initialState);
});

// --- Live GitHub aggregation -------------------------------------------------
// Wrapping each handler keeps the async rejection path on the JSON error handler
// instead of surfacing as an unhandled rejection (Express 4 does not await).
const jsonRoute = (load) => async (req, res, next) => {
  try {
    res.json(await load());
  } catch (error) {
    next(error);
  }
};

const githubRoutes = {
  '/github': getSummary,
  '/github/profile': getProfile,
  '/github/repos': getRepos,
  '/github/activity': getActivity,
  '/github/contributions': getContributions,
};

Object.entries(githubRoutes).forEach(([route, load]) => {
  app.get(route, cacheFor(600), jsonRoute(load));
});

// Create dynamic endpoints for each key in the initial state.
// Routes declared above win in Express, so a key colliding with one of them
// would silently never be reachable -- skip it loudly instead.
const RESERVED_PATHS = new Set(['', 'status', 'data', 'github']);

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
  ...Object.keys(githubRoutes),
  ...Object.keys(initialState)
    .filter((key) => !RESERVED_PATHS.has(key))
    .map((key) => `/${key}`),
];

// Unknown routes returned Express's default HTML error page from a JSON API,
// so clients parsing the body got a SyntaxError instead of a usable error.
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    availableEndpoints: availableEndpoints(),
  });
});

// Same for unhandled errors: JSON in, JSON out. An upstream GitHub failure is a
// 502, not a generic 500 -- it says the dependency failed, not this service.
app.use((error, req, res, next) => {
  const isUpstream = /^GitHub /.test(error.message || '');
  console.error(isUpstream ? 'Upstream GitHub failure:' : 'Unhandled error:', error);
  res.status(isUpstream ? 502 : 500).json({
    error: isUpstream ? 'Upstream Unavailable' : 'Internal Server Error',
    detail: isUpstream ? error.message : undefined,
  });
});

// Only listen when run directly (`npm start`). Under Vercel the exported app is
// invoked per-request, where binding a port is meaningless.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = app;
