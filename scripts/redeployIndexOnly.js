import { Client } from "ssh2";
import { getDeployConfig } from "./_sshConfig.js";

const localFile = "src/public/index.html";
const remoteFile = "/root/migratech/src/public/index.html";

const conn = new Client();

function runCommand(command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      stream
        .on("close", (code) => {
          if (code !== 0) {
            return reject(new Error(`Command failed (${code}): ${command}`));
          }
          resolve();
        })
        .on("data", (data) => {
          process.stdout.write(data);
        })
        .stderr.on("data", (data) => {
          process.stderr.write(data);
        });
    });
  });
}

conn
  .on("ready", () => {
    console.log("Client :: ready");

    conn.sftp((err, sftp) => {
      if (err) throw err;

      console.log(`Uploading ${localFile} to ${remoteFile}...`);
      sftp.fastPut(localFile, remoteFile, async (putErr) => {
        if (putErr) throw putErr;

        try {
          console.log("Rebuilding app container...");
          await runCommand("cd /root/migratech && docker compose up -d --build app");

          console.log("Checking app logs...");
          await runCommand("cd /root/migratech && docker compose logs --tail=30 app");

          console.log("Redeploy complete");
          conn.end();
        } catch (commandErr) {
          console.error(commandErr.message);
          conn.end();
          process.exitCode = 1;
        }
      });
    });
  })
  .on("error", (err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .connect(getDeployConfig());
