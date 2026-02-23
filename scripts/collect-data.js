/**
 * Repo Owner Tracker - Speichert nur INAKTIVE Repos - FIXED
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

async function makeRequestWithRateLimitHandling(url) {
  const r1 = await makeRequest(url);

  if (r1.status === 403 && r1.data?.message?.includes('API rate limit')) {
    const resetMs = Number(r1.headers?.['x-ratelimit-reset']) * 1000;
    const waitMs = Math.max(0, resetMs - Date.now()) + 1500;
    console.log(`⏳ Rate limit. Waiting ${(waitMs / 1000).toFixed(0)}s...`);
    await sleep(waitMs);
    return await makeRequest(url);
  }

  return r1;
}

// ===== GITHUB API =====

async function listOrgRepos(org) {
  let allRepos = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`;
    const result = await makeRequestWithRateLimitHandling(url);

    if (!result.success) {
      console.error(`  ❌ Cannot list repos. Status: ${result.status}`);
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
  const url = `https://api.github.com/repos/${org}/${repo}/properties/values`;
  const result = await makeRequestWithRateLimitHandling(url);

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

  const nowIso = new Date().toISOString();
  const nowDateOnly = isoDateOnly(nowIso);

  const dataDir = path.join(__dirname, '../docs/data');
  ensureDir(dataDir);

  const dashboardFile = path.join(dataDir, 'dashboard-data.json');
  const detailFile = path.join(dataDir, 'repos-detail.json');

  // Lade existierende Daten für Trends
  const existingData = safeJsonRead(dashboardFile, { organizations: [], trends: [] });
  let trends = Array.isArray(existingData.trends) ? existingData.trends : [];

  const organizations = [];
  const trendEntry = { date: nowDateOnly };
  const inactiveRepos = [];  // NUR inaktive Repos

  for (const org of ORGS) {
    console.log(`\n📦 ${org}`);

    const repos = await listOrgRepos(org);
    console.log(`  🔍 Checking RepoOwner for ${repos.length} repos...\n`);

    let activeCount = 0;
    let inactiveCount = 0;

    for (const repo of repos) {
      const repoOwnerValue = await getRepoOwnerValue(org, repo.name);
      const inactive = isInactive(repoOwnerValue);
      const active = !inactive;

      if (active) {
        activeCount++;
      } else {
        inactiveCount++;
        
        // DEBUG: Zeige was als inaktiv erkannt wurde
        console.log(`    ❌ INAKTIV: ${repo.name} (value: "${repoOwnerValue}")`);
        
        // NUR inaktive Repos speichern
        inactiveRepos.push({
          org,
          repo: repo.name,
          url: `https://github.com/${org}/${repo.name}`,
          repoOwner: repoOwnerValue,
          isActive: false
        });
      }

      // Kleine Pause zwischen Requests
      await sleep(50);
    }

    const totalRepos = repos.length;

    organizations.push({
      name: org,
      totalRepos,
      activeRepos: activeCount,
      inactiveRepos: inactiveCount,
      lastUpdated: nowIso
    });

    // Für Trends: speichere totalRepos
    trendEntry[org] = totalRepos;

    console.log(`\n  ✅ ${org}: ${totalRepos} total, ${activeCount} aktiv, ${inactiveCount} inaktiv\n`);
  }

  // Füge neuen Trend-Eintrag hinzu
  trends.push(trendEntry);

  // Behalte nur die letzten 90 Tage
  if (trends.length > 90) {
    trends = trends.slice(-90);
  }

  // Speichere Dashboard-Daten
  const dashboardData = {
    generatedAt: nowIso,
    organizations,
    trends
  };

  safeJsonWrite(dashboardFile, dashboardData);

  // Speichere NUR inaktive Repos
  const detailData = {
    generatedAt: nowIso,
    totalInactive: inactiveRepos.length,
    repos: inactiveRepos
  };

  safeJsonWrite(detailFile, detailData);

  console.log('\n══════════════════════════════════════════════════════════��');
  console.log('✅ Data collected!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\n📊 Summary:`);
  organizations.forEach(org => {
    const pct = org.totalRepos > 0 ? Math.round((org.activeRepos / org.totalRepos) * 100) : 0;
    console.log(`   ${org.name}: ${org.totalRepos} total, ${org.activeRepos} aktiv (${pct}%), ${org.inactiveRepos} inaktiv`);
  });
  console.log(`\n📁 Files:`);
  console.log(`   ${dashboardFile}`);
  console.log(`   ${detailFile}`);
  console.log(`\n📊 Total inaktive repos saved: ${inactiveRepos.length}`);
  
  // DEBUG: Zeige ein Beispiel
  if (inactiveRepos.length > 0) {
    console.log(`\n📝 First 3 inactive repos:`)
    inactiveRepos.slice(0, 3).forEach(r => {
      console.log(`   - ${r.org}/${r.repo} (${r.repoOwner})`);
    });
  }
  
  console.log('═══════════════════════════════════════════════════════════\n');
}

collectData().catch(console.error);
