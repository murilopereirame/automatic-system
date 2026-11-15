/**
 * Secret store. Values are encrypted at rest with AES-256-GCM using a key
 * derived from AUTOWORKER_SECRET_KEY. The API only ever returns secret names.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { config } from '../config.js';
import { db, now } from '../db.js';

const key = scryptSync(config.secretKey || 'autoworker-insecure-default', 'autoworker-secrets', 32);

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64')).join('.');
}

function decrypt(stored: string): string {
  const [iv, tag, body] = stored.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function listSecretNames(): string[] {
  const rows = db.prepare('SELECT name FROM secrets ORDER BY name').all() as { name: string }[];
  return rows.map((row) => row.name);
}

export function setSecret(name: string, value: string): void {
  db.prepare(
    `INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(name, encrypt(value), now());
}

export function deleteSecret(name: string): void {
  db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
}

export function getSecret(name: string): string | undefined {
  const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return decrypt(row.value);
  } catch {
    throw new Error(`Secret "${name}" cannot be decrypted. Was AUTOWORKER_SECRET_KEY changed?`);
  }
}

/** Returns the secret or throws an error that tells the user what to configure. */
export function requireSecret(name: string): string {
  const value = getSecret(name);
  if (!value) throw new Error(`Secret "${name}" is not set. Add it under Settings > Secrets.`);
  return value;
}
