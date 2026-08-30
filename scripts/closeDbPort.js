// Emergency companion to the docker-compose.yml edit removing db's "3306:3306" port mapping
// (found+fixed 2026-08-29 — see that file's comment). Patches the already-deployed remote
// compose file the same way and recreates just the `db` service so the fix takes effect
// immediately, without waiting for a full app redeploy. Safe to run again later as a no-op
// once a full redeploy has carried this same fix from the repo.
//
// Usage: node scripts/closeDbPort.js

import { Client } from "ssh2";
import { getDeployConfig } from "./_sshConfig.js";

const conn = new Client();
const remoteDir = "/root/migratech";

const commands = [
  // Remove the two-line `ports:` block under the db service (the "3306:3306" mapping and its
  // header) via sed, then bring db back up with the new config — compose only recreates the
  // service whose definition actually changed.
  `cd ${remoteDir} && sed -i '/ports:/{N;/"3306:3306"/d}' docker-compose.yml`,
  `cd ${remoteDir} && grep -A2 "db:" docker-compose.yml | head -10`,
  `cd ${remoteDir} && docker compose up -d db`,
  `cd ${remoteDir} && docker compose ps`,
];

conn.on("ready", () => {
  console.log("Client :: ready");
  const executeCommand = (index) => {
    if (index >= commands.length) {
      console.log("Done.");
      conn.end();
      return;
    }
    const cmd = commands[index];
    console.log(`\n$ ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) throw err;
      stream
        .on("close", (code) => {
          if (code !== 0) console.error(`Command exited ${code}`);
          executeCommand(index + 1);
        })
        .on("data", (data) => process.stdout.write(data))
        .stderr.on("data", (data) => process.stderr.write(data));
    });
  };
  executeCommand(0);
}).connect(getDeployConfig());
