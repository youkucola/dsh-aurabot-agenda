// 日程插件的 SQLite 存储层：开库、推进 schema 版本、提供事务与受保护更新。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA_VERSION = 4;

export class StoreError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'StoreError';
    this.code = code;
  }
}

// node:sqlite 在真正要开库时才加载，避免模块被加载时报错。
let DatabaseSyncClass = null;

async function loadDatabaseSync() {
  if (DatabaseSyncClass) return DatabaseSyncClass;
  let mod;
  try {
    mod = await import('node:sqlite');
  } catch (err) {
    throw new StoreError('store_unavailable', `无法加载 node:sqlite：${err?.message ?? err}`);
  }
  if (typeof mod?.DatabaseSync !== 'function') {
    throw new StoreError('store_unavailable', 'node:sqlite 没有导出 DatabaseSync');
  }
  DatabaseSyncClass = mod.DatabaseSync;
  return DatabaseSyncClass;
}

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS agenda_meta (
  key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS agenda_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('role_plan','user_report','commitment')),
  state TEXT NOT NULL CHECK(state IN ('active','cancelled','deleted')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  presence TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 1 AND 1440),
  anchor TEXT NOT NULL,
  timezone TEXT NOT NULL,
  frequency TEXT NOT NULL,
  interval INTEGER NOT NULL CHECK(interval >= 1),
  count INTEGER,
  fold INTEGER NOT NULL CHECK(fold IN (0,1)),
  gap_policy TEXT NOT NULL CHECK(gap_policy IN ('reject','shift_forward')),
  creator_kind TEXT NOT NULL CHECK(creator_kind IN ('owner','role')),
  accepted INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agenda_events_time_idx ON agenda_events(state, anchor, event_id);
CREATE INDEX IF NOT EXISTS agenda_events_kind_idx ON agenda_events(kind, state, anchor);
`;

const DDL_V2 = `
CREATE TABLE IF NOT EXISTS agenda_event_history (
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id, revision));

CREATE TABLE IF NOT EXISTS agenda_exceptions (
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  occurrence_anchor TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id, sequence));

CREATE TABLE IF NOT EXISTS agenda_reminders (
  reminder_id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','cancelled')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  message TEXT NOT NULL DEFAULT '',
  anchor TEXT NOT NULL,
  timezone TEXT NOT NULL,
  frequency TEXT NOT NULL,
  interval INTEGER NOT NULL CHECK(interval >= 1),
  count INTEGER,
  fold INTEGER NOT NULL CHECK(fold IN (0,1)),
  gap_policy TEXT NOT NULL CHECK(gap_policy IN ('reject','shift_forward')),
  lead_minutes INTEGER NOT NULL DEFAULT 0 CHECK(lead_minutes BETWEEN 0 AND 1440),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agenda_reminders_state_idx ON agenda_reminders(state, anchor, reminder_id);
`;

const DDL_V3 = `
CREATE TABLE IF NOT EXISTS agenda_occurrences (
  occurrence_id TEXT PRIMARY KEY NOT NULL,
  reminder_id TEXT NOT NULL,
  reminder_revision INTEGER NOT NULL CHECK(reminder_revision > 0),
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  due_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('scheduled','cancelled')),
  updated_at TEXT NOT NULL,
  UNIQUE(reminder_id, reminder_revision, sequence));
CREATE INDEX IF NOT EXISTS agenda_occurrences_due_idx ON agenda_occurrences(state, due_at, occurrence_id);

CREATE TABLE IF NOT EXISTS agenda_dispatches (
  occurrence_id TEXT PRIMARY KEY NOT NULL,
  occurrence_revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('queued','skipped','failed')),
  reason TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL);
`;

// v4：每日生成器的一次性记账。只加表，不动任何旧表，v3 的库升级上来行为不变。
const DDL_V4 = `
CREATE TABLE IF NOT EXISTS agenda_planning_slots (
  slot TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','done','empty','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  result_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agenda_planning_slots_state_idx ON agenda_planning_slots(state, updated_at);
`;

// 迁移完成后必须存在的表；少任何一张都说明库是不完整的。
export const REQUIRED_TABLES = Object.freeze([
  'agenda_meta',
  'agenda_events',
  'agenda_event_history',
  'agenda_exceptions',
  'agenda_reminders',
  'agenda_occurrences',
  'agenda_dispatches',
  'agenda_planning_slots',
]);

// 表名通过参数绑定比较，不做字符串拼接。
function tableExists(db, name) {
  let row;
  try {
    row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  } catch (err) {
    throw new StoreError('store_unavailable', `检查表 ${name} 是否存在失败：${err?.message ?? err}`);
  }
  return Boolean(row);
}

// 自愈式迁移：DDL 全部是 IF NOT EXISTS，所以无条件执行是幂等的。
// 之所以不能再用 `if (version < N)`：一旦 user_version 领先于磁盘上真实的 schema
// （例如某次发布先写了 PRAGMA user_version = 4、建表语句却还没生效），
// 那些条件会永久为假，缺失的表就再也补不回来了。
export function migrate(db) {
  let version = 0;
  try {
    const row = db.prepare('PRAGMA user_version').get();
    version = Number(row?.user_version ?? 0);
  } catch (err) {
    throw new StoreError('store_unavailable', `读取 schema 版本失败：${err?.message ?? err}`);
  }
  if (!Number.isFinite(version) || version < 0) version = 0;
  // 版本更高的库一律不碰：这条检查必须早于任何 DDL。
  if (version > SCHEMA_VERSION) {
    throw new StoreError('schema_too_new', `数据库版本 ${version} 高于当前支持的 ${SCHEMA_VERSION}`);
  }
  try {
    db.exec(DDL_V1);
    db.exec(DDL_V2);
    db.exec(DDL_V3);
    db.exec(DDL_V4);
  } catch (err) {
    throw new StoreError('store_unavailable', `初始化日程库失败：${err?.message ?? err}`);
  }
  // 建表之后复查：理论上不可达，留作兜底，避免带着残缺的库继续跑。
  const missing = REQUIRED_TABLES.filter((name) => !tableExists(db, name));
  if (missing.length) {
    throw new StoreError('store_incomplete', `数据库缺少表：${missing.join('、')}`);
  }
  if (version < SCHEMA_VERSION) {
    try {
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } catch (err) {
      throw new StoreError('store_unavailable', `初始化日程库失败：${err?.message ?? err}`);
    }
  }
  return SCHEMA_VERSION;
}

// 带 revision 条件的更新：影响行数必须正好 1，否则视为版本冲突。
export function updateGuarded(db, sql, params = [], expectedRevision, label) {
  let result;
  try {
    result = db.prepare(sql).run(...params);
  } catch (err) {
    throw new StoreError('store_unavailable', `受保护更新执行失败：${err?.message ?? err}`);
  }
  const changes = Number(result?.changes ?? 0);
  if (changes !== 1) {
    const suffix = expectedRevision === undefined ? '' : `（期望 revision ${expectedRevision}）`;
    throw new StoreError('revision_conflict', `${label ?? '版本冲突'}${suffix}`);
  }
  return changes;
}

// 已经在事务里的库直接执行，内层异常交给外层统一回滚。
const ACTIVE_TX = new WeakSet();

export function tx(db, fn) {
  if (ACTIVE_TX.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  ACTIVE_TX.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    ACTIVE_TX.delete(db);
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败时保留原始异常
    }
    ACTIVE_TX.delete(db);
    throw err;
  }
}

export async function openStore({ dir, filename = 'agenda.sqlite' } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new StoreError('store_unavailable', 'openStore 需要提供存储目录 dir');
  }
  const DatabaseSync = await loadDatabaseSync();
  const target = join(dir, filename);
  let db = null;
  try {
    mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(target);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (err) {
    try {
      db?.close();
    } catch {
      // 半开的连接不再复用
    }
    db = null;
    if (err instanceof StoreError) throw err;
    throw new StoreError('store_unavailable', `无法打开日程库 ${target}：${err?.message ?? err}`);
  }
  let active = true;
  return {
    db,
    path: target,
    close() {
      if (!active) return;
      active = false;
      db.close();
    },
  };
}

// ---------- 每日生成的记账（agenda_planning_slots）----------
// 一个 slot 代表「某天在某个时区该生成一次」；planner 只通过这些薄封装读写，SQL 不外流。

export const PLANNING_SLOT_STATES = Object.freeze(['running', 'done', 'empty', 'failed']);
const SLOT_LIMIT_DEFAULT = 20;
const SLOT_LIMIT_MAX = 200;

function slotKey(slot) {
  const key = String(slot ?? '').trim();
  if (!key) throw new StoreError('invalid_slot', 'slot 不能为空');
  return key;
}

function slotRow(row) {
  if (!row) return null;
  let result = null;
  const raw = String(row.result_json ?? '');
  if (raw !== '') {
    try {
      result = JSON.parse(raw);
    } catch {
      // 坏掉的记账不该拖垮面板 / 生成，当作没有结果
      result = null;
    }
  }
  return {
    slot: String(row.slot),
    state: String(row.state),
    attempts: Number(row.attempts) || 0,
    result,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function readPlanningSlot(db, slot) {
  const key = slotKey(slot);
  let row;
  try {
    row = db.prepare(`SELECT slot, state, attempts, result_json, created_at, updated_at
      FROM agenda_planning_slots WHERE slot = ?`).get(key);
  } catch (err) {
    throw new StoreError('store_unavailable', `读取生成状态失败：${err?.message ?? err}`);
  }
  return slotRow(row);
}

export function writePlanningSlot(db, slot, { state, attempts, result } = {}) {
  const key = slotKey(slot);
  if (!PLANNING_SLOT_STATES.includes(state)) {
    throw new StoreError('invalid_slot_state', `state 必须是 ${PLANNING_SLOT_STATES.join(' / ')}`);
  }
  const rawAttempts = Math.trunc(Number(attempts));
  const tries = Number.isFinite(rawAttempts) && rawAttempts > 0 ? rawAttempts : 0;
  let json = '';
  if (typeof result === 'string') json = result;
  else if (result !== undefined && result !== null) json = JSON.stringify(result);
  const at = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO agenda_planning_slots (slot, state, attempts, result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(slot) DO UPDATE SET
        state = excluded.state,
        attempts = excluded.attempts,
        result_json = excluded.result_json,
        updated_at = excluded.updated_at`).run(key, state, tries, json, at, at);
  } catch (err) {
    throw new StoreError('store_unavailable', `写入生成状态失败：${err?.message ?? err}`);
  }
  return readPlanningSlot(db, key);
}

export function deletePlanningSlot(db, slot) {
  const key = slotKey(slot);
  try {
    const info = db.prepare('DELETE FROM agenda_planning_slots WHERE slot = ?').run(key);
    return Number(info?.changes ?? 0) > 0;
  } catch (err) {
    throw new StoreError('store_unavailable', `删除生成状态失败：${err?.message ?? err}`);
  }
}

export function listPlanningSlots(db, { limit = SLOT_LIMIT_DEFAULT } = {}) {
  const raw = Math.trunc(Number(limit));
  const size = Number.isFinite(raw) ? Math.min(SLOT_LIMIT_MAX, Math.max(1, raw)) : SLOT_LIMIT_DEFAULT;
  let rows;
  try {
    rows = db.prepare(`SELECT slot, state, attempts, result_json, created_at, updated_at
      FROM agenda_planning_slots ORDER BY updated_at DESC, slot DESC LIMIT ?`).all(size);
  } catch (err) {
    throw new StoreError('store_unavailable', `列出生成状态失败：${err?.message ?? err}`);
  }
  return rows.map(slotRow);
}