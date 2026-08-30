// Emergency firewall lockdown for the production VPS (66.92.247.31) — closes MySQL (3306)
// to the public internet. docker-compose.yml maps "3306:3306" on the `db` service, which
// means MySQL was reachable from anywhere with the trivial default credentials
// (migratech/migratech, root: migratech_root) baked into that same file. Found + fixed
// 2026-08-29.
//
// This only touches the host firewall, not Docker — the `app` container reaches `db` over
// Docker's internal bridge network by service name, entirely independent of the host's
// public-interface port mapping, so this cannot break the running app. SSH (22) and the
// site's own ports (80, 8000) are explicitly allowed before default-deny is turned on, in
// that order, specifically so this can't lock out SSH access.
//
// Usage: node scripts/lockdownFirewall.js

import { Client } from "ssh2";
import { getDeployConfig } from "./_sshConfig.js";

const conn = new Client();
const commands = [
  "ufw allow 22/tcp",
  "ufw allow 80/tcp",
  "ufw allow 8000/tcp",
  "ufw default deny incoming",
  "ufw default allow outgoing",
  "ufw --force enable",
  "ufw status verbose",
];

conn.on("ready", () => {
  console.log("Client :: ready");

  const executeCommand = (index) => {
    if (index >= commands.length) {
      console.log("Firewall lockdown complete.");
      conn.end();
      return;
    }
    const cmd = commands[index];
    console.log(`Executing: ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) throw err;
      stream
        .on("close", (code) => {
          if (code !== 0) console.error(`Command failed with code ${code} — stopping.`);
          else executeCommand(index + 1);
        })
        .on("data", (data) => process.stdout.write(data))
        .stderr.on("data", (data) => process.stderr.write(data));
    });
  };

  executeCommand(0);
}).connect(getDeployConfig());
