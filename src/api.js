const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 3000;

// Read the initial state JSON file
const initialStateFile = path.join(__dirname, 'data', 'initialState.json');
const initialState = JSON.parse(fs.readFileSync(initialStateFile, 'utf8'));

// Homepage route
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the API' });
});

// Status page route
app.get('/status', (req, res) => {
  res.json({ status: 'OK' });
});

// Create dynamic endpoints for each key in the initial state
Object.keys(initialState).forEach(key => {
  app.get(`/${key}`, (req, res) => {
    res.json({ [key]: initialState[key] });
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
