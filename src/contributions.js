/**
 * Contribution calendar.
 *
 * GitHub does not expose the public contribution graph through its REST API.
 * We parse the unauthenticated public HTML fragment at
 * /users/:login/contributions so a server credential can never widen the
 * viewer scope to private or internal contribution activity.
 *
 * The HTML path is inherently fragile -- it is markup, not a contract. Every
 * parse failure resolves to null rather than throwing, and the UI simply omits
 * the calendar when that happens.
 */

const { createBoundedFetch, positiveMilliseconds } = require('./http');

const DEFAULT_USER = process.env.GITHUB_USER || 'seandinwiddie';
const DEFAULT_TIMEOUT_MS = positiveMilliseconds(process.env.GITHUB_REQUEST_TIMEOUT_MS);

const DAY_CELL = /data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-level="(\d)"/g;
const TOOLTIP = /<tool-tip[^>]*>([^<]*)<\/tool-tip>/g;
const TOTAL_SUMMARY =
  /<h2\b[^>]*\bid="js-contribution-activity-description"[^>]*>([\s\S]*?)<\/h2>/i;
const TOTAL = /^\s*([\d,]+)\s+contributions\b/i;
// A GitHub contribution year can span 53 partial weeks. Bound every transport
// before it becomes public data so clients can never receive an unbounded grid.
const MAX_CONTRIBUTION_DAYS = 372;

const countFromTooltip = (text) => {
  const match = /^([\d,]+)\s+contribution/.exec(text.trim());
  return match ? Number(match[1].replace(/,/g, '')) : 0;
};

const matchesOf = (pattern, text) => [...text.matchAll(pattern)];

const newestChronologicalDays = (days) =>
  [...days]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-MAX_CONTRIBUTION_DAYS);

const annualTotalOf = (html) => {
  const summary = TOTAL_SUMMARY.exec(html)?.[1]?.replace(/<[^>]*>/g, ' ') ?? '';
  const match = TOTAL.exec(summary);
  return match ? Number(match[1].replace(/,/g, '')) : null;
};

const parseCalendarHtml = (html) => {
  const days = matchesOf(DAY_CELL, html).map(([, date, level]) => ({
    date,
    level: Number(level),
  }));

  if (days.length === 0) {
    return null;
  }

  // Tooltips are emitted one per day cell, in the same order.
  const counts = matchesOf(TOOLTIP, html).map(([, text]) => countFromTooltip(text));
  const total = annualTotalOf(html);
  const projectedDays = newestChronologicalDays(
    days.map((day, index) => ({ ...day, count: counts[index] ?? 0 }))
  );

  return {
    // The calendar table is laid out one row per weekday, so cells arrive in
    // weekday order (each consecutive pair seven days apart). Sort to restore
    // chronological order; consumers should not have to know the DOM shape.
    days: projectedDays,
    total:
      total ?? projectedDays.reduce((sum, day) => sum + day.count, 0),
    source: 'html',
  };
};

/**
 * Builds the contribution effect boundary from explicit dependencies. The
 * public result remains calendar-or-null so existing consumers keep their
 * useful contract while the GitHub aggregate supplies availability metadata.
 */
const createContributionLoader = ({
  fetchImpl = globalThis.fetch,
  user = DEFAULT_USER,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  makeTimeoutSignal,
  logger = console,
} = {}) => {
  const boundedFetch = createBoundedFetch({ fetchImpl, timeoutMs, makeTimeoutSignal });

  const fetchHtmlCalendar = async () => {
    const response = await boundedFetch(`https://github.com/users/${user}/contributions`, {
      headers: { 'User-Agent': 'api.sdin.dev', Accept: 'text/html' },
    });

    if (!response.ok) {
      throw new Error(`GitHub contributions responded ${response.status}`);
    }

    return parseCalendarHtml(await response.text());
  };

  /** Resolves to a calendar, or null if it could not be obtained. Never throws. */
  return async () => {
    try {
      return await fetchHtmlCalendar();
    } catch (error) {
      logger.warn('Contribution calendar unavailable:', error.message);
      return null;
    }
  };
};

const loadContributions = createContributionLoader();

module.exports = {
  MAX_CONTRIBUTION_DAYS,
  createContributionLoader,
  loadContributions,
  parseCalendarHtml,
};
