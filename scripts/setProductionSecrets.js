// One-off: writes real SESSION_SECRET_KEY / FIELD_ENCRYPTION_KEY into the remote .env,
// replacing the blank placeholders left over from deployRemote.js's `cp .env.example .env`
// step. Until this ran, both fell back to fixed, source-code-visible dev seeds (see
// security/sessionSecret.js / security/crypto.js) — meaning admin sessions were forgeable by
// anyone with the code, and document "encryption" used a publicly-known key. Found + fixed
// 2026-08-29. Requires an `app` container restart to pick up the new .env (not done by this
// script — see the deploy step that follows it).
//
// Usage: node scripts/setProductionSecrets.js

import { Client } from "ssh2";
import crypto from "node:crypto";
import { getDeployConfig } from "./_sshConfig.js";

const sessionKey = crypto.randomBytes(32).toString("hex");
const encKey = crypto.randomBytes(32).toString("base64");

const conn = new Client();
const remoteEnv = "/root/migratech/.env";

const commands = [
  `sed -i "s|^SESSION_SECRET_KEY=.*|SESSION_SECRET_KEY=${sessionKey}|" ${remoteEnv}`,
  `sed -i "s|^FIELD_ENCRYPTION_KEY=.*|FIELD_ENCRYPTION_KEY=${encKey}|" ${remoteEnv}`,
  `grep -E "^ADMIN_USERNAME=|^ADMIN_PASSWORD=|^SESSION_SECRET_KEY=|^FIELD_ENCRYPTION_KEY=" ${remoteEnv}`,
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
    console.log(`\n$ ${cmd.replace(sessionKey, "<redacted>").replace(encKey, "<redacted>")}`);
    conn.exec(cmd, (err, stream) => {
      if (err) throw err;
      stream
        .on("close", (code) => {
          if (code !== 0) console.error(`Command exited ${code}`);
          executeCommand(index + 1);
        })
        .on("data", (data) => process.stdout.write(data.toString().replace(sessionKey, "<redacted>").replace(encKey, "<redacted>")))
        .stderr.on("data", (data) => process.stderr.write(data));
    });
  };
  executeCommand(0);
}).connect(getDeployConfig());
