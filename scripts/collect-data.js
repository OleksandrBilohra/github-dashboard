/**
 * Repo Owner Tracker - KORREKT
 * Prüft Custom Property "RepoOwner" in jedem Repo
 * - AKTIV: RepoOwner hat einen echten Wert (NICHT "Please choose..." und NICHT "default")
 * - NICHT AKTIV: RepoOwner ist leer oder "Please choose a valid option!" oder "default"
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
  'welttv'
];

const PAT = process.env.GH_PAT;

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

/**
 * WICHTIG: Prüft ob ein RepoOwner Wert "nicht aktiv" ist
 * NICHT AKTIV wenn:
 * - null, undefined, oder leer
 * - "Please choose a valid option!"
 * - "default"
 */
function isInactiveValue(value) {
  // Null oder undefined = NICHT AKTIV
  if (value === null || value === undefined) {
    return true;
  }

  // Konvertiere zu String und trimme
  const s = String(value).trim();

  // Leer = NICHT AKTIV
  if (s === '') {
    return true;
  }

  // Lowercase für Vergleich
  const lower = s.toLowerCase();

  // "Please choose a valid option!" = NICHT AKTIV
  if (lower === 'please choose a valid option!') {
    return true;
  }

  // "default" oder "default (...)" = NICHT AKTIV
  if (lower === 'default' || lower.startsWith('default')) {
    return true;
  }

  // Ansonsten = AKTIV (hat einen echten Wert)
  return false;
}

// ===== HTTP =====

function makeRequest(url) {
  return new Promise((resolve) => {
    const headers = {
      'Authorization': `Bearer ${PAT}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'repo-owner-tracker'
    };

    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }

        resolve({
          success: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          data: parsed
        });
      });
    }).on('error', (err) => resolve({ success: false, status: 0, headers: {}, data: String(err) }));
  });
}

async function makeRequestWithRateLimitHandling(url) {
  const r1 = await makeRequest(url);

  const msg = (r1 && r1.data && typeof r1.data === 'object') ? String(r1.data.message || '') : '';
  const isRateLimited =
    r1.status === 403 &&
    msg.toLowerCase().includes('api rate limit exceeded') &&
    r1.headers &&
    r1.headers['x-ratelimit-reset'];

  if (!isRateLimited) return r1;

  const resetMs = Number(r1.headers['x-ratelimit-reset']) * 1000;
  const waitMs = Math.max(0, resetMs - Date.now()) + 1500;

  console.log(`⏳ Rate limit hit. Waiting ${(waitMs / 1000).toFixed(0)}s until reset...`);
  await sleep(waitMs);

  return await makeRequest(url);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const current = idx++;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ===== GITHUB API =====

async function listOrgRepos(org) {
  let allRepos = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`;
    const result = await makeRequestWithRateLimitHandling(url);

    if (!result.success) {
      console.error(`  ❌ ${org}: cannot list repos. status=${result.status}`);
      return [];
    }

    if (!Array.isArray(result.data) || result.data.length === 0) break;

    allRepos = allRepos.concat(result.data);
    console.log(`  📄 Page ${page}: ${result.data.length} repos`);

    if (result.data.length < 100) break;
    page++;
  }

  // Filter nur nicht-archivierte Repos
  return allRepos.filter(r => !r.archived);
}

async function getRepoOwnerProperty(org, repo) {
  const url = `https://api.github.com/repos/${org}/${repo}/properties/values`;
  const result = await makeRequestWithRateLimitHandling(url);

  if (!result.success || !Array.isArray(result.data)) {
    return null;
  }

  const repoOwner = result.data.find(p => p.property_name === 'RepoOwner');
  
  if (!repoOwner) {
    return null;
  }

  return repoOwner.value;
}

// ===== MAIN =====

async function collectData() {
  if (!PAT || !String(PAT).trim()) {
    console.error('❌ GH_PAT is not set.');
    process.exit(1);
  }

  const nowIso = new Date().toISOString();

  const dataDir = path.join(__dirname, '../docs/data');
  ensureDir(dataDir);

  const dashboardFile = path.join(dataDir, 'dashboard-data.json');
  const detailFile = path.join(dataDir, 'repos-detail.json');

  const organizations = [];
  const allReposDetail = [];

  for (const org of ORGS) {
    console.log(`\n📦 ${org}`);

    // 1. Hole alle Repos
    const repos = await listOrgRepos(org);
    console.log(`  📊 Total: ${repos.length} repositories (ohne archiv)`);

    // 2. Prüfe RepoOwner für jedes Repo
    let activeCount = 0;
    const reposDetail = [];

    await mapWithConcurrency(repos, 5, async (repo) => {
      const repoOwnerValue = await getRepoOwnerProperty(org, repo.name);
      
      // WICHTIG: isInactiveValue() gibt true zurück wenn NICHT AKTIV
      const isActive = !isInactiveValue(repoOwnerValue);

      if (isActive) {
        activeCount++;
      }

      reposDetail.push({
        org,
        repo: repo.name,
        url: `https://github.com/${org}/${repo.name}`,
        repoOwner: repoOwnerValue,
        isActive
      });

      allReposDetail.push(reposDetail[reposDetail.length - 1]);
    });

    const totalRepos = repos.length;
    const inactiveCount = totalRepos - activeCount;

    organizations.push({
      name: org,
      totalRepos,
      activeRepos: activeCount,
      inactiveRepos: inactiveCount,
      lastUpdated: nowIso
    });

    console.log(`\n  ✅ ${org}:`);
    console.log(`     📊 Total: ${totalRepos}`);
    console.log(`     ✅ Aktiv: ${activeCount}`);
    console.log(`     ❌ Nicht Aktiv: ${inactiveCount}`);
  }

  // Speichere Dashboard
  safeJsonWrite(dashboardFile, {
    generatedAt: nowIso,
    organizations,
    summary: {
      totalRepos: allReposDetail.length,
      totalActive: allReposDetail.filter(r => r.isActive).length,
      totalInactive: allReposDetail.filter(r => !r.isActive).length
    }
  });

  // Speichere Details
  safeJsonWrite(detailFile, {
    generatedAt: nowIso,
    repos: allReposDetail
  });

  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('✅ Data collected and saved!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\n📊 Summary:`);
  console.log(`   Total Repos: ${allReposDetail.length}`);
  console.log(`   ✅ Aktiv: ${allReposDetail.filter(r => r.isActive).length}`);
  console.log(`   ❌ Nicht Aktiv: ${allReposDetail.filter(r => !r.isActive).length}`);
  console.log('\n📁 Files saved:');
  console.log(`   ${dashboardFile}`);
  console.log(`   ${detailFile}`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

collectData().catch(console.error);
