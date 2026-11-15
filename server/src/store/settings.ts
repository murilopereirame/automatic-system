import { db } from '../db.js';
import type { Settings } from '../types.js';

const DEFAULTS: Settings = { git: { name: '', email: '' } };

export function getSettings(): Settings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
  return row ? { ...DEFAULTS, ...JSON.parse(row.value) } : DEFAULTS;
}

export function saveSettings(settings: Settings): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('settings', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(settings));
}
