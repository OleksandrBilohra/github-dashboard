/**
 * Repo Owner Tracker - ALLES in dashboard-data.json
 * Speichert: Organizations + Trends + Inaktive Repos pro Org
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

        resolve({
          success: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          data: parsed
        });
      });
    }).on('error', (err) => resolve({ success: false, status: 0, data: null }));
  });
}

async function makeRequestWithRateLimitHandling(url, token = PAT) {
  const r1 = await makeRequest(url, token);

  if (r1.status === 403 && r1.data?.message?.includes('API rate limit')) {
    const resetMs = Number(r1.headers?.['x-ratelimit-reset']) * 1000;
    const waitMs = Math.max(0, resetMs - Date.now()) + 1500;
    console.log(`⏳ Rate limit. Waiting ${(waitMs / 1000).toFixed(0)}s...`);
    await sleep(waitMs);
    return await makeRequest(url, token);
  }

  return r1;
}

// ===== GITHUB API =====

async function listOrgRepos(org) {
  const token = getTokenForOrg(org);
  let allRepos = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`;
    const result = await makeRequestWithRateLimitHandling(url, token);

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
    console.log(`  📄 Page ${page}: ${result.data.length} repos (Total: ${allRepos.length})`);

    if (result.data.length < 100) break;
    page++;
  }

  return allRepos.filter(r => !r.archived);
}

async function getRepoOwnerValue(org, repo) {
  const token = getTokenForOrg(org);
  const url = `https://api.github.com/repos/${org}/${repo}/properties/values`;
  const result = await makeRequestWithRateLimitHandling(url, token);

  if (!result.success || !Array.isArray(result.data)) {
    return null;
  }

  const prop = result.data.find(p => p.property_name === 'RepoOwner');

  if (!prop) {
    return null;
  }

  return prop.value;
}

// ===== MAIN =====

async function collectData() {
  if (!PAT || !String(PAT).trim()) {
    console.error('❌ GH_PAT is not set.');
    process.exit(1);
  }

  // Pre-flight check: PAT validity & scopes
  console.log('🔑 Checking PAT validity...');
  const tokenCheck = await makeRequest('https://api.github.com/user');
  if (!tokenCheck.success) {
    console.error(`❌ PAT is invalid or expired. Status: ${tokenCheck.status}`);
    console.error(`   Message: ${tokenCheck.data?.message || 'Unknown'}`);
    process.exit(1);
  }
  console.log(`✅ Authenticated as: ${tokenCheck.data?.login}`);
  const scopes = tokenCheck.headers?.['x-oauth-scopes'] || 'N/A (Fine-grained PAT)';
  console.log(`📋 PAT Scopes: ${scopes}`);

  if (PAT_SALES_IMPACT) {
    console.log('🔑 Checking Fine-grained PAT for sales-impact...');
    const siCheck = await makeRequest('https://api.github.com/user', PAT_SALES_IMPACT);
    if (!siCheck.success) {
      console.error(`❌ GH_PAT_SALES_IMPACT is invalid. Status: ${siCheck.status}`);
    } else {
      console.log(`✅ Fine-grained PAT OK (${siCheck.data?.login})`);
    }
  } else {
    console.warn('⚠️  GH_PAT_SALES_IMPACT nicht gesetzt - sales-impact wird mit Classic PAT versucht (wird wahrscheinlich 403 geben)');
  }

  // Check access to each org
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

  console.log('📁 Saving to:', dashboardFile);
  console.log('');

  // Lade existierende Daten für Trends
  const existingData = safeJsonRead(dashboardFile, { organizations: [], trends: [] });
  let trends = Array.isArray(existingData.trends) ? existingData.trends : [];

  const organizations = [];
  const trendEntry = { date: nowDateOnly };

  for (const org of ORGS) {
    console.log(`\n📦 ${org}`);

    const repos = await listOrgRepos(org);
    console.log(`  🔍 Checking RepoOwner for ${repos.length} repos...\n`);

    let activeCount = 0;
    let inactiveCount = 0;
    const inactiveRepos = [];  // Inaktive Repos für diese Org

    for (const repo of repos) {
      const repoOwnerValue = await getRepoOwnerValue(org, repo.name);
      const inactive = isInactive(repoOwnerValue);
      const active = !inactive;

      if (active) {
        activeCount++;
      } else {
        inactiveCount++;
        console.log(`    ❌ INAKTIV: ${repo.name} (value: "${repoOwnerValue}")`);
        
        inactiveRepos.push({
          repo: repo.name,
          url: `https://github.com/${org}/${repo.name}`,
          repoOwner: repoOwnerValue
        });
      }

      await sleep(50);
    }

    const totalRepos = repos.length;

    organizations.push({
      name: org,
      totalRepos,
      activeRepos: activeCount,
      inactiveRepos: inactiveCount,
      inactiveList: inactiveRepos,  // LISTE mit inaktiven Repos
      lastUpdated: nowIso
    });

    trendEntry[org] = totalRepos;

    console.log(`\n  ✅ ${org}: ${totalRepos} total, ${activeCount} aktiv, ${inactiveCount} inaktiv\n`);
  }

  // Füge neuen Trend-Eintrag hinzu
  trends.push(trendEntry);

  // Behalte nur die letzten 90 Tage
  if (trends.length > 90) {
    trends = trends.slice(-90);
  }

  // Speichere ALLES in dashboard-data.json
  const dashboardData = {
    generatedAt: nowIso,
    organizations,
    trends
  };

  safeJsonWrite(dashboardFile, dashboardData);
  console.log(`✅ Saved: ${dashboardFile}`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('✅ Data collected!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\n📊 Summary:`);
  organizations.forEach(org => {
    const pct = org.totalRepos > 0 ? Math.round((org.activeRepos / org.totalRepos) * 100) : 0;
    console.log(`   ${org.name}: ${org.totalRepos} total, ${org.activeRepos} aktiv (${pct}%), ${org.inactiveRepos} inaktiv`);
  });
  console.log(`\n📁 File: ${dashboardFile}`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

collectData().catch(console.error);
