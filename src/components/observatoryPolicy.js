const { positiveMilliseconds } = require('../http');

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ANALYTICS_DATA_ORIGIN =
  'https://analyticsdata.googleapis.com/v1beta';
const GOOGLE_SEARCH_CONSOLE_ORIGIN =
  'https://www.googleapis.com/webmasters/v3';

const DEFAULT_OBSERVATORY_CACHE_TTL_MS = positiveMilliseconds(
  process.env.OBSERVATORY_CACHE_TTL_MS,
  60 * 1000
);
const DEFAULT_OBSERVATORY_REQUEST_TIMEOUT_MS = positiveMilliseconds(
  process.env.OBSERVATORY_REQUEST_TIMEOUT_MS,
  2500
);

const OAUTH_CONFIG_KEYS = Object.freeze({
  clientId: 'GOOGLE_OAUTH_CLIENT_ID',
  clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
  refreshToken: 'GOOGLE_OAUTH_REFRESH_TOKEN',
});

const OBSERVATORY_CHANNELS = Object.freeze([
  Object.freeze({
    siteId: 'registry',
    analyticsKey: 'GA4_SDIN_DEV_PROPERTY_ID',
    searchConsoleKey: 'GSC_SDIN_DEV_SITE_URL',
  }),
  Object.freeze({
    siteId: 'personal',
    analyticsKey: 'GA4_SEANDINWIDDIE_COM_PROPERTY_ID',
    searchConsoleKey: 'GSC_SEANDINWIDDIE_COM_SITE_URL',
  }),
]);

const GOOGLE_ANALYTICS_AGGREGATE_METRICS = Object.freeze([
  'activeUsers',
  'sessions',
  'screenPageViews',
]);

const GOOGLE_SEARCH_CONSOLE_METRICS = Object.freeze([
  'clicks',
  'impressions',
  'ctr',
  'position',
]);

module.exports = {
  DEFAULT_OBSERVATORY_CACHE_TTL_MS,
  DEFAULT_OBSERVATORY_REQUEST_TIMEOUT_MS,
  GOOGLE_ANALYTICS_AGGREGATE_METRICS,
  GOOGLE_ANALYTICS_DATA_ORIGIN,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_SEARCH_CONSOLE_METRICS,
  GOOGLE_SEARCH_CONSOLE_ORIGIN,
  OAUTH_CONFIG_KEYS,
  OBSERVATORY_CHANNELS,
};
