const https = require('https');
const fs = require('fs');
const path = require('path');

const PAT = process.env.GH_PAT;

function makeRequest(url) {
  return new Promise((resolve) => {
    const options = {
      headers: {
        // zurück wie früher:
        'Authorization': `token ${PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Node.js'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }

        resolve({
          success: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          data: parsed
        });
      });
    }).on('error', (err) => resolve({ success: false, status: 0, data: String(err) }));
  });
}

function normalizeToString(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (Array.isArray(value)) return value.map(normalizeToString).filter(Boolean).join(',').trim();
  if (typeof value === 'object') {
    if (typeof value.name === 'string') return value.name.trim();
    if (typeof value.value === 'string') return value.value.trim();
    if (typeof value.login === 'string') return value.login.trim();
    return '';
  }
  return '';
}

function isValidRepoOwner(value) {
  const v = normalizeToString(value);
  if (!v) return false;
  if (v.toLowerCase() === 'default') return false;
  return true;
}

async function getRepoOwnerCustomProperty(org, repo) {
  const url = `https://api.github.com/repos/${org}/${repo}/properties/values`;
  const result = await makeRequest(url);

  if (!result.success) {
    // wichtiges Debug
    console.log(`  ⚠️ ${org}/${repo}: cannot read custom properties (status=${result.status})`);
    return null;
  }

  if (!result.data) return null;

  if (Array.isArray(result.data)) {
    const hit = result.data.find(p =>
      p.property_name === 'RepoOwner' ||
      p.propertyName === 'RepoOwner' ||
      p.name === 'RepoOwner'
    );
    if (!hit) return null;

    if ('value' in hit) return hit.value;
    if ('values' in hit) return hit.values;
    if ('string_value' in hit) return hit.string_value;
    if ('selected_value' in hit) return hit.selected_value;
    return null;
  }

  if (typeof result.data === 'object' && result.data !== null) {
    if ('RepoOwner' in result.data) return result.data.RepoOwner;
  }

  return null;
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

async function getOrgRepos(org) {
  console.log(`📦 ${org}`);

  let allRepos = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`;
    const result = await makeRequest(url);

    if (!result.success) {
      console.error(`  ❌ ${org}: cannot list repos. status=${result.status}`);
      console.error(`  ❌ response:`, result.data);
      break;
    }

    if (!Array.isArray(result.data) || result.data.length === 0) break;

    allRepos = allRepos.concat(result.data);
    console.log(`  📄 Page ${page}: ${result.data.length} repos (Total: ${allRepos.length})`);

    if (result.data.length < 100) break;
    page++;
  }

  // total = alle visibilities, ohne archiv
  const filteredRepos = allRepos.filter(r => !r.archived);

  // active = RepoOwner gesetzt (nicht default/leer)
  const repoOwnerValues = await mapWithConcurrency(filteredRepos, 6, async (r) => {
    try {
      return await getRepoOwnerCustomProperty(org, r.name);
    } catch {
      return null;
    }
  });

  const activeRepos = repoOwnerValues.filter(isValidRepoOwner).length;

  console.log(`  ✅ ${org}: ${filteredRepos.length} total (public+private+internal, ohne archiv), ${activeRepos} aktiv (RepoOwner != default/leer)\n`);
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
