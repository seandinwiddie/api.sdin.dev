# api.sdin.dev

Express.js API serving portfolio content for [portfolio.sdin.dev](https://portfolio.sdin.dev).

## Description

Content lives in a single JSON file and is exposed through a small, stable set of
endpoints, so portfolio copy can be updated without touching API code.

## Endpoints

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/` | `{ "message": "Welcome to the API" }` |
| GET | `/status` | `{ "status": "OK" }` |
| GET | `/data` | The complete initial state |
| GET | `/<key>` | `{ "<key>": ... }` for each top-level key in the initial state |

Current dynamic endpoints: `/bddTests`, `/brandName`, `/description`, `/iniTheme`,
`/portfolioFeatures`, `/appProcedures`, `/themeToggle`, `/nav`, `/brandNameLoading`,
`/themeCustom`.

Unknown paths return **JSON** `404` with an `availableEndpoints` list -- not an HTML
error page, so clients can parse every response the same way.

## Project Structure

- `src/api.js`: the Express app. Exports the app and only calls `listen()` when run
  directly, so it works both as a local server and as a Vercel function.
- `src/data/initialState.json`: all served content.
- `test/api.test.js`: endpoint tests using the built-in `node:test` runner.

## Running

```bash
npm install
npm start   # http://localhost:3000
npm run dev # same, with --watch
npm test    # node:test, no test framework dependency
```

`PORT` overrides the listen port.

## Caching

Responses set `Cache-Control: public, max-age=0, s-maxage=300,
stale-while-revalidate=86400`. The payload is static per deployment, so the CDN
serves it and the function is invoked rarely.

## Deployment

Deployed on Vercel via `vercel.json`, which routes all paths to `src/api.js`.
