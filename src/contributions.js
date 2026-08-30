/**
 * Contribution calendar.
 *
 * GitHub does not expose the contribution graph through its REST API. The
 * GraphQL API does (contributionsCollection.contributionCalendar) but requires a
 * token, so with one configured we ask GraphQL, and without one we parse the
 * public HTML fragment at /users/:login/contributions.
 *
 * The HTML path is inherently fragile -- it is markup, not a contract. Every
 * parse failure resolves to null rather than throwing, and the UI simply omits
 * the calendar when that happens.
 */

const USER = process.env.GITHUB_USER || 'seandinwiddie';
const TOKEN = process.env.GITHUB_TOKEN;

const DAY_CELL = /data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-level="(\d)"/g;
const TOOLTIP = /<tool-tip[^>]*>([^<]*)<\/tool-tip>/g;
const TOTAL = /([\d,]+)\s*\n?\s*contributions/;

const countFromTooltip = (text) => {
  const match = /^([\d,]+)\s+contribution/.exec(text.trim());
  return match ? Number(match[1].replace(/,/g, '')) : 0;
};

const matchesOf = (pattern, text) => [...text.matchAll(pattern)];

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
  const total = TOTAL.exec(html);

  return {
    // The calendar table is laid out one row per weekday, so cells arrive in
    // weekday order (each consecutive pair seven days apart). Sort to restore
    // chronological order; consumers should not have to know the DOM shape.
    days: days
      .map((day, index) => ({ ...day, count: counts[index] ?? 0 }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    total: total ? Number(total[1].replace(/,/g, '')) : days.reduce((s, d) => s + d.level, 0),
    source: 'html',
  };
};

const fetchHtmlCalendar = async () => {
  const response = await fetch(`https://github.com/users/${USER}/contributions`, {
    headers: { 'User-Agent': 'api.sdin.dev', Accept: 'text/html' },
  });

  if (!response.ok) {
    throw new Error(`GitHub contributions responded ${response.status}`);
  }

  return parseCalendarHtml(await response.text());
};

const GRAPHQL_QUERY = `query($login:String!){
  user(login:$login){
    contributionsCollection{
      contributionCalendar{
        totalContributions
        weeks{ contributionDays{ date contributionCount contributionLevel } }
      }
    }
  }
}`;

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const fetchGraphqlCalendar = async () => {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent': 'api.sdin.dev',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { login: USER } }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL responded ${response.status}`);
  }

  const body = await response.json();
  const calendar = body?.data?.user?.contributionsCollection?.contributionCalendar;

  if (!calendar) {
    return null;
  }

  return {
    days: calendar.weeks.flatMap((week) =>
      week.contributionDays.map((day) => ({
        date: day.date,
        count: day.contributionCount,
        level: LEVELS[day.contributionLevel] ?? 0,
      }))
    ),
    total: calendar.totalContributions,
    source: 'graphql',
  };
};

/** Resolves to a calendar, or null if it could not be obtained. Never throws. */
const loadContributions = async () => {
  try {
    return TOKEN ? await fetchGraphqlCalendar() : await fetchHtmlCalendar();
  } catch (error) {
    console.warn('Contribution calendar unavailable:', error.message);
    return null;
  }
};

module.exports = { loadContributions, parseCalendarHtml };
