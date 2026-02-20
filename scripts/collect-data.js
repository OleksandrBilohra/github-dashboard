const https = require('https');
const fs = require('fs');
const path = require('path');

const PAT = process.env.GH_PAT;

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
        try {
          resolve({ success: res.statusCode === 200, data: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ success: false, data: [] });
        }
      });
    }).on('error', () => resolve({ success: false, data: [] }));
  });
}

async function getOrgRepos(org) {
  console.log(`📦 ${org}`);
  
  // Get first page to know total count
  const firstUrl = `https://api.github.com/orgs/${org}/repos?per_page=100&page=1&type=all`;
  const firstResult = await makeRequest(firstUrl);
  
  if (!firstResult.success || !Array.isArray(firstResult.data)) {
    console.log(`  ❌ ${org}: Failed\n`);
    return { totalRepos: 0, activeRepos: 0 };
  }

  let allRepos = firstResult.data;
  const linkHeader = firstResult.headers.link;
  
  // Parse total pages from link header
  let totalPages = 1;
  if (linkHeader) {
    const lastMatch = linkHeader.match(/page=(\d+)>; rel="last"/);
    if (lastMatch) totalPages = parseInt(lastMatch[1]);
  }

  // Fetch remaining pages in parallel
  if (totalPages > 1) {
    const promises = [];
    for (let page = 2; page <= Math.min(totalPages, 5); page++) {
      const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`;
      promises.push(makeRequest(url));
    }
    
    const results = await Promise.all(promises);
    results.forEach(result => {
      if (result.success && Array.isArray(result.data)) {
        allRepos = allRepos.concat(result.data);
      }
    });
  }

  const totalRepos = allRepos.length;
  console.log(`  ✅ ${org}: ${totalRepos} repos\n`);
  return { totalRepos, activeRepos: 0 };
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

  // Fetch all orgs in parallel
  const promises = ORGS.map(async (org) => {
    try {
      const { totalRepos, activeRepos } = await getOrgRepos(org);
      
      return {
        name: org,
        totalRepos: totalRepos,
        activeRepos: activeRepos,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error(`❌ ${org}: ${error.message}`);
      return {
        name: org,
        totalRepos: 0,
        activeRepos: 0,
        lastUpdated: new Date().toISOString()
      };
    }
  });

  const results = await Promise.all(promises);
  results.forEach(org => {
    organizations.push(org);
    trendEntry[org.name] = org.totalRepos;
  });

  const dataDir = path.join(__dirname, '../docs/data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  
  let trends = [];
  const dataFile = path.join(dataDir, 'dashboard-data.json');
  if (fs.existsSync(dataFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      trends = existing.trends || [];
    } catch (e) {
      trends = [];
    }
  }

  trends.push(trendEntry);
  if (trends.length > 90) trends = trends.slice(-90);
  
  fs.writeFileSync(
    dataFile,
    JSON.stringify({ organizations, trends }, null, 2)
  );

  console.log('✅ Data saved!');
}

collectData().catch(console.error);
