const https = require('https');
const fs = require('fs');
const path = require('path');

const PAT = process.env.GH_PAT;

// IMPORTANT: Custom properties APIs may require a preview accept header depending on your GitHub version.
// We'll try with v3 first; if you get 415/404, switch Accept to the preview header mentioned below.
function makeRequest(url) {
  return new Promise((resolve) => {
    const options = {
      headers: {
        'Authorization': `token ${PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        // Alternative if needed:
        // 'Accept': 'application/vnd.github+json',
        'User-Agent': 'Node.js'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ success: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ success: false, status: res.statusCode, data: null });
        }
      });
    }).on('error', () => resolve({ success: false, status: 0, data: null }));
  });
}

function isValidRepoOwner(value) {
  if (value == null) return false;
  const v = String(value).trim();
  if (!v) return false;                 // leer
  if (v.toLowerCase() === 'default') return false; // "default"
  return true;
}

// --- Custom properties fetch ---
// Endpoint can differ depending on your GitHub feature/API version.
// Try this first. If it fails (404/415), tell me the status code and response and we’ll adjust.
async function getRepoOwnerCustomProperty(org, repo) {
  // candidate endpoint (often used for repo properties values)
  const url = `https://api.github.com/repos/${org}/${repo}/properties/values`;
  const result = await makeRequest(url);

  if (!result.success || !result.data) return null;

  // Expected shapes can vary. We try to support a couple:
  // Shape A: [{ property_name: 'RepoOwner', value: '...' }, ...]
  if (Array.isArray(result.data)) {
    const hit = result.data.find(p => p.property_name === 'RepoOwner' || p.propertyName === 'RepoOwner' || p.name === 'RepoOwner');
    return hit ? (hit.value ?? hit.values ?? hit.string_value ?? hit.selected_value ?? null) : null;
  }

  // Shape B: { RepoOwner: "..." } (less common)
  if (typeof result.data === 'object') {
    if ('RepoOwner' in result.data) return result.data.RepoOwner;
  }

  return null;
}

// simple concurrency pool
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

async function getOrgRepos(org) {
  console.log(`📦 ${org}`);

  let allRepos = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`;
    const result = await makeRequest(url);

    if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
      hasMore = false;
      break;
    }

    allRepos = allRepos.concat(result.data);
    console.log(`  📄 Page ${page}: ${result.data.length} repos (Total: ${allRepos.length})`);

    if (result.data.length < 100) hasMore = false;
    page++;
  }

  // Du wolltest: public+private+internal ok, aber keine archived
  const filteredRepos = allRepos.filter(r => !r.archived);

  // ACTIVE = RepoOwner Custom Property gesetzt (nicht default, nicht leer)
  // (parallelisiert, damit es schneller läuft)
  const repoOwnerValues = await mapWithConcurrency(filteredRepos, 8, async (r) => {
    try {
      const value = await getRepoOwnerCustomProperty(org, r.name);
      return value;
    } catch {
      return null;
    }
  });

  const activeRepos = repoOwnerValues.filter(isValidRepoOwner).length;

  console.log(`  ✅ ${org}: ${filteredRepos.length} total (ohne archiv), ${activeRepos} aktiv (RepoOwner gesetzt)\n`);
  return { totalRepos: filteredRepos.length, activeRepos };
}

async function collectData() {
  const ORGS = [
    'AS-ASK-IT',
    'as-cloud-services',
    'asitservices',
    'axelspringer',
    'Media-Impact',
    'spring-media',
    'welttv'
  ];

  const organizations = [];
  const trendEntry = { date: new Date().toISOString().split('T')[0] };

  for (const org of ORGS) {
    try {
      const { totalRepos, activeRepos } = await getOrgRepos(org);

      organizations.push({
        name: org,
        totalRepos,
        activeRepos,
        lastUpdated: new Date().toISOString()
      });

      trendEntry[org] = totalRepos;
    } catch (error) {
      console.error(`❌ ${org}: ${error.message}`);
      trendEntry[org] = 0;
    }
  }

  const dataDir = path.join(__dirname, '../docs/data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  let trends = [];
  const dataFile = path.join(dataDir, 'dashboard-data.json');
  if (fs.existsSync(dataFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      trends = existing.trends || [];
    } catch {
      trends = [];
    }
  }

  trends.push(trendEntry);
  if (trends.length > 90) trends = trends.slice(-90);

  fs.writeFileSync(dataFile, JSON.stringify({ organizations, trends }, null, 2));
  console.log('✅ Data saved!');
}

collectData().catch(console.error);
