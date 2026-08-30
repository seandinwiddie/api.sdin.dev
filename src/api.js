const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

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

// The payload is static per deployment, so let the CDN serve it rather than
// invoking the function for every request.
app.use((req, res, next) => {
  res.set('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400');
  next();
});

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

// Create dynamic endpoints for each key in the initial state.
// Routes declared above win in Express, so a key colliding with one of them
// would silently never be reachable -- skip it loudly instead.
const RESERVED_PATHS = new Set(['', 'status', 'data']);

Object.keys(initialState).forEach((key) => {
  if (RESERVED_PATHS.has(key)) {
    console.warn(`Skipping dynamic route /${key}: shadowed by a built-in route`);
    return;
  }
  app.get(`/${key}`, (req, res) => {
    res.json({ [key]: initialState[key] });
  });
});

// Unknown routes returned Express's default HTML error page from a JSON API,
// so clients parsing the body got a SyntaxError instead of a usable error.
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    availableEndpoints: ['/', '/status', '/data', ...Object.keys(initialState)
      .filter((k) => !RESERVED_PATHS.has(k))
      .map((k) => `/${k}`)],
  });
});

// Same for unhandled errors: JSON in, JSON out.
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Only listen when run directly (`npm start`). Under Vercel the exported app is
// invoked per-request, where binding a port is meaningless.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = app;
