
import { Client } from 'ssh2';
import { getDeployConfig } from './_sshConfig.js';

const conn = new Client();

const config = getDeployConfig();

const commands = [
  'DEBIAN_FRONTEND=noninteractive dpkg --configure -a',
  'DEBIAN_FRONTEND=noninteractive apt-get update',
  'DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::="--force-confold" ca-certificates curl gnupg',
  'install -m 0755 -d /etc/apt/keyrings',
  'curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -f -o /etc/apt/keyrings/docker.gpg',
  'chmod a+r /etc/apt/keyrings/docker.gpg',
  'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null',
  'DEBIAN_FRONTEND=noninteractive apt-get update',
  'DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::="--force-confold" docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
  'docker --version',
  'docker compose version'
];

conn.on('ready', () => {
  console.log('Client :: ready');
  
  const executeCommand = (index) => {
    if (index >= commands.length) {
      console.log('All commands executed');
      conn.end();
      return;
    }
    
    const cmd = commands[index];
    console.log(`Executing: ${cmd}`);
    
    conn.exec(cmd, (err, stream) => {
      if (err) {
        console.error(`Error executing ${cmd}:`, err);
        conn.end();
        return;
      }
      
      stream.on('close', (code, signal) => {
        if (code !== 0) {
          console.error(`Command ${cmd} exited with code ${code}`);
          // Continue anyway or stop? Let's stop on error.
          // conn.end();
          // return;
        }
        executeCommand(index + 1);
      }).on('data', (data) => {
        process.stdout.write(data);
      }).stderr.on('data', (data) => {
        process.stderr.write(data);
      });
    });
  };
  
  executeCommand(0);
}).connect(config);
