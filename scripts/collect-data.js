const https = require('https');
const fs = require('fs');
const path = require('path');

const PAT = process.env.GH_PAT;

if (!PAT) {
  console.error('❌ GH_PAT is not set. Export GH_PAT and rerun.');
  process.exit(1);
}

const DEBUG_REPOOWNER = process.env.DEBUG_REPOOWNER === '1';

function makeRequest(url) {
  return new Promise((resolve) => {
    const options = {
      headers: {
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

/**
 * Extract a comparable string from "RepoOwner" custom property values.
 * Handles string, number, arrays, and common object shapes from GitHub custom properties.
 */
function extractRepoOwnerString(raw) {
  if (raw == null) return '';

  // direct scalar
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw).trim();
  }

  // array: try to extract meaningful parts
  if (Array.isArray(raw)) {
    // if array of objects/strings, extract each and join
    const parts = raw
      .map(extractRepoOwnerString)
      .map(s => s.trim())
      .filter(Boolean);

    return parts.join(',').trim();
  }

  // object: try common keys
  if (typeof raw === 'object') {
    // common candidate keys for select-like values
    const candidates = [
      raw.name,
      raw.value,
      raw.label,
      raw.display_name,
      raw.displayName,
      raw.login
    ];

    for (const c of candidates) {
      const s = extractRepoOwnerString(c);
      if (s) return s;
    }

    // Sometimes value is nested deeper:
    // e.g. { selected: { name: "default" } } or { option: { label: "default" } }
    // We'll search a limited depth for strings.
    for (const key of Object.keys(raw)) {
      const v = raw[key];
      if (typeof v === 'string') {
        const s = v.trim();
        if (s) return s;
      }
      if (v && typeof v === 'object') {
        const s = extractRepoOwnerString(v);
        if (s) return s;
      }
    }

    return '';
  }

  return '';
}

function isActiveByRepoOwner(rawRepoOwnerValue) {
  const v = extractRepoOwnerString(rawRepoOwnerValue).trim();

  // empty => not active
  if (!v) return false;

  // "default" in any case => not active
  if (v.toLowerCase() === 'default') return false;

  // also treat "Default " etc. as default
  if (v.toLowerCase().includes('default') && v.replace(/\s+/g, '').toLowerCase() === 'default') return false;

  return true;
}

/**
 * Fetch RepoOwner custom property for a repo.
 * Endpoint can differ depending on GitHub setup. You said it "works now", so we keep it.
 */
async function getRepoOwnerCustomProperty(org, repo) {
  const url = `https://api.github.com/repos/${org}/${repo}/properties/values`;
  const result = await makeRequest(url);

  if (!result.success || !result.data) return { ok: false, value: null };

  // Most common: array of properties
  if (Array.isArray(result.data)) {
    const hit = result.data.find(p =>
      p.property_name === 'RepoOwner' ||
      p.propertyName === 'RepoOwner' ||
      p.name === 'RepoOwner'
    );
    if (!hit) return { ok: true, value: null }; // property not set

    // Try the likely fields in order, but return RAW (could be object)
    if ('value' in hit) return { ok: true, value: hit.value };
    if ('string_value' in hit) return { ok: true, value: hit.string_value };
    if ('selected_value' in hit) return { ok: true, value: hit.selected_value };
    if ('values' in hit) return { ok: true, value: hit.values };

    return { ok: true, value: null };
  }

  // Object/map shape
  if (typeof result.data === 'object' && result.data !== null) {
    if ('RepoOwner' in result.data) return { ok: true, value: result.data.RepoOwner };
  }

  return { ok: true, value: null };
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

  // total: all visibilities; exclude archived
  const repos = allRepos.filter(r => !r.archived);

  // Fetch RepoOwner for each repo
  const results = await mapWithConcurrency(repos, 8, async (r) => {
    const { ok, value } = await getRepoOwnerCustomProperty(org, r.name);
    if (DEBUG_REPOOWNER) {
      console.log(`  🔎 ${org}/${r.name} RepoOwner raw=`, value, ' extracted=', extractRepoOwnerString(value));
    }
    return { repo: r.name, ok, value };
  });

  // Active only if property readable AND not default/empty
  // If properties endpoint returns ok=false (not readable) => NOT active.
  const activeRepos = results.filter(x => x.ok && isActiveByRepoOwner(x.value)).length;

  console.log(`  ✅ ${org}: ${repos.length} total (ohne archiv), ${activeRepos} aktiv (RepoOwner != default/leer)\n`);
  return { totalRepos: repos.length, activeRepos };
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
