import { mkdir, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "FerLpz55";
const token = process.env.GITHUB_TOKEN || "";
const outputDir = process.env.PROFILE_OUTPUT_DIR || "dist";
const today = new Date();
const from = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
const to = today.toISOString();

const themes = {
  dark: {
    background: "#0d1117",
    surface: "#161b22",
    surfaceAlt: "#21262d",
    border: "#30363d",
    text: "#f0f6fc",
    muted: "#8b949e",
    accent: "#39d353",
    accentAlt: "#58a6ff",
    empty: "#161b22",
    levels: ["#0e4429", "#006d32", "#26a641", "#39d353"],
  },
  light: {
    background: "#ffffff",
    surface: "#f6f8fa",
    surfaceAlt: "#ffffff",
    border: "#d0d7de",
    text: "#1f2328",
    muted: "#59636e",
    accent: "#1a7f37",
    accentAlt: "#0969da",
    empty: "#ebedf0",
    levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"],
  },
};

const graphqlQuery = `
  query Profile($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      login
      followers { totalCount }
      repositories(
        ownerAffiliations: OWNER
        privacy: PUBLIC
        first: 100
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        totalCount
        nodes {
          isFork
          isArchived
          stargazerCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node { name color }
            }
          }
        }
      }
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalIssueContributions
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              contributionCount
              date
            }
          }
        }
      }
    }
  }
`;

function apiHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "FerLpz55-profile-assets",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function requestGraphQL() {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { login: username, from, to },
    }),
  });
  const body = await response.json();

  if (!response.ok || body.errors?.length || !body.data?.user) {
    throw new Error(body.errors?.[0]?.message || `GitHub GraphQL request failed: ${response.status}`);
  }

  return body.data.user;
}

async function requestRest(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers: apiHeaders() });
  if (!response.ok) throw new Error(`GitHub REST request failed: ${response.status}`);
  return response.json();
}

async function requestSnapshotFallback() {
  const [user, repos] = await Promise.all([
    requestRest(`/users/${username}`),
    requestRest(`/users/${username}/repos?per_page=100&type=owner&sort=updated`),
  ]);
  const languageMaps = await Promise.all(
    repos.map((repo) => requestRest(`/repos/${username}/${repo.name}/languages`).catch(() => ({}))),
  );
  const languageTotals = new Map();

  languageMaps.forEach((languageMap) => {
    Object.entries(languageMap).forEach(([name, size]) => {
      languageTotals.set(name, (languageTotals.get(name) || 0) + size);
    });
  });

  return {
    source: "GitHub REST API fallback",
    followers: user.followers || 0,
    publicRepos: user.public_repos || repos.length,
    stars: repos.reduce((total, repo) => total + (repo.stargazers_count || 0), 0),
    contributions: 0,
    commits: 0,
    pullRequests: 0,
    reviews: 0,
    issues: 0,
    currentStreak: 0,
    longestStreak: 0,
    weeks: [],
    languages: [...languageTotals.entries()]
      .map(([name, size]) => ({ name, size, color: null }))
      .sort((a, b) => b.size - a.size),
  };
}

function normalizeGraphQLUser(user) {
  const repositories = user.repositories.nodes || [];
  const languageTotals = new Map();

  repositories
    .filter((repo) => !repo.isFork)
    .forEach((repo) => {
      (repo.languages?.edges || []).forEach((edge) => {
        const current = languageTotals.get(edge.node.name) || {
          name: edge.node.name,
          size: 0,
          color: edge.node.color,
        };
        current.size += edge.size;
        if (!current.color) current.color = edge.node.color;
        languageTotals.set(edge.node.name, current);
      });
    });

  const collection = user.contributionsCollection;
  const weeks = collection.contributionCalendar.weeks || [];
  const days = weeks.flatMap((week) => week.contributionDays || []);
  const streak = calculateStreak(days);

  return {
    source: "GitHub GraphQL API",
    followers: user.followers.totalCount,
    publicRepos: user.repositories.totalCount,
    stars: repositories.reduce((total, repo) => total + repo.stargazerCount, 0),
    contributions: collection.contributionCalendar.totalContributions,
    commits: collection.totalCommitContributions,
    pullRequests: collection.totalPullRequestContributions,
    reviews: collection.totalPullRequestReviewContributions,
    issues: collection.totalIssueContributions,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    weeks,
    languages: [...languageTotals.values()].sort((a, b) => b.size - a.size),
  };
}

function calculateStreak(days) {
  const contributions = new Map(days.map((day) => [day.date, day.contributionCount]));
  const sortedDates = [...contributions.keys()].sort();
  let longest = 0;
  let run = 0;

  sortedDates.forEach((date) => {
    if (contributions.get(date) > 0) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  });

  let cursor = new Date();
  let current = 0;
  const todayKey = cursor.toISOString().slice(0, 10);

  if (!contributions.get(todayKey)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  while (contributions.get(cursor.toISOString().slice(0, 10)) > 0) {
    current += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return { current, longest };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function compactNumber(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value || 0);
}

function percent(value) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function text(x, y, value, color, options = {}) {
  const attributes = [
    `x="${x}"`,
    `y="${y}"`,
    `fill="${color}"`,
    `font-size="${options.size || 14}"`,
    `font-family="Inter,Segoe UI,Arial,sans-serif"`,
    `font-weight="${options.weight || 400}"`,
  ];

  if (options.anchor) attributes.push(`text-anchor="${options.anchor}"`);
  if (options.spacing) attributes.push(`letter-spacing="${options.spacing}"`);
  if (options.opacity) attributes.push(`opacity="${options.opacity}"`);

  return `<text ${attributes.join(" ")}>${escapeXml(value)}</text>`;
}

function documentSvg(themeName, width, height, title, body) {
  const theme = themes[themeName];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title">
  <title id="title">${escapeXml(title)}</title>
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="${theme.accent}" />
      <stop offset="1" stop-color="${theme.accentAlt}" />
    </linearGradient>
    <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="5" result="blur" />
      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" rx="18" fill="${theme.background}" />
  ${body(theme)}
</svg>`;
}

function statCard(theme, x, y, label, value, detail, accent) {
  return `
    <rect x="${x}" y="${y}" width="298" height="98" rx="12" fill="${theme.surface}" stroke="${theme.border}" />
    <rect x="${x}" y="${y}" width="4" height="98" rx="2" fill="${accent}" />
    ${text(x + 22, y + 29, label.toUpperCase(), theme.muted, { size: 11, weight: 700, spacing: 1.2 })}
    ${text(x + 22, y + 66, value, theme.text, { size: 28, weight: 700 })}
    ${text(x + 112, y + 65, detail, theme.muted, { size: 11 })}
  `;
}

function statsSvg(snapshot, themeName) {
  return documentSvg(themeName, 1000, 330, "GitHub statistics for FerLpz55", (theme) => {
    const metrics = [
      ["Contributions", compactNumber(snapshot.contributions), "last 12 months", theme.accent],
      ["Commits", compactNumber(snapshot.commits), "last 12 months", theme.accentAlt],
      ["Pull requests", compactNumber(snapshot.pullRequests), "opened or merged", "#bc8cff"],
      ["Reviews", compactNumber(snapshot.reviews), "code reviews", "#f778ba"],
      ["Stars", compactNumber(snapshot.stars), "across public repos", "#d29922"],
      ["Public repos", compactNumber(snapshot.publicRepos), `${compactNumber(snapshot.followers)} followers`, "#f0883e"],
    ];
    const xPositions = [28, 351, 674];
    const yPositions = [102, 216];
    const cards = metrics
      .map((metric, index) => statCard(theme, xPositions[index % 3], yPositions[Math.floor(index / 3)], ...metric))
      .join("");

    return `
      <circle cx="43" cy="42" r="7" fill="${theme.accent}" filter="url(#softGlow)" />
      ${text(62, 47, "GITHUB PULSE", theme.text, { size: 16, weight: 700, spacing: 2 })}
      ${text(62, 70, `${username} / last 12 months`, theme.muted, { size: 12 })}
      <rect x="823" y="27" width="140" height="30" rx="15" fill="${theme.surfaceAlt}" stroke="${theme.border}" />
      <circle cx="844" cy="42" r="5" fill="${theme.accent}" />
      ${text(858, 47, "LIVE DATA", theme.accent, { size: 11, weight: 700, spacing: 1 })}
      ${cards}
      ${text(28, 318, `Generated from ${snapshot.source} | ${today.toISOString().slice(0, 10)}`, theme.muted, { size: 10 })}
    `;
  });
}

function languagesSvg(snapshot, themeName) {
  return documentSvg(themeName, 1000, 350, "Programming languages used by FerLpz55", (theme) => {
    const rows = snapshot.languages.slice(0, 7);
    const total = rows.reduce((sum, language) => sum + language.size, 0);
    const barX = 220;
    const barWidth = 650;
    const rowHeight = 34;
    const palette = [theme.accent, theme.accentAlt, "#bc8cff", "#f778ba", "#d29922", "#f0883e", "#79c0ff"];
    const body = rows.length
      ? rows.map((language, index) => {
          const value = total ? (language.size / total) * 100 : 0;
          const color = language.color || palette[index % palette.length];
          const y = 93 + index * rowHeight;
          return `
            <circle cx="42" cy="${y - 5}" r="6" fill="${color}" />
            ${text(60, y, language.name, theme.text, { size: 13, weight: 600 })}
            <rect x="${barX}" y="${y - 17}" width="${barWidth}" height="12" rx="6" fill="${theme.surfaceAlt}" stroke="${theme.border}" />
            <rect x="${barX}" y="${y - 17}" width="${Math.max(8, (value / 100) * barWidth)}" height="12" rx="6" fill="${color}" />
            ${text(920, y - 6, percent(value), theme.text, { size: 12, weight: 700, anchor: "end" })}
          `;
        }).join("")
      : text(42, 120, "No public language data available yet.", theme.muted, { size: 14 });

    return `
      <circle cx="43" cy="42" r="7" fill="${theme.accentAlt}" filter="url(#softGlow)" />
      ${text(62, 47, "LANGUAGE DNA", theme.text, { size: 16, weight: 700, spacing: 2 })}
      ${text(62, 70, "Own public repositories / measured by bytes", theme.muted, { size: 12 })}
      ${body}
      ${text(42, 326, `${rows.length} languages detected | ${compactNumber(total)} bytes analyzed`, theme.muted, { size: 10 })}
    `;
  });
}

function contributionColor(theme, count, maximum) {
  if (!count) return theme.empty;
  const ratio = maximum ? count / maximum : 0;
  if (ratio < 0.25) return theme.levels[0];
  if (ratio < 0.5) return theme.levels[1];
  if (ratio < 0.75) return theme.levels[2];
  return theme.levels[3];
}

function contributionsSvg(snapshot, themeName) {
  return documentSvg(themeName, 1000, 260, "Contribution calendar for FerLpz55", (theme) => {
    const weeks = snapshot.weeks.slice(-53);
    const days = weeks.flatMap((week) => week.contributionDays || []);
    const maximum = Math.max(1, ...days.map((day) => day.contributionCount));
    const gridX = 105;
    const gridY = 100;
    const step = 15;
    const cell = 11;
    const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const monthLabels = [];
    let lastMonth = "";

    const cells = weeks.map((week, weekIndex) => {
      const firstDay = week.contributionDays?.[0];
      if (firstDay) {
        const month = firstDay.date.slice(0, 7);
        if (month !== lastMonth) {
          monthLabels.push(text(gridX + weekIndex * step, 87, new Date(`${firstDay.date}T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" }), theme.muted, { size: 10 }));
          lastMonth = month;
        }
      }

      return (week.contributionDays || []).map((day, dayIndex) => `
        <rect x="${gridX + weekIndex * step}" y="${gridY + dayIndex * step}" width="${cell}" height="${cell}" rx="3" fill="${contributionColor(theme, day.contributionCount, maximum)}">
          <title>${escapeXml(`${day.date}: ${day.contributionCount} contributions`)}</title>
        </rect>
      `).join("");
    }).join("");

    const labels = [0, 1, 3, 5].map((dayIndex) => text(28, gridY + dayIndex * step + 9, weekdayLabels[dayIndex], theme.muted, { size: 10 })).join("");
    const legend = [0, 0.25, 0.5, 0.75].map((ratio, index) => `<rect x="${760 + index * 17}" y="230" width="11" height="11" rx="3" fill="${ratio ? theme.levels[index] : theme.empty}" />`).join("");

    return `
      <circle cx="43" cy="42" r="7" fill="${theme.accent}" filter="url(#softGlow)" />
      ${text(62, 47, "CONTRIBUTION MATRIX", theme.text, { size: 16, weight: 700, spacing: 2 })}
      ${text(62, 70, `${compactNumber(snapshot.contributions)} contributions | current streak: ${snapshot.currentStreak} days | longest: ${snapshot.longestStreak} days`, theme.muted, { size: 12 })}
      ${labels}
      ${monthLabels.join("")}
      ${cells}
      ${text(760, 222, "Less", theme.muted, { size: 10, anchor: "end" })}
      ${legend}
      ${text(840, 239, "More", theme.muted, { size: 10 })}
    `;
  });
}

async function loadSnapshot() {
  try {
    return normalizeGraphQLUser(await requestGraphQL());
  } catch (error) {
    console.warn(`GraphQL unavailable: ${error.message}`);
    return requestSnapshotFallback();
  }
}

const snapshot = await loadSnapshot();
await mkdir(outputDir, { recursive: true });

for (const themeName of Object.keys(themes)) {
  await writeFile(`${outputDir}/profile-stats-${themeName}.svg`, statsSvg(snapshot, themeName));
  await writeFile(`${outputDir}/profile-languages-${themeName}.svg`, languagesSvg(snapshot, themeName));
  await writeFile(`${outputDir}/profile-contributions-${themeName}.svg`, contributionsSvg(snapshot, themeName));
}

console.log(JSON.stringify({
  username,
  source: snapshot.source,
  contributions: snapshot.contributions,
  languages: snapshot.languages.length,
  outputDir,
}, null, 2));
