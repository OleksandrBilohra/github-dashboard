const https = require('https');
const fs = require('fs');
const path = require('path');

const PAT = process.env.GH_PAT;

console.log('PAT provided:', PAT ? 'YES' : 'NO');
console.log('PAT length:', PAT ? PAT.length : 0);

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
      console.log(`${url} - Status: ${res.statusCode}`);
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
          console.log(`Response: ${data.substring(0, 200)}`);
          resolve([]);
        }
      });
    }).on('error', reject);
  });
}

async function collectData() {
  const ORGS = ['AS-ASK-IT'];
  
  for (const org of ORGS) {
    console.log(`\nTesting: ${org}`);
    const repos = await makeRequest(`https://api.github.com/orgs/${org}/repos?per_page=10`);
    console.log(`Got ${Array.isArray(repos) ? repos.length : 'invalid'} repos`);
  }
}

collectData().catch(console.error);
