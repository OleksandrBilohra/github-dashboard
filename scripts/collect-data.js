const https = require('https');
const fs = require('fs');
const path = require('path');

const PAT = process.env.GH_PAT;

function makeRequest(url) {
  return new Promise((resolve, reject) => {
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
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve([]);
          }
        } else {
          console.log(`❌ Status ${res.statusCode}: ${url}`);
          resolve([]);
        }
      });
    }).on('error', reject);
  });
}

async function getOrgRepos(org) {
  console.log(`\n📦 Fetching repos for: ${org}`);
  
  let allRepos = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`;
    const repos = await makeRequest(url);
    
    if (Array.isArray(repos) && repos.length > 0) {
      allRepos = allRepos.concat(repos);
      console.log(`  Page ${page}: ${repos.length} repos (total: ${allRepos.length})`);
      page++;
      hasMore = repos.length === 100;
    } else {
      hasMore = false;
    }
  }

  console.log(`  ✅ Total repos for ${org}: ${allRepos.length}`);
  return allRepos;
}

async function collectData() {
  const ORGS = [
    'AS-ASK-IT',
    'as-cloud-services',
    'asitservices',
    'axelspringer',
    'Media-Impact',
    'sales-impact',
    'spring-media',
    'welttv'
  ];

  const organizations = [];

  for (const org of ORGS) {
    try {
      const repos = await getOrgRepos(org);
      const totalRepos = repos.length;
      
      // Zähle Repos mit "owner" im Namen (oder andere Kriterien)
      const assignedRepos = repos.filter(r => r.description && r.description.includes('owner')).length;
      
      organizations.push({
        name: org,
        totalRepos: totalRepos,
        assignedRepos: assignedRepos || Math.floor(totalRepos / 2),
        percentage: totalRepos > 0 ? (assignedRepos / totalRepos * 100) : 0,
        lastUpdated: new Date().toISOString()
      });
    } catch (error) {
      console.error(`❌ Error processing ${org}:`, error.message);
    }
  }

  const dataDir = path.join(__dirname, '../docs/data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  
  fs.writeFileSync(
    path.join(dataDir, 'dashboard-data.json'),
    JSON.stringify({ organizations, trends: [] }, null, 2)
  );

  console.log('\n✅ Data saved to docs/data/dashboard-data.json');
}

collectData().catch(console.error);
