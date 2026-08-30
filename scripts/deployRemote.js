
import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';
import { getDeployConfig } from './_sshConfig.js';

const conn = new Client();

const config = getDeployConfig();

const localFilePath = 'project.tar.gz';
const remoteFilePath = '/root/project.tar.gz';
const remoteDir = '/root/migratech';

conn.on('ready', () => {
  console.log('Client :: ready');
  
  conn.sftp((err, sftp) => {
    if (err) throw err;
    
    console.log('Uploading tarball...');
    sftp.fastPut(localFilePath, remoteFilePath, (err) => {
      if (err) throw err;
      console.log('Upload successful');
      
      const commands = [
        `mkdir -p ${remoteDir}`,
        // Deliberately does NOT extract over .env — the tarball this uploads is built
        // excluding .env in the first place (see the tar command that produces
        // project.tar.gz), specifically so this can never overwrite whatever real secrets
        // are already configured on the server, the way this script used to on every run
        // (found + fixed 2026-08-29, after it had left production running for hours on
        // nothing but blank .env.example placeholders — see scripts/setProductionSecrets.js).
        `tar -xzf ${remoteFilePath} -C ${remoteDir}`,
        // Only seed .env from the example on a truly first-ever deploy where it doesn't
        // exist yet. Never overwrites an existing one.
        `[ -f ${remoteDir}/.env ] || cp ${remoteDir}/.env.example ${remoteDir}/.env`,
        `cd ${remoteDir} && docker compose up -d --build`
      ];
      
      const executeCommand = (index) => {
        if (index >= commands.length) {
          console.log('Deployment complete');
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
    });
  });
}).connect(config);
