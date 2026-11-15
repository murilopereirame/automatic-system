/** Opens the SQLite database and creates the schema. */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  hook_secret TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,
  step_index INTEGER NOT NULL DEFAULT 0,
  definition TEXT NOT NULL,
  context TEXT NOT NULL,
  workspace TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_workflow ON runs (workflow_id, created_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_run ON events (run_id, id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Remembers which external items already started a run (e.g. ClickUp task ids).
CREATE TABLE IF NOT EXISTS trigger_seen (
  workflow_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (workflow_id, key)
);
`;

function open(): DatabaseSync {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path.join(config.dataDir, 'autoworker.db'));
  database.exec('PRAGMA journal_mode = WAL');
  database.exec(SCHEMA);
  return database;
}

export const db = open();

export function now(): string {
  return new Date().toISOString();
}
