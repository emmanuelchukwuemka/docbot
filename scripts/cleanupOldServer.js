
import { Client } from 'ssh2';
import { getOldServerConfig } from './_sshConfig.js';

const conn = new Client();

const config = getOldServerConfig();

conn.on('ready', () => {
  console.log('Client :: ready');
  
  // Commands to find and remove processes on port 8002, and potentially docker containers
  const commands = [
    'kill 110928',
    'netstat -tulpn | grep :8002',
    'rm -rf /root/migratech' // Assuming this is where the old app lives based on current patterns
  ];
  
  const executeCommand = (index) => {
    if (index >= commands.length) {
      conn.end();
      return;
    }
    
    const cmd = commands[index];
    console.log(`Executing: ${cmd}`);
    
    conn.exec(cmd, (err, stream) => {
      if (err) throw err;
      stream.on('close', (code) => {
        executeCommand(index + 1);
      }).on('data', (data) => {
        process.stdout.write(data);
      }).stderr.on('data', (data) => {
        process.stderr.write(data);
      });
    });
  };
  
  executeCommand(0);
}).on('error', (err) => {
  console.error('Connection Error:', err);
}).connect(config);
