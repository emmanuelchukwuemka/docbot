// Usage: node scripts/changeAdmin.js <username> <password>
//
// Used to hardcode a real admin username/password pair directly in source — harmless while
// this repo stayed unpushed, but it's public on GitHub, so that would have published the live
// admin-panel login permanently in git history. Found + fixed 2026-08-30: takes the
// credentials as CLI args instead (same convention as scripts/createAdminUser.js), never
// written to a file.

import { Client } from 'ssh2';
import { getDeployConfig } from './_sshConfig.js';

const [newUsername, newPassword] = process.argv.slice(2);
if (!newUsername || !newPassword) {
  console.error('Usage: node scripts/changeAdmin.js <username> <password>');
  process.exit(1);
}

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  
  // 1. Update .env file on server
  const updateEnv = `sed -i "s/ADMIN_USERNAME=.*/ADMIN_USERNAME=${newUsername}/" /root/migratech/.env && sed -i "s/ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${newPassword}/" /root/migratech/.env`;
  
  // 2. Run the creation script inside the docker container
  const runScript = `docker exec migratech-app-1 node scripts/createAdminUser.js ${newUsername} ${newPassword} --role admin`;

  conn.exec(`${updateEnv} && ${runScript}`, (err, stream) => {
    if (err) throw err;
    stream.on('close', (code) => {
      console.log('Stream :: close :: code: ' + code);
      conn.end();
    }).on('data', (data) => {
      process.stdout.write(data);
    }).stderr.on('data', (data) => {
      process.stderr.write(data);
    });
  });
}).connect(getDeployConfig());
