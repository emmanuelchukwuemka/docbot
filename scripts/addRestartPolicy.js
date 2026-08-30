// Companion to the docker-compose.yml edit adding `restart: unless-stopped` to both services
// (found the need for this the hard way 2026-08-29 — recreating `db` to close its exposed
// port crashed `app`'s connection and, with no restart policy, it just stayed down instead
// of self-healing). Patches the remote compose file the same way and brings both services up
// together in one `docker compose up -d` — recreating db and app in the same call, rather
// than the two separate calls used for the emergency port fix, is what keeps this blip short.
//
// Usage: node scripts/addRestartPolicy.js

import { Client } from "ssh2";
import { getDeployConfig } from "./_sshConfig.js";

const conn = new Client();
const remoteDir = "/root/migratech";

const commands = [
  `cd ${remoteDir} && sed -i '/MYSQL_ROOT_PASSWORD: migratech_root/a\\    restart: unless-stopped' docker-compose.yml`,
  `cd ${remoteDir} && sed -i '/ENVIRONMENT: development/a\\    restart: unless-stopped' docker-compose.yml`,
  `cd ${remoteDir} && cat docker-compose.yml`,
  `cd ${remoteDir} && docker compose up -d`,
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
