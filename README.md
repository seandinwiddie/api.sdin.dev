# api.sdin.dev

This project is an Express.js-based API for my portfolio.

## Description

This is an Express.js-based API for a portfolio website. It serves as the backend for fetching and providing data to the frontend application.

This project provides a flexible backend for a portfolio website, allowing easy content updates through the JSON file while maintaining a structured API for frontend consumption.

## Main Components

### API Server (src/api.js)
- Uses Express.js to create a server
- Implements CORS for cross-origin requests
- Reads initial state from a JSON file
- Provides endpoints for:
  - Homepage
  - Status check
  - Fetching all data
  - Dynamic endpoints for each key in the initial state

### Initial State Data (src/data/initialState.json)
- Contains structured data for the portfolio, including:
  - BDD (Behavior-Driven Development) tests
  - Brand information
  - Portfolio features
  - Application procedures
  - Theme toggle settings
  - Navigation data

## Project Structure
- `src/api.js`: Contains the main API logic
- `src/data/`: Stores the initial state data

## Dependencies
- Express.js for the server
- CORS for handling cross-origin requests

## Key Features
- Dynamic endpoint generation based on the initial state structure
- Centralized data management through a JSON file
- Support for multiple themes
- BDD test scenarios included in the data

## Running the Project
The server can be started using `npm start`, which runs `node src/api.js`

## Data Flow
The project follows a structure where data is stored in a JSON file, loaded into the API, and then served through various endpoints. This allows for easy updates to the portfolio content without changing the API code.