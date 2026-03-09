/**
 * Contributors Collector - ALLE Organisationen
 * Sammelt Contributors von inaktiven Repos (ohne gültigen RepoOwner, nicht archiviert)
 * Speichert: docs/data/contributors-data.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ORGS = [
  'AS-ASK-IT',
  'as-cloud-services',
  'asitservices',
  'axelspringer',
  'Media-Impact',
  'spring-media',
  'welttv',
  'sales-impact'
];

const PAT = process.env.GH_PAT;
const PAT_SALES_IMPACT = process.env.GH_PAT_SALES_IMPACT;

const FINE_GRAINED_ORGS = {
  'sales-impact': PAT_SALES_IMPACT
};

function getTokenForOrg(org) {
  return FINE_GRAINED_ORGS[org] || PAT;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeJsonRead(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeJsonWrite(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function isInactive(value) {
  if (value === null || value === undefined) return true;
  const s = String(value).trim();
  if (s === '') return true;
  const lower = s.toLowerCase();
  if (lower === 'please choose a valid option!') return true;
  if (lower === 'default' || lower.startsWith('default')) return true;
  return false;
}

// ===== HTTP =====

function makeRequest(url, token = PAT) {
  return new Promise((resolve) => {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'contributor-tracker'
    };

    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { }

        const linkHeader = res.headers['link'] || '';
        let nextUrl = null;
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) nextUrl = nextMatch[1];

        resolve({
          success: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          data: parsed,
          nextUrl
        });
      });
    }).on('error', () => resolve({ success: false, status: 0, data: null, nextUrl: null }));
  });
}

async function makeRequestWithRateLimit(url, token = PAT) {
  const r = await makeRequest(url, token);

  if (r.status === 403 && r.data?.message?.includes('API rate limit')) {
    const resetMs = Number(r.headers?.['x-ratelimit-reset']) * 1000;
    const waitMs = Math.max(0, resetMs - Date.now()) + 1500;
    console.log(`⏳ Rate limit. Warte ${(waitMs / 1000).toFixed(0)}s...`);
    await sleep(waitMs);
    return await makeRequest(url, token);
  }

  return r;
}

// ===== GITHUB API =====

async function listOrgRepos(org) {
  const token = getTokenForOrg(org);
  let allRepos = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`;
    const result = await makeRequestWithRateLimit(url, token);

    if (!result.success) {
      console.error(`  ❌ Repos nicht ladbar. Status: ${result.status} - ${result.data?.message || 'Unknown'}`);
      if (result.status === 403) {
        console.error(`     💡 PAT nicht für SAML SSO autorisiert oder fehlende Scopes`);
      }
      return [];
    }

    if (!Array.isArray(result.data) || result.data.length === 0) break;

    allRepos = allRepos.concat(result.data);
    console.log(`  📄 Seite ${page}: ${result.data.length} Repos (Gesamt: ${allRepos.length})`);

    if (result.data.length < 100) break;
    page++;
  }

  return allRepos.filter(r => !r.archived);
}

async function getRepoOwnerValue(org, repo) {
  const token = getTokenForOrg(org);
  const url = `https://api.github.com/repos/${org}/${repo}/properties/values`;
  const result = await makeRequestWithRateLimit(url, token);

  if (!result.success || !Array.isArray(result.data)) return null;

  const prop = result.data.find(p => p.property_name === 'RepoOwner');
  return prop ? prop.value : null;
}

async function getRepoContributors(org, repo) {
  const token = getTokenForOrg(org);
  const contributors = [];
  let url = `https://api.github.com/repos/${org}/${repo}/contributors?per_page=100&anon=false`;

  while (url) {
    const result = await makeRequestWithRateLimit(url, token);

    if (!result.success || !Array.isArray(result.data)) {
      if (result.status === 204) return [];
      if (result.status === 403) return [];
      break;
    }

    for (const c of result.data) {
      contributors.push({
        login: c.login,
        avatar: c.avatar_url,
        profileUrl: `https://github.com/${c.login}`,
        contributions: c.contributions
      });
    }

    url = result.nextUrl;
    if (url) await sleep(100);
  }

  return contributors;
}

async function getRepoDetails(org, repoName) {
  const token = getTokenForOrg(org);
  const url = `https://api.github.com/repos/${org}/${repoName}`;
  const result = await makeRequestWithRateLimit(url, token);

  if (!result.success) return {};

  const d = result.data;
  return {
    description: d.description || '',
    language: d.language || 'Unknown',
    pushedAt: d.pushed_at || null,
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
    defaultBranch: d.default_branch || 'main',
    size: d.size || 0,
    openIssues: d.open_issues_count || 0,
    forks: d.forks_count || 0,
    stars: d.stargazers_count || 0,
    visibility: d.visibility || 'unknown'
  };
}

// ===== Sammle Contributors für eine Org =====

async function collectOrgContributors(org) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📦 ${org}`);
  console.log(`${'═'.repeat(60)}`);

  const repos = await listOrgRepos(org);
  console.log(`  📂 ${repos.length} nicht-archivierte Repos\n`);

  if (repos.length === 0) {
    return {
      org,
      totalRepos: 0,
      inactiveRepoCount: 0,
      totalUniqueContributors: 0,
      repos: [],
      contributors: []
    };
  }

  console.log(`  🔍 Prüfe RepoOwner...\n`);
  const inactiveRepos = [];

  for (const repo of repos) {
    const ownerValue = await getRepoOwnerValue(org, repo.name);
    const inactive = isInactive(ownerValue);

    if (inactive) {
      inactiveRepos.push({ ...repo, repoOwnerValue: ownerValue });
    }
    await sleep(50);
  }

  console.log(`  ❌ ${inactiveRepos.length} inaktive Repos gefunden`);
  console.log(`  👥 Sammle Contributors...\n`);

  const repoContributorsData = [];

  for (const repo of inactiveRepos) {
    process.stdout.write(`  👥 ${repo.name}...`);
    const [contributors, details] = await Promise.all([
      getRepoContributors(org, repo.name),
      getRepoDetails(org, repo.name)
    ]);

    console.log(` → ${contributors.length} Contributors`);

    repoContributorsData.push({
      repo: repo.name,
      url: `https://github.com/${org}/${repo.name}`,
      repoOwner: repo.repoOwnerValue,
      description: details.description,
      language: details.language,
      pushedAt: details.pushedAt,
      createdAt: details.createdAt,
      visibility: details.visibility,
      size: details.size,
      openIssues: details.openIssues,
      forks: details.forks,
      stars: details.stars,
      contributorCount: contributors.length,
      contributors: contributors.sort((a, b) => b.contributions - a.contributions)
    });

    await sleep(150);
  }

  // Aggregiere Contributors
  const contributorMap = {};
  for (const repo of repoContributorsData) {
    for (const c of repo.contributors) {
      if (!contributorMap[c.login]) {
        contributorMap[c.login] = {
          login: c.login,
          avatar: c.avatar,
          profileUrl: c.profileUrl,
          totalContributions: 0,
          repos: []
        };
      }
      contributorMap[c.login].totalContributions += c.contributions;
      contributorMap[c.login].repos.push({
        repo: repo.repo,
        contributions: c.contributions
      });
    }
  }

  const allContributors = Object.values(contributorMap)
    .sort((a, b) => b.totalContributions - a.totalContributions);

  console.log(`  ✅ ${org}: ${repos.length} total, ${inactiveRepos.length} inaktiv, ${allContributors.length} Contributors\n`);

  return {
    org,
    totalRepos: repos.length,
    inactiveRepoCount: inactiveRepos.length,
    totalUniqueContributors: allContributors.length,
    repos: repoContributorsData,
    contributors: allContributors
  };
}

// ===== MAIN =====

async function main() {
  if (!PAT || !String(PAT).trim()) {
    console.error('❌ GH_PAT ist nicht gesetzt.');
    process.exit(1);
  }

  console.log('🔑 Prüfe PAT...');
  const tokenCheck = await makeRequest('https://api.github.com/user');
  if (!tokenCheck.success) {
    console.error(`❌ PAT ungültig. Status: ${tokenCheck.status}`);
    process.exit(1);
  }
  console.log(`✅ Authentifiziert als: ${tokenCheck.data?.login}`);
  const scopes = tokenCheck.headers?.['x-oauth-scopes'] || 'N/A (Fine-grained PAT)';
  console.log(`📋 PAT Scopes: ${scopes}`);

  if (PAT_SALES_IMPACT) {
    const siCheck = await makeRequest('https://api.github.com/user', PAT_SALES_IMPACT);
    if (siCheck.success) {
      console.log(`✅ Fine-grained PAT OK (${siCheck.data?.login})`);
    } else {
      console.error(`❌ GH_PAT_SALES_IMPACT ungültig.`);
    }
  }

  // Prüfe Zugriff
  for (const org of ORGS) {
    const token = getTokenForOrg(org);
    const check = await makeRequest(`https://api.github.com/orgs/${org}`, token);
    if (!check.success) {
      console.warn(`⚠️  ${org}: Kein Zugriff (Status ${check.status})`);
    } else {
      console.log(`✅ ${org}: OK`);
    }
  }

  const dataDir = path.join(__dirname, '../docs/data');
  ensureDir(dataDir);

  const outputFile = path.join(dataDir, 'contributors-data.json');

  const organizations = [];

  for (const org of ORGS) {
    const orgResult = await collectOrgContributors(org);
    organizations.push(orgResult);
  }

  // Globale Statistik
  let globalTotalRepos = 0;
  let globalInactiveRepos = 0;
  const globalContributorMap = {};

  for (const orgData of organizations) {
    globalTotalRepos += orgData.totalRepos;
    globalInactiveRepos += orgData.inactiveRepoCount;

    for (const c of orgData.contributors) {
      if (!globalContributorMap[c.login]) {
        globalContributorMap[c.login] = {
          login: c.login,
          avatar: c.avatar,
          profileUrl: c.profileUrl,
          totalContributions: 0,
          orgs: [],
          repos: []
        };
      }
      globalContributorMap[c.login].totalContributions += c.totalContributions;
      if (!globalContributorMap[c.login].orgs.includes(orgData.org)) {
        globalContributorMap[c.login].orgs.push(orgData.org);
      }
      for (const r of c.repos) {
        globalContributorMap[c.login].repos.push({
          org: orgData.org,
          repo: r.repo,
          contributions: r.contributions
        });
      }
    }
  }

  const globalContributors = Object.values(globalContributorMap)
    .sort((a, b) => b.totalContributions - a.totalContributions);

  const output = {
    generatedAt: new Date().toISOString(),
    globalStats: {
      totalOrgs: organizations.length,
      totalRepos: globalTotalRepos,
      totalInactiveRepos: globalInactiveRepos,
      totalUniqueContributors: globalContributors.length
    },
    globalContributors,
    organizations
  };

  safeJsonWrite(outputFile, output);
  console.log(`\n✅ Gespeichert: ${outputFile}`);

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('📊 ZUSAMMENFASSUNG - Contributors von inaktiven Repos');
  console.log('═'.repeat(60));
  for (const org of organizations) {
    console.log(`  ${org.org}: ${org.totalRepos} Repos, ${org.inactiveRepoCount} inaktiv, ${org.totalUniqueContributors} Contributors`);
  }
  console.log('─'.repeat(60));
  console.log(`  GESAMT: ${globalTotalRepos} Repos, ${globalInactiveRepos} inaktiv, ${globalContributors.length} unique Contributors`);
  console.log('═'.repeat(60) + '\n');
}

main().catch(console.error);
