
import { Client } from 'ssh2';
import { getDeployConfig } from './_sshConfig.js';

const domain = 'migra.ng';
const email = 'admin@migra.ng'; // Replace with a real email if needed

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  
  // Attempt to get SSL certificate using Certbot
  const cmd = `certbot --nginx -d ${domain} -d www.${domain} --non-interactive --agree-tos -m ${email} --redirect`;
  
  console.log(`Executing: ${cmd}`);
  
  conn.exec(cmd, (err, stream) => {
    if (err) throw err;
    stream.on('close', (code) => {
      if (code === 0) {
        console.log('SSL certificate obtained and Nginx configured successfully.');
      } else {
        console.error('Certbot failed. Make sure the domain points to this server IP.');
      }
      conn.end();
    }).on('data', (data) => {
      process.stdout.write(data);
    }).stderr.on('data', (data) => {
      process.stderr.write(data);
    });
  });
}).connect(getDeployConfig());
