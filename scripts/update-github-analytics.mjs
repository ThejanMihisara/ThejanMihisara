import { readFile, writeFile } from "node:fs/promises";

const USERNAME = process.env.GITHUB_USERNAME || "ThejanMihisara";
const TOKEN = process.env.GH_STATS_TOKEN || process.env.GITHUB_TOKEN;
const API_URL = "https://api.github.com/graphql";
const NOW = new Date();
const START_YEAR = Number(process.env.GITHUB_STATS_START_YEAR || 2024);
const REQUIRE_PRIVATE_REPO_ACCESS = process.env.REQUIRE_PRIVATE_REPO_ACCESS === "true";
const YEARS = buildYears(START_YEAR, NOW.getUTCFullYear());

if (!TOKEN) {
  throw new Error("GH_STATS_TOKEN or GITHUB_TOKEN is required to fetch GitHub analytics.");
}

const LANGUAGE_COLORS = {
  JavaScript: "#f1e05a",
  TypeScript: "#3178c6",
  PHP: "#4F5D95",
  Blade: "#f7523f",
  Java: "#b07219",
  HTML: "#e34c26",
  CSS: "#663399",
  Python: "#3572A5",
  "C++": "#f34b7d",
  C: "#555555",
  Shell: "#89e051",
  Dart: "#00B4AB",
};

const data = await fetchAnalytics();
const repos = await fetchAccessibleRepos();
const [authorFilters, prCount, issueCount, languages] = await Promise.all([
  fetchAuthorFilters(),
  fetchIssueSearchCount(`type:pr author:${USERNAME}`),
  fetchIssueSearchCount(`type:issue author:${USERNAME}`),
  fetchLanguages(repos),
]);
validateTokenAccess(repos, authorFilters);
const totalCommits = await fetchCommitSearchCount(`author:${USERNAME}`);
const stats = buildStats(data, {
  commits: totalCommits,
  prs: prCount,
  issues: issueCount,
  languages,
}, repos);
await writeFile("github-analytics.svg", renderSvg(stats), "utf8");
await updateReadmeTimestamp(stats.updatedAt);

async function fetchAnalytics() {
  const contributionFields = YEARS.map(({ alias, from, to }) => `
        ${alias}: contributionsCollection(from: "${from}", to: "${to}") {
          restrictedContributionsCount
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalRepositoryContributions
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
            }
          }
          issueContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
            }
          }
          pullRequestContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
            }
          }
        }
  `).join("\n");

  const query = `
    query GitHubAnalytics($login: String!) {
      user(login: $login) {
        login
        name
        ${contributionFields}
      }
    }
  `;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${USERNAME}-analytics-action`,
    },
    body: JSON.stringify({
      query,
      variables: {
        login: USERNAME,
      },
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(JSON.stringify(payload.errors || payload, null, 2));
  }

  if (!payload.data.user) {
    throw new Error(`GitHub user not found: ${USERNAME}`);
  }

  return payload.data.user;
}

async function fetchAccessibleRepos() {
  const repos = [];
  let page = 1;

  while (true) {
    const batch = await fetchRestJson(
      `https://api.github.com/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&per_page=100&page=${page}&sort=updated&direction=desc`,
      `repos page ${page}`,
    );

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    repos.push(...batch);

    if (batch.length < 100) {
      break;
    }

    page += 1;
  }

  console.log(`Accessible repos: ${repos.length}`);
  console.log(`Accessible private repos: ${repos.filter((repo) => repo.private).length}`);
  return repos;
}

async function fetchAuthorFilters() {
  const filters = new Set([USERNAME]);
  const viewer = await fetchRestJson("https://api.github.com/user", "current user profile", true);
  if (viewer?.login) {
    filters.add(viewer.login);
  }

  const emails = await fetchRestJson("https://api.github.com/user/emails", "current user emails", true);
  if (Array.isArray(emails)) {
    for (const email of emails) {
      if (email?.email) {
        filters.add(email.email);
      }
    }
  }

  console.log(`Author filters available: ${filters.size}`);
  return [...filters];
}

async function fetchIssueSearchCount(query) {
  const params = new URLSearchParams({ q: query, per_page: "1" });
  const payload = await fetchRestJson(`https://api.github.com/search/issues?${params}`, query, true);
  return payload?.total_count ?? 0;
}

async function fetchCommitSearchCount(query) {
  const params = new URLSearchParams({ q: query, per_page: "1" });
  const payload = await fetchRestJson(
    `https://api.github.com/search/commits?${params}`,
    query,
    false,
    "application/vnd.github.cloak-preview+json",
  );
  return payload.total_count ?? 0;
}

async function fetchLanguages(repos) {
  const totals = new Map();

  for (const repo of repos) {
    if (repo.fork || !repo.languages_url) {
      continue;
    }

    const languages = await fetchRestJson(repo.languages_url, `${repo.full_name} languages`, true);
    if (!languages) {
      continue;
    }

    for (const [name, size] of Object.entries(languages)) {
      const current = totals.get(name) || {
        name,
        color: LANGUAGE_COLORS[name] || "#8b949e",
        size: 0,
      };
      current.size += Number(size) || 0;
      totals.set(name, current);
    }
  }

  const totalSize = [...totals.values()].reduce((sum, lang) => sum + lang.size, 0);
  if (totalSize === 0) {
    return [];
  }

  return [...totals.values()]
    .sort((a, b) => b.size - a.size)
    .slice(0, 8)
    .map((lang) => ({
      ...lang,
      percent: (lang.size / totalSize) * 100,
    }));
}

function validateTokenAccess(repos, authorFilters) {
  const privateRepoCount = repos.filter((repo) => repo.private).length;

  if (REQUIRE_PRIVATE_REPO_ACCESS && privateRepoCount === 0) {
    throw new Error([
      "GH_STATS_TOKEN cannot access any private repositories.",
      "The generated stats will not match your logged-in GitHub search counts.",
      "Fix: update the GH_STATS_TOKEN repository secret with a token that has access to all repositories, including private repositories.",
      "For a fine-grained token, set Repository access to All repositories and give read access to Contents, Metadata, Issues, and Pull requests.",
      "For commits made with different Git emails, also add Account permission: Email addresses read-only.",
    ].join(" "));
  }

  if (authorFilters.length === 1) {
    console.warn("Only one author filter is available. Add Email addresses read-only permission to GH_STATS_TOKEN if commits are missing.");
  }
}

async function fetchRestJson(
  url,
  context,
  optional = false,
  accept = "application/vnd.github+json",
) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": `${USERNAME}-analytics-action`,
    },
  });
  const payload = await response.json();

  if (!response.ok) {
    const message = `${context}: ${JSON.stringify(payload)}`;
    if (optional) {
      console.warn(`Skipped ${message}`);
      return null;
    }
    throw new Error(message);
  }

  return payload;
}

function buildStats(user, searchStats, repos) {
  const contributionYears = YEARS.map(({ alias }) => user[alias]);
  const totals = sumContributionYears(contributionYears);

  const days = contributionYears
    .flatMap((contributions) => contributions.contributionCalendar.weeks)
    .flatMap((week) => week.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date));

  const streaks = calculateStreaks(days);
  const languages = searchStats.languages;
  const totalStars = repos
    .filter((repo) => !repo.fork)
    .reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0);
  const totalCommits = searchStats.commits ?? totals.totalCommitContributions;
  const totalPRs = searchStats.prs ?? totals.totalPullRequestContributions;
  const totalIssues = searchStats.issues ?? totals.totalIssueContributions;

  console.log(`Total commits: ${totalCommits}`);
  console.log(`Total PRs: ${totalPRs}`);
  console.log(`Total issues: ${totalIssues}`);
  console.log(`Total contributions: ${totals.totalContributions}`);

  return {
    username: user.login,
    totalStars,
    totalCommits,
    totalPRs,
    totalIssues,
    contributedTo: totalPRs + 1,
    totalContributions: totals.totalContributions,
    currentStreak: streaks.current.count,
    currentStreakLabel: streaks.current.label,
    longestStreak: streaks.longest.count,
    longestStreakLabel: streaks.longest.label,
    contributionPeriod: `${START_YEAR} - Present`,
    grade: calculateGrade(totalStars, totalCommits, totalPRs, totalIssues),
    languages,
    updatedAt: NOW.toISOString(),
  };
}

function sumContributionYears(contributionYears) {
  return contributionYears.reduce((totals, contributions) => ({
    totalCommitContributions:
      totals.totalCommitContributions + contributions.totalCommitContributions,
    totalIssueContributions:
      totals.totalIssueContributions + contributions.totalIssueContributions,
    totalPullRequestContributions:
      totals.totalPullRequestContributions + contributions.totalPullRequestContributions,
    totalRepositoryContributions:
      totals.totalRepositoryContributions + contributions.totalRepositoryContributions,
    restrictedContributionsCount:
      totals.restrictedContributionsCount + contributions.restrictedContributionsCount,
    totalContributions:
      totals.totalContributions
      + contributions.contributionCalendar.totalContributions
      + contributions.restrictedContributionsCount,
  }), {
    totalCommitContributions: 0,
    totalIssueContributions: 0,
    totalPullRequestContributions: 0,
    totalRepositoryContributions: 0,
    restrictedContributionsCount: 0,
    totalContributions: 0,
  });
}

function calculateStreaks(days) {
  let longest = { count: 0, start: null, end: null };
  let active = { count: 0, start: null, end: null };

  for (const day of days) {
    if (day.contributionCount > 0) {
      if (active.count === 0) {
        active.start = day.date;
      }
      active.count += 1;
      active.end = day.date;
      if (active.count > longest.count) {
        longest = { ...active };
      }
    } else {
      active = { count: 0, start: null, end: null };
    }
  }

  const today = toDateOnly(NOW);
  const yesterday = toDateOnly(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));
  const current = active.end === today || active.end === yesterday
    ? active
    : { count: 0, start: null, end: null };

  return {
    current: {
      count: current.count,
      label: formatRange(current.start, current.end),
    },
    longest: {
      count: longest.count,
      label: formatRange(longest.start, longest.end),
    },
  };
}

function calculateGrade(stars, commits, prs, issues) {
  const score = stars * 2 + commits + prs * 3 + issues;
  if (score >= 1000) return "S";
  if (score >= 500) return "A+";
  if (score >= 250) return "A";
  if (score >= 100) return "B+";
  return "B";
}

function renderSvg(stats) {
  const languageRows = renderLanguageRows(stats.languages);
  const languageBar = renderLanguageBar(stats.languages);

  return `<svg width="860" height="430" viewBox="0 0 860 430" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GitHub Analytics">
<!-- updated: ${escapeXml(stats.updatedAt)} -->
<rect x="1" y="1" width="858" height="428" fill="#0d1117" stroke="#30363d"/>
<line x1="430" y1="1" x2="430" y2="429" stroke="#30363d"/>

<rect x="16" y="20" width="392" height="155" rx="4" fill="#071126" stroke="#c9d1d9"/>
<text x="36" y="48" fill="#00aaff" font-size="15" font-weight="700" text-anchor="start" font-family="Inter, Segoe UI, Arial, sans-serif">My GitHub Statistics</text>
${statLine(76, "*", "Total Stars:", stats.totalStars)}
${statLine(96, "+", "Total Commits:", stats.totalCommits)}
${statLine(116, "PR", "Total PRs:", stats.totalPRs)}
${statLine(136, "!", "Total Issues:", stats.totalIssues)}
${statLine(156, "#", "Contributed to:", stats.contributedTo)}
<circle cx="325" cy="107" r="32" stroke="#0e4670" stroke-width="5"/>
<circle cx="325" cy="107" r="32" stroke="#00aaff" stroke-width="5" stroke-linecap="round" stroke-dasharray="172.9 201.1" transform="rotate(-90 325 107)"/>
<text x="325" y="113" fill="#ffffff" font-size="22" font-weight="800" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">${escapeXml(stats.grade)}</text>

<rect x="16" y="242" width="392" height="166" rx="4" fill="#161616"/>
<line x1="145" y1="264" x2="145" y2="388" stroke="#c9d1d9"/>
<line x1="278" y1="264" x2="278" y2="388" stroke="#c9d1d9"/>
<text x="82" y="306" fill="#ffffff" font-size="24" font-weight="800" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">${stats.totalContributions}</text>
<text x="82" y="338" fill="#ffffff" font-size="11" font-weight="600" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">Total Contributions</text>
<text x="82" y="361" fill="#8b949e" font-size="9" font-weight="400" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">${escapeXml(stats.contributionPeriod)}</text>
<circle cx="212" cy="292" r="28" stroke="#ff8c00" stroke-width="4"/>
<text x="212" y="299" fill="#ffffff" font-size="24" font-weight="800" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">${stats.currentStreak}</text>
<text x="212" y="345" fill="#ff9800" font-size="11" font-weight="700" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">Current Streak</text>
<text x="212" y="368" fill="#8b949e" font-size="9" font-weight="400" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">${escapeXml(stats.currentStreakLabel)}</text>
<text x="344" y="306" fill="#ffffff" font-size="24" font-weight="800" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">${stats.longestStreak}</text>
<text x="344" y="338" fill="#ffffff" font-size="11" font-weight="600" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">Longest Streak</text>
<text x="344" y="361" fill="#8b949e" font-size="8" font-weight="400" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">${escapeXml(stats.longestStreakLabel)}</text>

<rect x="468" y="120" width="330" height="180" rx="4" fill="#071126" stroke="#c9d1d9"/>
<text x="492" y="154" fill="#00aaff" font-size="18" font-weight="700" text-anchor="start" font-family="Inter, Segoe UI, Arial, sans-serif">My Programming Languages</text>
${languageBar}
${languageRows}

<text x="430" y="416" fill="#8b949e" font-size="10" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif">Updated by GitHub Actions on ${escapeXml(formatHumanDate(NOW))}</text>
</svg>
`;
}

function statLine(y, icon, label, value) {
  return `<text x="36" y="${y}" fill="#00ffd0" font-size="12" font-weight="700" text-anchor="start" font-family="Inter, Segoe UI, Arial, sans-serif">${escapeXml(icon)}</text>
<text x="56" y="${y}" fill="#ffffff" font-size="12" font-weight="700" text-anchor="start" font-family="Inter, Segoe UI, Arial, sans-serif">${escapeXml(label)}</text>
<text x="172" y="${y}" fill="#ffffff" font-size="12" font-weight="700" text-anchor="start" font-family="Inter, Segoe UI, Arial, sans-serif">${escapeXml(String(value))}</text>`;
}

function renderLanguageBar(languages) {
  if (languages.length === 0) {
    return `<rect x="492" y="174" width="284" height="7" fill="#30363d"/>`;
  }

  let x = 492;
  return languages.map((lang) => {
    const width = Math.max(2, (lang.percent / 100) * 284);
    const rect = `<rect x="${x.toFixed(1)}" y="174" width="${width.toFixed(1)}" height="7" fill="${escapeXml(lang.color)}"/>`;
    x += width;
    return rect;
  }).join("\n");
}

function renderLanguageRows(languages) {
  if (languages.length === 0) {
    return `<text x="492" y="205" fill="#ffffff" font-size="10" font-weight="700" text-anchor="start" font-family="Inter, Segoe UI, Arial, sans-serif">No language data yet</text>`;
  }

  return languages.map((lang, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = col === 0 ? 496 : 638;
    const y = 201 + row * 24;
    return `<circle cx="${x}" cy="${y}" r="5" fill="${escapeXml(lang.color)}"/>
<text x="${x + 11}" y="${y + 4}" fill="#ffffff" font-size="10" font-weight="700" text-anchor="start" font-family="Inter, Segoe UI, Arial, sans-serif">${escapeXml(lang.name)} (${lang.percent.toFixed(2)}%)</text>`;
  }).join("\n");
}

async function updateReadmeTimestamp(updatedAt) {
  const readme = await readFile("README.md", "utf8");
  const marker = `<!-- analytics-updated: ${updatedAt} -->`;
  const cacheKey = updatedAt.replace(/\D/g, "");
  const imageTag = `<img src="./github-analytics.svg?v=${cacheKey}" alt="GitHub Analytics" width="860" />`;
  const withImageCacheBust = readme.replace(
    /<img src="\.\/github-analytics\.svg(?:\?v=[^"]+)?" alt="GitHub Analytics" width="860" \/>/,
    imageTag,
  );
  const updated = withImageCacheBust.includes("<!-- analytics-updated:")
    ? withImageCacheBust.replace(/<!-- analytics-updated: .*? -->/, marker)
    : withImageCacheBust.replace(`${imageTag}\n`, `${imageTag}\n ${marker}\n`);

  await writeFile("README.md", updated, "utf8");
}

function formatRange(start, end) {
  if (!start || !end) {
    return "No active streak";
  }
  if (start === end) {
    return formatShortDate(start);
  }
  return `${formatShortDate(start)} - ${formatShortDate(end)}`;
}

function formatShortDate(dateValue) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dateValue}T00:00:00Z`));
}

function formatHumanDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function buildYears(startYear, endYear) {
  return Array.from({ length: endYear - startYear + 1 }, (_, index) => {
    const year = startYear + index;
    const from = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
    const to = year === endYear && yearEnd > NOW ? NOW : yearEnd;

    return {
      alias: `year${year}`,
      from: from.toISOString(),
      to: to.toISOString(),
    };
  });
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
