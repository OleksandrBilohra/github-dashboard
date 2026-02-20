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
const DEBUG_REPOOWNER = process.env.DEBUG_REPOOWNER === '1';

// ---- helpers ----
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function ensureDataDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
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

function extractRepoOwnerString(raw) {
  if (raw == null) return '';

  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return String(raw).trim();
  }

  if (Array.isArray(raw)) {
    return raw.map(extractRepoOwnerString).filter(Boolean).join(',').trim();
  }

  if (typeof raw === 'object') {
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

    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object') {
        const s = extractRepoOwnerString(v);
        if (s) return s;
      }
    }
  }

  return '';
}

function isActiveByRepoOwner(rawRepoOwnerValue) {
  const v = extractRepoOwnerString(rawRepoOwnerValue).trim();
  if (!v) return false;
  if (v.toLowerCase() === 'default') return false;
  return true;
}

// ---- HTTP with rate-limit handling ----
function makeRequest(url) {
  return new Promise((resolve) => {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'repo-owner-tracker'
    };

    if (PAT && String(PAT).trim().length > 0) {
      headers['Authorization'] = `token ${PAT}`;
    }

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

// ---- concurrency ----
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

// ---- GitHub logic ----
async function listOrgRepos(org) {
  let allRepos = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`;
    const result = await makeRequestWithRateLimitHandling(url);

    if (!result.success) {
      console.error(`  ❌ ${org}: cannot list repos. status=${result.status}`);
      console.error(`  ❌ response:`, result.data);
      break;
    }

    if (!Array.isArray(result.data) || result.data.length === 0) break;

    allRepos = allRepos.concat(result.data);

    if (result.data.length < 100) break;
    page++;
  }

  // total = all visibilities, exclude archived
  return allRepos.filter(r => !r.archived);
}

async function getRepoOwnerCustomProperty(org, repo) {
  const url = `https://api.github.com/repos/${org}/${repo}/properties/values`;
  const result = await makeRequestWithRateLimitHandling(url);

  if (!result.success || !result.data) return { ok: false, value: null, status: result.status };

  if (Array.isArray(result.data)) {
    const hit = result.data.find(p =>
      p.property_name === 'RepoOwner' ||
      p.propertyName === 'RepoOwner' ||
      p.name === 'RepoOwner'
    );
    if (!hit) return { ok: true, value: null, status: result.status };

    if ('value' in hit) return { ok: true, value: hit.value, status: result.status };
    if ('string_value' in hit) return { ok: true, value: hit.string_value, status: result.status };
    if ('selected_value' in hit) return { ok: true, value: hit.selected_value, status: result.status };
    if ('values' in hit) return { ok: true, value: hit.values, status: result.status };

    return { ok: true, value: null, status: result.status };
  }

  if (typeof result.data === 'object' && result.data !== null) {
    if ('RepoOwner' in result.data) return { ok: true, value: result.data.RepoOwner, status: result.status };
  }

  return { ok: true, value: null, status: result.status };
}

// ---- caching to avoid burning 5000 requests every run ----
function cacheKey(org, repo) {
  return `${org}/${repo}`;
}

async function collectData() {
  const nowIso = new Date().toISOString();

  const dataDir = path.join(__dirname, '../docs/data');
  ensureDataDir(dataDir);

  const dashboardFile = path.join(dataDir, 'dashboard-data.json');
  const cacheFile = path.join(dataDir, 'repoowner-cache.json');

  // Cache shape:
  // {
  //   "org/repo": { "updated_at": "...", "repoOwnerRaw": <any>, "repoOwnerExtracted": "...", "active": true/false, "cached_at": "..." }
  // }
  const repoOwnerCache = safeJsonRead(cacheFile, {});

  const organizations = [];
  const trendEntry = { date: nowIso.split('T')[0] };

  for (const org of ORGS) {
    console.log(`📦 ${org}`);

    const repos = await listOrgRepos(org);

    // Decide which repos need property refresh:
    const toRefresh = repos.filter(r => {
      const key = cacheKey(org, r.name);
      const cached = repoOwnerCache[key];
      // refresh if not cached or repo updated_at changed
      return !cached || cached.updated_at !== r.updated_at;
    });

    // Lower concurrency to avoid bursts (still can be many, but cache keeps it small later)
    const refreshed = await mapWithConcurrency(toRefresh, 2, async (r) => {
      const { ok, value, status } = await getRepoOwnerCustomProperty(org, r.name);

      const extracted = extractRepoOwnerString(value);
      const active = ok && isActiveByRepoOwner(value);

      if (DEBUG_REPOOWNER) {
        console.log(`  🔎 ${org}/${r.name} updated_at=${r.updated_at} propsStatus=${status} extracted="${extracted}" active=${active}`);
      }

      repoOwnerCache[cacheKey(org, r.name)] = {
        updated_at: r.updated_at,
        repoOwnerRaw: value,
        repoOwnerExtracted: extracted,
        active,
        cached_at: nowIso
      };
      return null;
    });

    void refreshed; // just to silence linters if any

    // total: all repos without archived
    const totalRepos = repos.length;

    // active: based on cache (RepoOwner != default/empty AND properties readable)
    const activeRepos = repos.filter(r => {
      const cached = repoOwnerCache[cacheKey(org, r.name)];
      return cached ? Boolean(cached.active) : false;
    }).length;

    organizations.push({
      name: org,
      totalRepos,
      activeRepos,
      lastUpdated: nowIso
    });

    trendEntry[org] = totalRepos;

    console.log(`  ✅ ${org}: ${totalRepos} total (ohne archiv), ${activeRepos} aktiv (RepoOwner != default/leer)\n`);
  }

  // Save dashboard trends
  const existingDashboard = safeJsonRead(dashboardFile, { organizations: [], trends: [] });
  let trends = Array.isArray(existingDashboard.trends) ? existingDashboard.trends : [];
  trends.push(trendEntry);
  if (trends.length > 90) trends = trends.slice(-90);

  safeJsonWrite(dashboardFile, { organizations, trends });

  // Save cache
  safeJsonWrite(cacheFile, repoOwnerCache);

  console.log('✅ Data saved!');
  console.log(`🗃️ Cache saved: ${cacheFile}`);
}

collectData().catch(console.error);
