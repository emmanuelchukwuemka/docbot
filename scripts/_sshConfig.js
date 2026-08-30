// Shared remote-connection config for the one-off ops scripts in this folder.
//
// These used to hardcode the production root SSH password (and, in changeAdmin.js's case,
// the actual admin panel password) directly in source — harmless while the repo stayed
// unpushed, but this repo is public on GitHub, so committing that would have published live
// infrastructure credentials permanently in git history. Found + fixed 2026-08-30, moved to
// environment variables (loaded from .env, already gitignored) instead.
//
// Add these to .env before running any script that imports this file (see .env.example):
//   DEPLOY_SSH_HOST, DEPLOY_SSH_USER, DEPLOY_SSH_PASSWORD       — current production VPS
//   OLD_SERVER_SSH_HOST, OLD_SERVER_SSH_USER, OLD_SERVER_SSH_PASSWORD — decommissioned box
//   (cleanupOldServer.js only)

import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — add it to .env before running this script (see .env.example).`);
  }
  return value;
}

export function getDeployConfig() {
  return {
    host: process.env.DEPLOY_SSH_HOST || "66.92.247.31",
    port: 22,
    username: process.env.DEPLOY_SSH_USER || "root",
    password: required("DEPLOY_SSH_PASSWORD"),
  };
}

export function getOldServerConfig() {
  return {
    host: process.env.OLD_SERVER_SSH_HOST || "72.62.4.119",
    port: 22,
    username: process.env.OLD_SERVER_SSH_USER || "root",
    password: required("OLD_SERVER_SSH_PASSWORD"),
  };
}
