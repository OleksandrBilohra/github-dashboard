/**
 * Repo Owner Tracker - FIXED VERSION
 * - totalRepos: all repos in org (type=all), excluding archived
 * - activeRepos: RepoOwner custom property is NOT empty and NOT a default-like placeholder
 *
 * Env:
 * - GH_PAT (required)
 * - DEBUG_REPOOWNER=1 (optional)
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
const DEBUG_REPOOWNER = process.env.DEBUG_REPOOWNER === '1';

// ---------- small utils ----------
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

// ---------- RepoOwner parsing / active logic ----------
function toLowerTrim(s) {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * Convert RepoOwner raw value into a list of strings.
 */
function repoOwnerToList(raw) {
  if (raw == null) return [];

  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    const v = String(raw).trim();
    return v ? [v] : [];
  }

  if (Array.isArray(raw)) {
    return raw.flatMap(repoOwnerToList).map(v => String(v).trim()).filter(Boolean);
  }

  if (typeof raw === 'object') {
    const fields = [raw.value, raw.name, raw.label, raw.display_name, raw.displayName];
    for (const f of fields) {
      const list = repoOwnerToList(f);
      if (list.length) return list;
    }
    return [];
  }

  return [];
}

/**
 * Check if value is a placeholder/default
 */
function isDefaultLike(v) {
  const s = toLowerTrim(v);

  if (!s) return true;

  // "default" variations
  if (s === 'default') return true;
  if (s.startsWith('default')) return true;

  // "Please choose a valid option!" and variations
  if (s === 'please choose a valid option!') return true;
  if (s.includes('please choose')) return true;
  if (s.includes('choose a valid option')) return true;
  if (s.includes('choose')) return true;

  return false;
}

/**
 * Active ONLY if there exists at least one NON-default-like value
 */
function isActiveByRepoOwner(rawRepoOwnerValue) {
  const values = repoOwnerToList(rawRepoOwnerValue).map(v => String(v).trim()).filter(Boolean);
  
  if (values.length === 0) {
    return false; // ❌ NOT ACTIVE - no value
  }

  // Check if ANY value is NOT default-like
  const hasNonDefault = values.some(v => !isDefaultLike(v));
  
  if (DEBUG_REPOOWNER) {
    console.log(`    Values: ${JSON.stringify(values)}, Has non-default: ${hasNonDefault}`);
  }
  
  return hasNonDefault; // ✅ ACTIVE only if non-default exists
}

// ---------- HTTP with rate-limit handling ----------
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

// ---------- concurrency ----------
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

// ---------- GitHub REST logic ----------
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

  return allRepos.filter(r => !r.archived);
}

async function getRepoOwnerCustomProperty(org, repo) {
  const url = `https://api.github.com/repos/${org}/${repo}/properties/values`;
  const result = await makeRequestWithRateLimitHandling(url);

  if (DEBUG_REPOOWNER) {
    console.log(`    [API Response] Status: ${result.status}, Data:`, JSON.stringify(result.data));
  }

  if (!result.success) {
    return { ok: false, value: null, status: result.status, error: result.data };
  }

  if (!result.data) {
    return { ok: true, value: null, status: result.status };
  }

  // Handle array response
  if (Array.isArray(result.data)) {
    const hit = result.data.find(p =>
      (p.property_name && p.property_name === 'RepoOwner') ||
      (p.propertyName && p.propertyName === 'RepoOwner') ||
      (p.name && p.name === 'RepoOwner')
    );

    if (!hit) {
      if (DEBUG_REPOOWNER) {
        console.log(`    [No RepoOwner found in properties]`);
      }
      return { ok: true, value: null, status: result.status };
    }

    // Extract value from different possible formats
    let value = null;
    if (hit.value !== undefined) value = hit.value;
    else if (hit.string_value !== undefined) value = hit.string_value;
    else if (hit.selected_value !== undefined) value = hit.selected_value;
    else if (hit.values !== undefined) value = hit.values;

    if (DEBUG_REPOOWNER) {
      console.log(`    [RepoOwner found] Raw value:`, JSON.stringify(value));
    }

    return { ok: true, value, status: result.status };
  }

  // Handle object response
  if (typeof result.data === 'object') {
    let value = null;
    if (result.data.value !== undefined) value = result.data.value;
    else if (result.data.string_value !== undefined) value = result.data.string_value;
    else if (result.data.selected_value !== undefined) value = result.data.selected_value;

    if (DEBUG_REPOOWNER) {
      console.log(`    [Object response] Value:`, JSON.stringify(value));
    }

    return { ok: true, value, status: result.status };
  }

  return { ok: true, value: null, status: result.status };
}

// ---------- caching ----------
function cacheKey(org, repo) {
  return `${org}/${repo}`;
}

async function collectData() {
  if (!PAT || !String(PAT).trim()) {
    console.error('❌ GH_PAT is not set. Please set GH_PAT.');
    process.exit(1);
  }

  const nowIso = new Date().toISOString();

  const dataDir = path.join(__dirname, '../docs/data');
  ensureDir(dataDir);

  const dashboardFile = path.join(dataDir, 'dashboard-data.json');
  const cacheFile = path.join(dataDir, 'repoowner-cache.json');
  const inactiveReportFile = path.join(dataDir, 'inactive-repos-report.json');

  const repoOwnerCache = safeJsonRead(cacheFile, {});

  const organizations = [];
  const trendEntry = { date: isoDateOnly(nowIso) };
  const inactiveReposReport = [];

  for (const org of ORGS) {
    console.log(`\n📦 Organization: ${org}`);

    const repos = await listOrgRepos(org);
    console.log(`  📊 Found ${repos.length} repositories (excluding archived)`);

    const toRefresh = repos.filter(r => {
      const key = cacheKey(org, r.name);
      const cached = repoOwnerCache[key];
      return !cached || cached.updated_at !== r.updated_at;
    });

    console.log(`  🔄 Checking RepoOwner for ${toRefresh.length}/${repos.length} repos`);

    let processedCount = 0;

    await mapWithConcurrency(toRefresh, 2, async (r) => {
      processedCount++;
      const { ok, value, status, error } = await getRepoOwnerCustomProperty(org, r.name);

      const list = repoOwnerToList(value);
      const active = ok && isActiveByRepoOwner(value);

      if (DEBUG_REPOOWNER) {
        console.log(`\n  [${processedCount}/${toRefresh.length}] ${org}/${r.name}`);
        console.log(`    Status: ${status}, OK: ${ok}`);
        console.log(`    Raw value: ${JSON.stringify(value)}`);
        console.log(`    List: ${JSON.stringify(list)}`);
        console.log(`    Active: ${active}`);
      }

      repoOwnerCache[cacheKey(org, r.name)] = {
        updated_at: r.updated_at,
        repoOwnerRaw: value,
        repoOwnerList: list,
        active,
        ok,
        cached_at: nowIso
      };

      // Track inactive repos
      if (!active) {
        inactiveReposReport.push({
          organization: org,
          repository: r.name,
          repoUrl: `https://github.com/${org}/${r.name}`,
          repoOwnerValue: value,
          repoOwnerList: list,
          status: '❌ NICHT AKTIV',
          reason: value === null ? 'Keine RepoOwner Custom Property gesetzt' : `Standard-Wert: "${value}"`,
          checkedAt: nowIso
        });
      }
    });

    const totalRepos = repos.length;

    const activeRepos = repos.filter(r => {
      const cached = repoOwnerCache[cacheKey(org, r.name)];
      return cached ? Boolean(cached.ok && cached.active) : false;
    }).length;

    const inactiveRepos = totalRepos - activeRepos;

    organizations.push({
      name: org,
      totalRepos,
      activeRepos,
      inactiveRepos,
      inactivePercentage: totalRepos > 0 ? ((inactiveRepos / totalRepos) * 100).toFixed(1) + '%' : '0%',
      lastUpdated: nowIso
    });

    trendEntry[org] = totalRepos;

    console.log(`\n  ✅ ${org}:`);
    console.log(`     - Total: ${totalRepos} repositories`);
    console.log(`     - ✅ Aktiv: ${activeRepos}`);
    console.log(`     - ❌ Nicht Aktiv: ${inactiveRepos}`);
  }

  const existingDashboard = safeJsonRead(dashboardFile, { organizations: [], trends: [] });
  let trends = Array.isArray(existingDashboard.trends) ? existingDashboard.trends : [];
  trends.push(trendEntry);
  if (trends.length > 90) trends = trends.slice(-90);

  safeJsonWrite(dashboardFile, { organizations, trends });
  safeJsonWrite(cacheFile, repoOwnerCache);
  safeJsonWrite(inactiveReportFile, {
    generatedAt: nowIso,
    totalInactiveRepos: inactiveReposReport.length,
    repos: inactiveReposReport
  });

  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('✅ Alle Daten gespeichert!');
  console.log('═════════════════════════════════��═════════════════════════');
  console.log(`🗃️  Cache: ${cacheFile}`);
  console.log(`📊 Dashboard: ${dashboardFile}`);
  console.log(`📋 Report (Nicht Aktiv): ${inactiveReportFile}`);
  console.log(`\n📈 Gesamt nicht aktive Repos: ${inactiveReposReport.length}`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

collectData().catch(console.error);
