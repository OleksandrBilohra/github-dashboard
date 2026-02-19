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
          resolve({ success: res.statusCode === 200, data: JSON.parse(data) });
        } catch {
          resolve({ success: false, data: [] });
        }
      });
    }).on('error', () => resolve({ success: false, data: [] }));
  });
}

async function getOrgRepos(org) {
  console.log(`📦 ${org}`);
  
  let allRepos = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`;
    const result = await makeRequest(url);
    
    if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
      break;
    }
    
    allRepos = allRepos.concat(result.data);
    if (result.data.length < 100) break;
    page++;
  }

  // Check last commit date for each repo
  let activeRepos = 0;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  for (const repo of allRepos) {
    const commitsUrl = `https://api.github.com/repos/${org}/${repo.name}/commits?per_page=1`;
    const commitsResult = await makeRequest(commitsUrl);
    
    if (commitsResult.success && Array.isArray(commitsResult.data) && commitsResult.data.length > 0) {
      const lastCommitDate = new Date(commitsResult.data[0].commit.committer.date);
      if (lastCommitDate > thirtyDaysAgo) {
        activeRepos++;
      }
    }
  }

  const totalRepos = allRepos.length;
  const percentage = totalRepos > 0 ? Math.round((activeRepos / totalRepos) * 100) : 0;

  return { totalRepos, activeRepos, percentage };
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
      const { totalRepos, activeRepos, percentage } = await getOrgRepos(org);
      
      organizations.push({
        name: org,
        totalRepos: totalRepos,
        activeRepos: activeRepos,
        ownershipPercentage: percentage,
        lastUpdated: new Date().toISOString()
      });

      console.log(`  ✅ ${org}: ${activeRepos}/${totalRepos} repos active (${percentage}%)\n`);
      trendEntry[org] = percentage;
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
