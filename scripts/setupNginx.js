
import { Client } from 'ssh2';
import { getDeployConfig } from './_sshConfig.js';

const domain = 'migra.ng';
const serverIp = '66.92.247.31';

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  
  const commands = [
    'apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx',
    // Create Nginx config
    `echo "server {
    listen 80;
    server_name ${domain} www.${domain};

    location / {
        proxy_pass http://localhost:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \\$host;
        proxy_cache_bypass \\$http_upgrade;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
    }
}" > /etc/nginx/sites-available/${domain}`,
    `ln -sf /etc/nginx/sites-available/${domain} /etc/nginx/sites-enabled/`,
    'rm -f /etc/nginx/sites-enabled/default',
    'nginx -t',
    'systemctl restart nginx'
  ];

  const executeCommand = (index) => {
    if (index >= commands.length) {
      console.log('Nginx setup complete. Ready for SSL once domain points to ' + serverIp);
      conn.end();
      return;
    }
    
    const cmd = commands[index];
    console.log(`Executing: ${cmd}`);
    
    conn.exec(cmd, (err, stream) => {
      if (err) throw err;
      stream.on('close', (code) => {
        if (code !== 0) console.error(`Command failed with code ${code}`);
        executeCommand(index + 1);
      }).on('data', (data) => {
        process.stdout.write(data);
      }).stderr.on('data', (data) => {
        process.stderr.write(data);
      });
    });
  };
  
  executeCommand(0);
}).connect(getDeployConfig());
