// Local encrypted file storage for uploaded documents (FR-08).
//
// PRD section 28 suggests "Secure cloud object storage" (e.g. S3) — that needs real cloud
// credentials MigraTech hasn't provided. This is a local-disk implementation behind a small
// interface so swapping in S3/GCS later means writing one new class, not touching callers.
// Every file is AES-256-GCM-encrypted before being written (see security/crypto.js) —
// "at rest" actually means at rest here, not just "in a folder."

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { settings } from "../config.js";
import { decryptBytes, encryptBytes } from "../security/crypto.js";

export class LocalEncryptedStorage {
  constructor(baseDir = null) {
    this.baseDir = baseDir || settings.documentStorageDir;
  }

  save(userId, filename, content) {
    const userDir = path.join(this.baseDir, userId);
    fs.mkdirSync(userDir, { recursive: true });
    const safeName = `${crypto.randomBytes(16).toString("hex")}_${path.basename(filename)}.enc`;
    const filePath = path.join(userDir, safeName);
    fs.writeFileSync(filePath, encryptBytes(content));
    return filePath;
  }

  read(filePath) {
    return decryptBytes(fs.readFileSync(filePath));
  }

  delete(filePath) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}
