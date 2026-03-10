/**
 * Collect Data - Kombiniertes Script
 * 1) RepoOwner-Status für alle Orgs → dashboard-data.json (+ Trends)
 * 2) Collaborators (Direct Admin) & Teams von inaktiven Repos → collaborators-data.json
 *
 * Repos werden nur EINMAL pro Org geladen → spart ~50% API-Calls
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

// Orgs die einen Fine-grained PAT brauchen
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

function isoDateOnly(iso) {
  return String(iso).split('T')[0];
}

// ===== CORE LOGIC =====

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
      'User-Agent': 'repo-owner-tracker'
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
      const msg = result.data?.message || 'Unknown error';
      const docUrl = result.data?.documentation_url || '';
      console.error(`  ❌ Cannot list repos. Status: ${result.status}`);
      console.error(`     Message: ${msg}`);
      if (docUrl) console.error(`     Docs: ${docUrl}`);
      if (result.status === 403) {
        console.error(`     💡 Mögliche Ursachen für 403:`);
        console.error(`        - PAT nicht für SAML SSO autorisiert (Settings → Developer Settings → PAT → Configure SSO)`);
        console.error(`        - Fine-grained PAT hat keinen Zugriff auf diese Org`);
        console.error(`        - Fehlende Scopes: repo, read:org, admin:org`);
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

/**
 * Holt direkte Collaborators eines Repos (affiliation=direct).
 * Filtert nur Admin-Rolle.
 */
async function getRepoCollaborators(org, repo) {
  const token = getTokenForOrg(org);
  const collaborators = [];
  let url = `https://api.github.com/repos/${org}/${repo}/collaborators?affiliation=direct&per_page=100`;

  while (url) {
    const result = await makeRequestWithRateLimit(url, token);

    if (!result.success || !Array.isArray(result.data)) {
      if (result.status === 204 || result.status === 403 || result.status === 404) return [];
      break;
    }

    for (const c of result.data) {
      const roleName = c.role_name || '';
      const isAdmin = c.permissions?.admin === true || roleName === 'admin';
      if (isAdmin) {
        collaborators.push({
          login: c.login,
          avatar: c.avatar_url,
          profileUrl: `https://github.com/${c.login}`,
          role: roleName || 'admin'
        });
      }
    }

    url = result.nextUrl;
    if (url) await sleep(100);
  }

  return collaborators;
}

/**
 * Holt Teams die Zugriff auf ein Repo haben.
 */
async function getRepoTeams(org, repo) {
  const token = getTokenForOrg(org);
  const teams = [];
  let url = `https://api.github.com/repos/${org}/${repo}/teams?per_page=100`;

  while (url) {
    const result = await makeRequestWithRateLimit(url, token);

    if (!result.success || !Array.isArray(result.data)) {
      if (result.status === 204 || result.status === 403 || result.status === 404) return [];
      break;
    }

    for (const t of result.data) {
      teams.push({
        name: t.name,
        slug: t.slug,
        description: t.description || '',
        permission: t.permission || 'pull',
        url: `https://github.com/orgs/${org}/teams/${t.slug}`
      });
    }

    url = result.nextUrl;
    if (url) await sleep(100);
  }

  return teams;
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

// ===== Verarbeite eine Org (Dashboard + Collaborators in einem Durchlauf) =====

async function processOrg(org, nowIso) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📦 ${org}`);
  console.log(`${'═'.repeat(60)}`);

  const repos = await listOrgRepos(org);
  console.log(`  📂 ${repos.length} nicht-archivierte Repos`);

  if (repos.length === 0) {
    return {
      dashboard: {
        name: org,
        totalRepos: 0,
        activeRepos: 0,
        inactiveRepos: 0,
        inactiveList: [],
        lastUpdated: nowIso
      },
      collaborators: {
        org,
        totalRepos: 0,
        inactiveRepoCount: 0,
        totalUniqueAdmins: 0,
        totalUniqueTeams: 0,
        repos: [],
        admins: [],
        teams: []
      }
    };
  }

  console.log(`  🔍 Prüfe RepoOwner...\n`);

  let activeCount = 0;
  let inactiveCount = 0;
  const inactiveList = [];        // Für dashboard-data.json
  const inactiveRepoObjects = []; // Für Collaborators-Sammlung

  for (const repo of repos) {
    const repoOwnerValue = await getRepoOwnerValue(org, repo.name);
    const inactive = isInactive(repoOwnerValue);

    if (!inactive) {
      activeCount++;
    } else {
      inactiveCount++;
      console.log(`    ❌ INAKTIV: ${repo.name} (value: "${repoOwnerValue}")`);

      inactiveList.push({
        repo: repo.name,
        url: `https://github.com/${org}/${repo.name}`,
        repoOwner: repoOwnerValue
      });

      inactiveRepoObjects.push({ ...repo, repoOwnerValue });
    }

    await sleep(50);
  }

  const totalRepos = repos.length;
  console.log(`\n  📊 ${totalRepos} total, ${activeCount} aktiv, ${inactiveCount} inaktiv`);

  // ===== Collaborators & Teams für inaktive Repos sammeln =====
  console.log(`  🔐 Sammle Collaborators & Teams für ${inactiveRepoObjects.length} inaktive Repos...\n`);

  const repoAccessData = [];

  for (const repo of inactiveRepoObjects) {
    process.stdout.write(`  🔐 ${repo.name}...`);
    const [collaborators, teams, details] = await Promise.all([
      getRepoCollaborators(org, repo.name),
      getRepoTeams(org, repo.name),
      getRepoDetails(org, repo.name)
    ]);

    console.log(` → ${collaborators.length} Admins, ${teams.length} Teams`);

    repoAccessData.push({
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
      adminCount: collaborators.length,
      teamCount: teams.length,
      admins: collaborators,
      teams: teams
    });

    await sleep(150);
  }

  // Aggregiere Admins pro Org
  const adminMap = {};
  for (const repo of repoAccessData) {
    for (const a of repo.admins) {
      if (!adminMap[a.login]) {
        adminMap[a.login] = {
          login: a.login,
          avatar: a.avatar,
          profileUrl: a.profileUrl,
          role: a.role,
          repoCount: 0,
          repos: []
        };
      }
      adminMap[a.login].repoCount++;
      adminMap[a.login].repos.push(repo.repo);
    }
  }

  const allAdmins = Object.values(adminMap)
    .sort((a, b) => b.repoCount - a.repoCount);

  // Aggregiere Teams pro Org
  const teamMap = {};
  for (const repo of repoAccessData) {
    for (const t of repo.teams) {
      const key = t.slug;
      if (!teamMap[key]) {
        teamMap[key] = {
          name: t.name,
          slug: t.slug,
          description: t.description,
          url: t.url,
          repoCount: 0,
          repos: [],
          permissions: {}
        };
      }
      teamMap[key].repoCount++;
      teamMap[key].repos.push({ repo: repo.repo, permission: t.permission });
      teamMap[key].permissions[t.permission] = (teamMap[key].permissions[t.permission] || 0) + 1;
    }
  }

  const allTeams = Object.values(teamMap)
    .sort((a, b) => b.repoCount - a.repoCount);

  console.log(`  ✅ ${org}: ${totalRepos} total, ${inactiveCount} inaktiv, ${allAdmins.length} Admins, ${allTeams.length} Teams\n`);

  return {
    dashboard: {
      name: org,
      totalRepos,
      activeRepos: activeCount,
      inactiveRepos: inactiveCount,
      inactiveList,
      lastUpdated: nowIso
    },
    collaborators: {
      org,
      totalRepos,
      inactiveRepoCount: inactiveCount,
      totalUniqueAdmins: allAdmins.length,
      totalUniqueTeams: allTeams.length,
      repos: repoAccessData,
      admins: allAdmins,
      teams: allTeams
    }
  };
}

// ===== MAIN =====

async function main() {
  if (!PAT || !String(PAT).trim()) {
    console.error('❌ GH_PAT ist nicht gesetzt.');
    process.exit(1);
  }

  // Pre-flight check
  console.log('🔑 Prüfe PAT...');
  const tokenCheck = await makeRequest('https://api.github.com/user');
  if (!tokenCheck.success) {
    console.error(`❌ PAT ungültig. Status: ${tokenCheck.status}`);
    console.error(`   Message: ${tokenCheck.data?.message || 'Unknown'}`);
    process.exit(1);
  }
  console.log(`✅ Authentifiziert als: ${tokenCheck.data?.login}`);
  const scopes = tokenCheck.headers?.['x-oauth-scopes'] || 'N/A (Fine-grained PAT)';
  console.log(`📋 PAT Scopes: ${scopes}`);

  if (PAT_SALES_IMPACT) {
    console.log('🔑 Prüfe Fine-grained PAT für sales-impact...');
    const siCheck = await makeRequest('https://api.github.com/user', PAT_SALES_IMPACT);
    if (!siCheck.success) {
      console.error(`❌ GH_PAT_SALES_IMPACT ungültig. Status: ${siCheck.status}`);
    } else {
      console.log(`✅ Fine-grained PAT OK (${siCheck.data?.login})`);
    }
  } else {
    console.warn('⚠️  GH_PAT_SALES_IMPACT nicht gesetzt - sales-impact wird mit Classic PAT versucht');
  }

  // Zugriff pro Org prüfen
  for (const org of ORGS) {
    const token = getTokenForOrg(org);
    const orgCheck = await makeRequest(`https://api.github.com/orgs/${org}`, token);
    if (!orgCheck.success) {
      console.warn(`⚠️  ${org}: Status ${orgCheck.status} - ${orgCheck.data?.message || 'No access'}`);
      if (orgCheck.status === 403) {
        console.warn(`   💡 PAT hat keinen Zugriff auf "${org}". SAML SSO autorisieren oder Fine-grained PAT erweitern!`);
      }
    } else {
      console.log(`✅ ${org}: Access OK`);
    }
  }
  console.log('');

  const nowIso = new Date().toISOString();
  const nowDateOnly = isoDateOnly(nowIso);

  const dataDir = path.join(__dirname, '../docs/data');
  ensureDir(dataDir);

  const dashboardFile = path.join(dataDir, 'dashboard-data.json');
  const collaboratorsFile = path.join(dataDir, 'collaborators-data.json');

  console.log('📁 Dashboard     →', dashboardFile);
  console.log('📁 Collaborators →', collaboratorsFile);
  console.log('');

  // Lade existierende Daten für Trends
  const existingData = safeJsonRead(dashboardFile, { organizations: [], trends: [] });
  let trends = Array.isArray(existingData.trends) ? existingData.trends : [];

  const dashboardOrgs = [];
  const collaboratorOrgs = [];
  const trendEntry = { date: nowDateOnly };

  // ===== Verarbeite alle Orgs =====
  for (const org of ORGS) {
    const result = await processOrg(org, nowIso);

    dashboardOrgs.push(result.dashboard);
    collaboratorOrgs.push(result.collaborators);

    trendEntry[org] = result.dashboard.totalRepos;
    trendEntry[`${org}_active`] = result.dashboard.activeRepos;
  }

  // ===== 1) dashboard-data.json =====
  trends.push(trendEntry);
  if (trends.length > 90) {
    trends = trends.slice(-90);
  }

  const dashboardData = {
    generatedAt: nowIso,
    organizations: dashboardOrgs,
    trends
  };

  safeJsonWrite(dashboardFile, dashboardData);
  console.log(`\n✅ Gespeichert: ${dashboardFile}`);

  // ===== 2) collaborators-data.json =====
  let globalTotalRepos = 0;
  let globalInactiveRepos = 0;
  const globalAdminMap = {};
  const globalTeamMap = {};

  for (const orgData of collaboratorOrgs) {
    globalTotalRepos += orgData.totalRepos;
    globalInactiveRepos += orgData.inactiveRepoCount;

    for (const a of orgData.admins) {
      if (!globalAdminMap[a.login]) {
        globalAdminMap[a.login] = {
          login: a.login,
          avatar: a.avatar,
          profileUrl: a.profileUrl,
          role: a.role,
          repoCount: 0,
          orgs: [],
          repos: []
        };
      }
      globalAdminMap[a.login].repoCount += a.repoCount;
      if (!globalAdminMap[a.login].orgs.includes(orgData.org)) {
        globalAdminMap[a.login].orgs.push(orgData.org);
      }
      for (const r of a.repos) {
        globalAdminMap[a.login].repos.push({ org: orgData.org, repo: r });
      }
    }

    for (const t of orgData.teams) {
      const key = `${orgData.org}/${t.slug}`;
      if (!globalTeamMap[key]) {
        globalTeamMap[key] = {
          name: t.name,
          slug: t.slug,
          description: t.description,
          url: t.url,
          org: orgData.org,
          repoCount: t.repoCount,
          repos: t.repos,
          permissions: t.permissions
        };
      }
    }
  }

  const globalAdmins = Object.values(globalAdminMap)
    .sort((a, b) => b.repoCount - a.repoCount);

  const globalTeams = Object.values(globalTeamMap)
    .sort((a, b) => b.repoCount - a.repoCount);

  const collaboratorsData = {
    generatedAt: nowIso,
    globalStats: {
      totalOrgs: collaboratorOrgs.length,
      totalRepos: globalTotalRepos,
      totalInactiveRepos: globalInactiveRepos,
      totalUniqueAdmins: globalAdmins.length,
      totalUniqueTeams: globalTeams.length
    },
    globalAdmins,
    globalTeams,
    organizations: collaboratorOrgs
  };

  safeJsonWrite(collaboratorsFile, collaboratorsData);
  console.log(`✅ Gespeichert: ${collaboratorsFile}`);

  // ===== Summary =====
  console.log('\n' + '═'.repeat(60));
  console.log('📊 ZUSAMMENFASSUNG');
  console.log('═'.repeat(60));
  for (const org of dashboardOrgs) {
    const pct = org.totalRepos > 0 ? Math.round((org.activeRepos / org.totalRepos) * 100) : 0;
    console.log(`  ${org.name}: ${org.totalRepos} total, ${org.activeRepos} aktiv (${pct}%), ${org.inactiveRepos} inaktiv`);
  }
  console.log('─'.repeat(60));
  console.log(`  GESAMT: ${globalTotalRepos} Repos, ${globalInactiveRepos} inaktiv, ${globalAdmins.length} Admins, ${globalTeams.length} Teams`);
  console.log('═'.repeat(60));
  console.log(`\n📁 ${dashboardFile}`);
  console.log(`📁 ${collaboratorsFile}\n`);
}

main().catch(console.error);
