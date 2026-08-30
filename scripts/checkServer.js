
import { Client } from 'ssh2';
import fs from 'fs';
import path from 'path';
import { getDeployConfig } from './_sshConfig.js';

const conn = new Client();

const config = getDeployConfig();

conn.on('ready', () => {
  console.log('Client :: ready');
  conn.exec('uptime && docker -v && docker compose version', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
      conn.end();
    }).on('data', (data) => {
      console.log('STDOUT: ' + data);
    }).stderr.on('data', (data) => {
      console.log('STDERR: ' + data);
    });
  });
}).connect(config);
