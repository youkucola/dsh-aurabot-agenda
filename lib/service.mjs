// 日程业务层：事件版本化读写、期次展开、提醒铺期、到期扫描与认领闸门。

import { randomUUID } from 'node:crypto';

import {
  MAX_OCCURRENCES,
  MAX_SPAN_MS,
  ScheduleError,
  describeSchedule,
  firstAtOrAfter,
  normalizeSchedule,
  occurrences,
  scheduleAt,
  scheduleToJson,
} from './schedule.mjs';
import { TimeError } from './time.mjs';
import { StoreError, tx, updateGuarded } from './store.mjs';

const KINDS = ['role_plan', 'user_report', 'commitment'];
const CREATOR_KINDS = ['owner', 'role'];
const DISPATCH_STATES = ['queued', 'skipped', 'failed'];
const MINUTE_MS = 60000;
const DAY_MS = 86400000;
const DEFAULT_HORIZON_MS = 7 * DAY_MS;
const EXPAND_CAP = 128;
const TEXT_LIMITS = { title: 200, detail: 8000, presence: 500, message: 500 };
const DISPATCH_REASON_LIMIT = 500;

const EVENT_COLUMNS = `event_id, kind, state, revision, title, detail, presence, duration_minutes,
  anchor, timezone, frequency, interval, count, fold, gap_policy,
  creator_kind, accepted, created_at, updated_at`;
const EVENT_INSERT = `INSERT INTO agenda_events (${EVENT_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const EVENT_UPDATE = `UPDATE agenda_events SET
  kind = ?, state = ?, revision = ?, title = ?, detail = ?, presence = ?, duration_minutes = ?,
  anchor = ?, timezone = ?, frequency = ?, interval = ?, count = ?, fold = ?, gap_policy = ?,
  creator_kind = ?, accepted = ?, created_at = ?, updated_at = ?
  WHERE event_id = ? AND revision = ?`;

const REMINDER_COLUMNS = `reminder_id, event_id, state, revision, message, anchor, timezone, frequency,
  interval, count, fold, gap_policy, lead_minutes, created_at, updated_at`;
const REMINDER_INSERT = `INSERT INTO agenda_reminders (${REMINDER_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const REMINDER_UPDATE = `UPDATE agenda_reminders SET
  event_id = ?, state = ?, revision = ?, message = ?, anchor = ?, timezone = ?, frequency = ?,
  interval = ?, count = ?, fold = ?, gap_policy = ?, lead_minutes = ?, created_at = ?, updated_at = ?
  WHERE reminder_id = ? AND revision = ?`;

const OCCURRENCE_INSERT = `INSERT OR IGNORE INTO agenda_occurrences
  (occurrence_id, reminder_id, reminder_revision, sequence, due_at, state, updated_at)
  VALUES (?, ?, ?, ?, ?, 'scheduled', ?)`;
const DISPATCH_PLACEHOLDER = `INSERT OR IGNORE INTO agenda_dispatches
  (occurrence_id, occurrence_revision, state, reason, observed_at)
  VALUES (?, ?, 'queued', 'claimed', ?)`;
const DISPATCH_UPSERT = `INSERT INTO agenda_dispatches
  (occurrence_id, occurrence_revision, state, reason, observed_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(occurrence_id) DO UPDATE SET
    state = excluded.state, reason = excluded.reason, observed_at = excluded.observed_at`;

export class AgendaError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'AgendaError';
    this.code = code;
  }
}

export function createEventId() {
  return `evt_${randomUUID()}`;
}

export function createReminderId() {
  return `rem_${randomUUID()}`;
}

function stamp(ms) {
  return new Date(ms).toISOString();
}

function toMs(value, code = 'invalid_event') {
  let ms = value instanceof Date ? value.getTime() : value;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
    throw new AgendaError(code, '时间必须是有效毫秒数或 Date');
  }
  return ms;
}

// 时间库的细分错误码不外泄，统一收敛成契约允许的几种。
function scheduleErrorCode(code) {
  if (code === 'schedule_out_of_range' || code === 'invalid_max') return 'agenda_limit_exceeded';
  return 'invalid_schedule';
}

function viaSchedule(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ScheduleError || err instanceof TimeError) {
      throw new AgendaError(scheduleErrorCode(err.code), err.message);
    }
    throw err;
  }
}

function viaStore(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof StoreError) {
      // 版本冲突翻成业务错误；其余存储层故障保持 StoreError，便于区分重试与用户输入问题。
      if (err.code === 'revision_conflict') {
        throw new AgendaError('agenda_revision_conflict', err.message);
      }
      throw err;
    }
    throw err;
  }
}

function requireId(value, field, code = 'invalid_event') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgendaError(code, `${field} 必须是非空字符串`);
  }
  return value.trim();
}

function text(value, field, { code = 'invalid_event', max = 500, required = false } = {}) {
  const raw = value === undefined || value === null ? '' : value;
  if (typeof raw !== 'string') throw new AgendaError(code, `${field} 必须是字符串`);
  const trimmed = raw.trim();
  if (required && trimmed === '') throw new AgendaError(code, `${field} 不能为空`);
  if (trimmed.length > max) throw new AgendaError('agenda_limit_exceeded', `${field} 最长 ${max} 字符`);
  return trimmed;
}

function durationMinutesOf(value) {
  const n = value === undefined || value === null ? 30 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1440) {
    throw new AgendaError('invalid_event', 'durationMinutes 必须是 1..1440 的整数');
  }
  return n;
}

function leadMinutesOf(value, code = 'invalid_reminder') {
  const n = value === undefined || value === null ? 0 : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1440) {
    throw new AgendaError(code, 'leadMinutes 必须是 0..1440 的整数');
  }
  return n;
}

function revisionOf(value, code = 'invalid_event') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new AgendaError(code, 'expectedRevision 必须是正整数');
  }
  return n;
}

function limitOf(value, field, max, code = 'invalid_event') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new AgendaError(code, `${field} 必须是 1..${max} 的整数`);
  }
  return n;
}

function horizonOf(value, code = 'invalid_reminder') {
  const n = value === undefined || value === null ? DEFAULT_HORIZON_MS : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AgendaError(code, 'horizonMs 必须是正数');
  }
  if (n > MAX_SPAN_MS) {
    throw new AgendaError('agenda_limit_exceeded', `horizonMs 不能超过 ${MAX_SPAN_MS} 毫秒`);
  }
  return Math.floor(n);
}

// 日程里的锚点列只存 UTC 时刻，重建时按锚点换算回墙钟。
function scheduleFromRow(row) {
  return viaSchedule(() => normalizeSchedule({
    anchor: Date.parse(row.anchor),
    timezone: row.timezone,
    frequency: row.frequency,
    interval: Number(row.interval),
    count: row.count === null || row.count === undefined ? null : Number(row.count),
    fold: Number(row.fold),
    gapPolicy: row.gap_policy,
  }));
}

function eventModelFromRow(row) {
  return {
    eventId: row.event_id,
    kind: row.kind,
    state: row.state,
    revision: Number(row.revision),
    title: row.title,
    detail: row.detail,
    presence: row.presence,
    durationMinutes: Number(row.duration_minutes),
    schedule: scheduleFromRow(row),
    creatorKind: row.creator_kind,
    accepted: Number(row.accepted) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventView(model) {
  return {
    eventId: model.eventId,
    kind: model.kind,
    state: model.state,
    revision: model.revision,
    title: model.title,
    detail: model.detail,
    presence: model.presence,
    durationMinutes: model.durationMinutes,
    schedule: scheduleToJson(model.schedule),
    scheduleText: describeSchedule(model.schedule),
    creatorKind: model.creatorKind,
    accepted: model.accepted,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function eventSnapshot(model) {
  return {
    eventId: model.eventId,
    kind: model.kind,
    state: model.state,
    revision: model.revision,
    title: model.title,
    detail: model.detail,
    presence: model.presence,
    durationMinutes: model.durationMinutes,
    schedule: scheduleToJson(model.schedule),
    creatorKind: model.creatorKind,
    accepted: model.accepted,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function eventWriteParams(model) {
  const schedule = model.schedule;
  return [
    model.kind,
    model.state,
    model.revision,
    model.title,
    model.detail,
    model.presence,
    model.durationMinutes,
    stamp(schedule.anchor),
    schedule.timezone,
    schedule.frequency,
    schedule.interval,
    schedule.count,
    schedule.fold,
    schedule.gapPolicy,
    model.creatorKind,
    model.accepted ? 1 : 0,
    model.createdAt,
    model.updatedAt,
  ];
}

function reminderModelFromRow(row) {
  return {
    reminderId: row.reminder_id,
    eventId: row.event_id ?? null,
    state: row.state,
    revision: Number(row.revision),
    message: row.message,
    schedule: scheduleFromRow(row),
    leadMinutes: Number(row.lead_minutes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reminderView(model) {
  return {
    reminderId: model.reminderId,
    eventId: model.eventId,
    state: model.state,
    revision: model.revision,
    message: model.message,
    schedule: scheduleToJson(model.schedule),
    scheduleText: describeSchedule(model.schedule),
    leadMinutes: model.leadMinutes,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function reminderWriteParams(model) {
  const schedule = model.schedule;
  return [
    model.eventId,
    model.state,
    model.revision,
    model.message,
    stamp(schedule.anchor),
    schedule.timezone,
    schedule.frequency,
    schedule.interval,
    schedule.count,
    schedule.fold,
    schedule.gapPolicy,
    model.leadMinutes,
    model.createdAt,
    model.updatedAt,
  ];
}

function insertHistory(db, eventId, revision, record, updatedAt) {
  db.prepare(`INSERT INTO agenda_event_history (event_id, revision, record_json, updated_at)
    VALUES (?, ?, ?, ?)`).run(eventId, revision, JSON.stringify(record), updatedAt);
}

export function createService({ db, clock } = {}) {
  if (!db) throw new AgendaError('invalid_event', 'createService 需要数据库连接');

  // 有的方法把 now 放在参数对象里（dueReminders / expandEvents / stats），
  // 有的放在第二个参数里，这里统一按顺序查找。
  function nowFrom(...sources) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const raw = source.now;
      if (raw === undefined || raw === null) continue;
      return toMs(raw);
    }
    const fallback = typeof clock === 'function' ? clock() : Date.now();
    return toMs(fallback);
  }

  function requireEvent(eventId, { includeDeleted = false } = {}) {
    const id = requireId(eventId, 'eventId');
    const row = db.prepare('SELECT * FROM agenda_events WHERE event_id = ?').get(id);
    if (!row || (!includeDeleted && row.state === 'deleted')) {
      throw new AgendaError('agenda_not_found', `日程不存在：${id}`);
    }
    return row;
  }

  function requireReminder(reminderId, { code = 'invalid_reminder' } = {}) {
    const id = requireId(reminderId, 'reminderId', code);
    const row = db.prepare('SELECT * FROM agenda_reminders WHERE reminder_id = ?').get(id);
    if (!row) throw new AgendaError('agenda_not_found', `提醒不存在：${id}`);
    return row;
  }

  function createEvent(input = {}, opts = {}) {
    const at = nowFrom(input, opts);
    const kind = input.kind;
    if (!KINDS.includes(kind)) {
      throw new AgendaError('invalid_event', `kind 必须是 ${KINDS.join(' / ')}`);
    }
    const title = text(input.title, 'title', { max: TEXT_LIMITS.title, required: true });
    const detail = text(input.detail ?? '', 'detail', { max: TEXT_LIMITS.detail });
    const presence = text(input.presence ?? '', 'presence', { max: TEXT_LIMITS.presence });
    const durationMinutes = durationMinutesOf(input.durationMinutes);
    const creatorKind = input.creatorKind ?? 'owner';
    if (!CREATOR_KINDS.includes(creatorKind)) {
      throw new AgendaError('invalid_event', `creatorKind 必须是 ${CREATOR_KINDS.join(' / ')}`);
    }
    const acceptedInput = input.accepted;
    if (acceptedInput !== undefined && typeof acceptedInput !== 'boolean') {
      throw new AgendaError('invalid_event', 'accepted 必须是布尔值');
    }
    // 主人自己排的日程默认视为已确认；角色提出的计划需要主人确认后才生效。
    const accepted = acceptedInput === undefined ? creatorKind === 'owner' : acceptedInput;
    const schedule = viaSchedule(() => normalizeSchedule(input.schedule));
    const model = {
      eventId: createEventId(),
      kind,
      state: 'active',
      revision: 1,
      title,
      detail,
      presence,
      durationMinutes,
      schedule,
      creatorKind,
      accepted,
      createdAt: stamp(at),
      updatedAt: stamp(at),
    };
    viaStore(() => tx(db, () => {
      db.prepare(EVENT_INSERT).run(model.eventId, ...eventWriteParams(model));
      insertHistory(db, model.eventId, model.revision, eventSnapshot(model), model.updatedAt);
    }));
    return eventView(model);
  }

  function reviseEvent(eventId, { expectedRevision, patch } = {}, opts = {}) {
    const at = nowFrom(opts);
    const row = requireEvent(eventId);
    if (row.state !== 'active') {
      throw new AgendaError('invalid_event', `只能修改进行中的日程（当前 ${row.state}）`);
    }
    const expected = revisionOf(expectedRevision);
    if (Number(row.revision) !== expected) {
      throw new AgendaError('agenda_revision_conflict', `日程 ${row.event_id} 当前 revision 为 ${row.revision}`);
    }
    const next = eventModelFromRow(row);
    if (patch && typeof patch === 'object') {
      if (patch.kind !== undefined) {
        if (!KINDS.includes(patch.kind)) throw new AgendaError('invalid_event', `kind 必须是 ${KINDS.join(' / ')}`);
        next.kind = patch.kind;
      }
      if (patch.title !== undefined) {
        next.title = text(patch.title, 'title', { max: TEXT_LIMITS.title, required: true });
      }
      if (patch.detail !== undefined) next.detail = text(patch.detail, 'detail', { max: TEXT_LIMITS.detail });
      if (patch.presence !== undefined) next.presence = text(patch.presence, 'presence', { max: TEXT_LIMITS.presence });
      if (patch.durationMinutes !== undefined) next.durationMinutes = durationMinutesOf(patch.durationMinutes);
      if (patch.schedule !== undefined) next.schedule = viaSchedule(() => normalizeSchedule(patch.schedule));
      if (patch.accepted !== undefined) {
        if (typeof patch.accepted !== 'boolean') throw new AgendaError('invalid_event', 'accepted 必须是布尔值');
        next.accepted = patch.accepted;
      }
    }
    next.revision = expected + 1;
    next.updatedAt = stamp(at);
    viaStore(() => tx(db, () => {
      updateGuarded(db, EVENT_UPDATE, [...eventWriteParams(next), next.eventId, expected], expected, `日程 ${next.eventId} 已被其他操作更新`);
      insertHistory(db, next.eventId, next.revision, eventSnapshot(next), next.updatedAt);
    }));
    return eventView(next);
  }

  function changeEventState(eventId, expectedRevision, nextState, opts) {
    const at = nowFrom(opts);
    const row = requireEvent(eventId);
    if (row.state !== 'active') {
      throw new AgendaError('invalid_event', `日程已处于 ${row.state} 状态`);
    }
    const expected = revisionOf(expectedRevision);
    if (Number(row.revision) !== expected) {
      throw new AgendaError('agenda_revision_conflict', `日程 ${row.event_id} 当前 revision 为 ${row.revision}`);
    }
    const next = eventModelFromRow(row);
    next.state = nextState;
    next.revision = expected + 1;
    next.updatedAt = stamp(at);
    viaStore(() => tx(db, () => {
      updateGuarded(
        db,
        'UPDATE agenda_events SET state = ?, revision = ?, updated_at = ? WHERE event_id = ? AND revision = ?',
        [nextState, next.revision, next.updatedAt, next.eventId, expected],
        expected,
        `日程 ${next.eventId} 已被其他操作更新`,
      );
      insertHistory(db, next.eventId, next.revision, eventSnapshot(next), next.updatedAt);
    }));
    return eventView(next);
  }

  function cancelEvent(eventId, { expectedRevision } = {}, opts = {}) {
    return changeEventState(eventId, expectedRevision, 'cancelled', opts);
  }

  function deleteEvent(eventId, { expectedRevision } = {}, opts = {}) {
    return changeEventState(eventId, expectedRevision, 'deleted', opts);
  }

  function setException(eventId, sequence, { start } = {}, opts = {}) {
    const at = nowFrom(opts);
    const row = requireEvent(eventId);
    if (row.state !== 'active') {
      throw new AgendaError('invalid_event', `只能对进行中的日程设置例外（当前 ${row.state}）`);
    }
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new AgendaError('invalid_event', 'sequence 必须是非负整数');
    }
    const updatedAt = stamp(at);
    const anchor = start === null || start === undefined ? null : stamp(toMs(start));
    db.prepare(`INSERT INTO agenda_exceptions (event_id, sequence, occurrence_anchor, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(event_id, sequence) DO UPDATE SET
        occurrence_anchor = excluded.occurrence_anchor, updated_at = excluded.updated_at`)
      .run(row.event_id, sequence, anchor, updatedAt);
    return {
      eventId: row.event_id,
      sequence,
      start: anchor === null ? null : Date.parse(anchor),
      updatedAt,
    };
  }

  function getEvent(eventId, opts = {}) {
    nowFrom(opts);
    const row = requireEvent(eventId);
    const model = eventModelFromRow(row);
    const exceptions = db.prepare(`SELECT sequence, occurrence_anchor, updated_at FROM agenda_exceptions
      WHERE event_id = ? ORDER BY sequence`).all(row.event_id).map((item) => ({
      sequence: Number(item.sequence),
      start: item.occurrence_anchor === null ? null : Date.parse(item.occurrence_anchor),
      updatedAt: item.updated_at,
    }));
    return { ...eventView(model), exceptions };
  }

  function listEvents(query = {}, opts = {}) {
    nowFrom(opts);
    const { from, to, limit = 20, afterId = '', kind = '', includeDeleted = false } = query;
    const size = limitOf(limit, 'limit', 200);
    const where = [];
    const params = [];
    if (includeDeleted !== true) where.push("state <> 'deleted'");
    if (kind) {
      if (!KINDS.includes(kind)) throw new AgendaError('invalid_event', `kind 必须是 ${KINDS.join(' / ')}`);
      where.push('kind = ?');
      params.push(kind);
    }
    if (from !== undefined && from !== null) {
      where.push('anchor >= ?');
      params.push(stamp(toMs(from)));
    }
    if (to !== undefined && to !== null) {
      where.push('anchor <= ?');
      params.push(stamp(toMs(to)));
    }
    if (afterId) {
      where.push('event_id > ?');
      params.push(requireId(afterId, 'afterId'));
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM agenda_events ${clause} ORDER BY event_id LIMIT ?`).all(...params, size + 1);
    const more = rows.length > size;
    const page = more ? rows.slice(0, size) : rows;
    const items = page.map((row) => eventView(eventModelFromRow(row)));
    return {
      items,
      nextCursor: more ? items[items.length - 1].eventId : '',
      more,
    };
  }

  function expandEvents(input = {}) {
    nowFrom(input);
    const { from, to, limit = 32 } = input;
    const windowFrom = toMs(from, 'invalid_schedule');
    const windowTo = toMs(to, 'invalid_schedule');
    const span = windowTo - windowFrom;
    if (!(span > 0) || span > MAX_SPAN_MS) {
      throw new AgendaError('invalid_schedule', '时间窗口必须满足 0 < to - from <= 31 天');
    }
    const size = Math.min(limitOf(limit, 'limit', EXPAND_CAP), EXPAND_CAP);
    const rows = db.prepare("SELECT * FROM agenda_events WHERE state = 'active'").all();
    const collected = [];
    for (const row of rows) {
      let schedule;
      try {
        schedule = scheduleFromRow(row);
      } catch {
        // 数据损坏的日程跳过，不影响整份日历
        continue;
      }
      const durationMs = Number(row.duration_minutes) * MINUTE_MS;
      // 「进行中」不能漏，靠的是 occurrences() 内部把搜索起点前推一个时长（from - durationMs）：
      // 只要这条日程的结束时刻晚于窗口起点就会被带出来。这里若再减一次 durationMs，
      // 已经结束、只是没超过这个时长的期次也会被当成当下窗口里的安排，所以直接用窗口起点。
      let periods;
      try {
        periods = occurrences(schedule, {
          from: windowFrom,
          to: windowTo,
          durationMs,
          max: MAX_OCCURRENCES,
        });
      } catch (err) {
        if (err instanceof ScheduleError) continue;
        throw err;
      }
      if (periods.length === 0) continue;
      const exceptionRows = db.prepare('SELECT sequence, occurrence_anchor FROM agenda_exceptions WHERE event_id = ?')
        .all(row.event_id);
      const exceptions = new Map(exceptionRows.map((item) => [Number(item.sequence), item.occurrence_anchor]));
      for (const period of periods) {
        let start = period.start;
        let end = period.end;
        if (exceptions.has(period.sequence)) {
          const anchor = exceptions.get(period.sequence);
          if (anchor === null) continue; // 该期次被取消
          const replaced = Date.parse(anchor);
          if (!Number.isFinite(replaced)) continue;
          start = replaced;
          end = replaced + durationMs;
        }
        collected.push({
          eventId: row.event_id,
          title: row.title,
          // 叙事正文原样带出（不截断），是否省略由消费者决定。
          detail: String(row?.detail ?? ''),
          kind: row.kind,
          presence: row.presence,
          durationMinutes: Number(row.duration_minutes),
          sequence: period.sequence,
          start,
          end,
          timezone: row.timezone,
          revision: Number(row.revision),
          accepted: Number(row.accepted) === 1,
        });
      }
    }
    collected.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
      return a.sequence - b.sequence;
    });
    return {
      items: collected.slice(0, size),
      truncated: collected.length > size,
    };
  }

  function createReminder(input = {}, opts = {}) {
    const at = nowFrom(input, opts);
    const message = text(input.message ?? '', 'message', { max: TEXT_LIMITS.message, code: 'invalid_reminder' });
    const leadMinutes = leadMinutesOf(input.leadMinutes);
    let linked = null;
    const rawEventId = input.eventId ?? null;
    if (rawEventId !== null && rawEventId !== '') {
      const eventRow = requireEvent(rawEventId);
      if (eventRow.state !== 'active') {
        throw new AgendaError('invalid_event', '提醒只能关联进行中的日程');
      }
      if (Number(eventRow.accepted) !== 1) {
        throw new AgendaError('calendar_confirmation_required', `日程 ${eventRow.event_id} 还没有被确认，不能挂提醒`);
      }
      linked = eventRow.event_id;
    }
    const schedule = viaSchedule(() => normalizeSchedule(input.schedule));
    const model = {
      reminderId: createReminderId(),
      eventId: linked,
      state: 'active',
      revision: 1,
      message,
      schedule,
      leadMinutes,
      createdAt: stamp(at),
      updatedAt: stamp(at),
    };
    viaStore(() => {
      db.prepare(REMINDER_INSERT).run(model.reminderId, ...reminderWriteParams(model));
    });
    return reminderView(model);
  }

  function rescheduleReminder(reminderId, { expectedRevision, schedule, leadMinutes } = {}, opts = {}) {
    const at = nowFrom(opts);
    const row = requireReminder(reminderId);
    if (row.state !== 'active') {
      throw new AgendaError('invalid_reminder', `只能修改进行中的提醒（当前 ${row.state}）`);
    }
    const expected = revisionOf(expectedRevision, 'invalid_reminder');
    if (Number(row.revision) !== expected) {
      throw new AgendaError('agenda_revision_conflict', `提醒 ${row.reminder_id} 当前 revision 为 ${row.revision}`);
    }
    const current = reminderModelFromRow(row);
    current.schedule = schedule === undefined
      ? current.schedule
      : viaSchedule(() => normalizeSchedule(schedule));
    current.leadMinutes = leadMinutes === undefined ? current.leadMinutes : leadMinutesOf(leadMinutes);
    current.revision = expected + 1;
    current.updatedAt = stamp(at);
    viaStore(() => tx(db, () => {
      updateGuarded(
        db,
        REMINDER_UPDATE,
        [...reminderWriteParams(current), current.reminderId, expected],
        expected,
        `提醒 ${current.reminderId} 已被其他操作更新`,
      );
      // 旧版本的期次立即作废：同时给 id 补上 revision 后缀，
      // 把「reminderId:sequence」让给新版本，否则新期次会被主键冲突丢掉。
      db.prepare(`UPDATE agenda_occurrences
        SET occurrence_id = occurrence_id || ':r' || reminder_revision,
            state = 'cancelled', updated_at = ?
        WHERE reminder_id = ? AND reminder_revision < ? AND state = 'scheduled'`)
        .run(current.updatedAt, current.reminderId, current.revision);
    }));
    return reminderView(current);
  }

  function cancelReminder(reminderId, { expectedRevision } = {}, opts = {}) {
    const at = nowFrom(opts);
    const row = requireReminder(reminderId);
    if (row.state !== 'active') {
      throw new AgendaError('invalid_reminder', `提醒已处于 ${row.state} 状态`);
    }
    const expected = revisionOf(expectedRevision, 'invalid_reminder');
    if (Number(row.revision) !== expected) {
      throw new AgendaError('agenda_revision_conflict', `提醒 ${row.reminder_id} 当前 revision 为 ${row.revision}`);
    }
    const updatedAt = stamp(at);
    const nextRevision = expected + 1;
    viaStore(() => tx(db, () => {
      updateGuarded(
        db,
        'UPDATE agenda_reminders SET state = ?, revision = ?, updated_at = ? WHERE reminder_id = ? AND revision = ?',
        ['cancelled', nextRevision, updatedAt, row.reminder_id, expected],
        expected,
        `提醒 ${row.reminder_id} 已被其他操作更新`,
      );
      db.prepare(`UPDATE agenda_occurrences SET state = 'cancelled', updated_at = ?
        WHERE reminder_id = ? AND state = 'scheduled'`)
        .run(updatedAt, row.reminder_id);
    }));
    return {
      reminderId: row.reminder_id,
      state: 'cancelled',
      revision: nextRevision,
      updatedAt,
    };
  }

  function listReminders(query = {}, opts = {}) {
    nowFrom(opts);
    const { limit = 50, includeCancelled = false } = query;
    const size = limitOf(limit, 'limit', 200, 'invalid_reminder');
    const clause = includeCancelled === true ? '' : "WHERE state = 'active'";
    const rows = db.prepare(`SELECT * FROM agenda_reminders ${clause}
      ORDER BY updated_at DESC, reminder_id ASC LIMIT ?`).all(size);
    const nextDueStmt = db.prepare(`SELECT MIN(due_at) AS due FROM agenda_occurrences
      WHERE reminder_id = ? AND state = 'scheduled'`);
    const items = rows.map((row) => {
      const model = reminderModelFromRow(row);
      const next = nextDueStmt.get(model.reminderId);
      return { ...reminderView(model), nextDue: next?.due ?? null };
    });
    return { items };
  }

  function materializeOccurrences(input = {}, opts = {}) {
    const at = nowFrom(opts);
    const row = requireReminder(input.reminderId);
    if (row.state !== 'active') {
      throw new AgendaError('invalid_reminder', `只能为进行中的提醒铺期次（当前 ${row.state}）`);
    }
    const horizon = horizonOf(input.horizonMs);
    const schedule = scheduleFromRow(row);
    // due_at 存的是「提醒时刻」：日程时刻提前 leadMinutes，期次本身仍按期次时刻判断。
    const leadMs = (Number(row.lead_minutes) || 0) * MINUTE_MS;
    const first = viaSchedule(() => firstAtOrAfter(schedule, at));
    if (!first) return 0;
    const until = at + horizon;
    const updatedAt = stamp(at);
    const insert = db.prepare(OCCURRENCE_INSERT);
    let inserted = 0;
    let sequence = first.sequence;
    let cursor = first.at;
    let skips = 0;
    for (let guard = 0; guard < MAX_OCCURRENCES && cursor !== null && cursor <= until; guard += 1) {
      const result = insert.run(
        `${row.reminder_id}:${sequence}`,
        row.reminder_id,
        Number(row.revision),
        sequence,
        stamp(cursor - leadMs),
        updatedAt,
      );
      if (Number(result?.changes ?? 0) === 1) inserted += 1;
      sequence += 1;
      if (schedule.count !== null && sequence >= schedule.count) break;
      // 推进到下一期：DST 空洞里不存在的那一期没有对应时刻，只跳过该期次继续往后算，
      // 不能当成「铺到头」—— 否则空洞之后的每一期都会缺。
      let next = null;
      for (;;) {
        try {
          next = scheduleAt(schedule, sequence);
          break;
        } catch (err) {
          if (!(err instanceof ScheduleError)) throw err;
          if (err.code !== 'schedule_needs_resolution') break;
          skips += 1;
          if (skips >= MAX_OCCURRENCES) break;
          sequence += 1;
        }
      }
      cursor = next;
    }
    return inserted;
  }

  function dueReminders(input = {}) {
    const at = nowFrom(input);
    const { limit = 16, after } = input;
    const size = limitOf(limit, 'limit', 100, 'invalid_reminder');
    const cursorDue = typeof after?.dueAt === 'string' ? after.dueAt : '';
    const cursorId = typeof after?.occurrenceId === 'string' ? after.occurrenceId : '';
    const rows = db.prepare(`SELECT o.occurrence_id, o.reminder_id, o.reminder_revision, o.sequence, o.due_at,
             r.lead_minutes, r.message, r.event_id, r.timezone, e.title AS event_title
        FROM agenda_occurrences o
        JOIN agenda_reminders r ON r.reminder_id = o.reminder_id AND r.revision = o.reminder_revision
        LEFT JOIN agenda_events e ON e.event_id = r.event_id
       WHERE o.state = 'scheduled' AND r.state = 'active'
         AND o.due_at <= ?
         AND NOT EXISTS (SELECT 1 FROM agenda_dispatches d WHERE d.occurrence_id = o.occurrence_id)
         AND (o.due_at, o.occurrence_id) > (?, ?)
       ORDER BY o.due_at, o.occurrence_id
       LIMIT ?`).all(stamp(at), cursorDue, cursorId, size + 1);
    const more = rows.length > size;
    const page = more ? rows.slice(0, size) : rows;
    const items = page.map((row) => ({
      occurrenceId: row.occurrence_id,
      reminderId: row.reminder_id,
      reminderRevision: Number(row.reminder_revision),
      sequence: Number(row.sequence),
      dueAt: row.due_at,
      leadMinutes: Number(row.lead_minutes),
      message: row.message,
      eventId: row.event_id ?? null,
      eventTitle: row.event_title ?? '',
      timezone: row.timezone,
    }));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: last ? { dueAt: last.dueAt, occurrenceId: last.occurrenceId } : null,
      more,
    };
  }

  function claimOccurrence(occurrenceId, opts = {}) {
    const at = nowFrom(opts);
    const id = requireId(occurrenceId, 'occurrenceId', 'invalid_reminder');
    const occurrence = db.prepare('SELECT occurrence_id, state, reminder_revision FROM agenda_occurrences WHERE occurrence_id = ?').get(id);
    if (!occurrence) throw new AgendaError('agenda_not_found', `期次不存在：${id}`);
    if (occurrence.state !== 'scheduled') return { claimed: false, reason: 'not_scheduled' };
    const changes = viaStore(() => tx(db, () => {
      const result = db.prepare(DISPATCH_PLACEHOLDER).run(id, Number(occurrence.reminder_revision), stamp(at));
      return Number(result?.changes ?? 0);
    }));
    return changes === 1 ? { claimed: true } : { claimed: false };
  }

  function markDispatch(occurrenceId, { state, reason = '' } = {}, opts = {}) {
    const at = nowFrom(opts);
    const id = requireId(occurrenceId, 'occurrenceId', 'invalid_reminder');
    if (!DISPATCH_STATES.includes(state)) {
      throw new AgendaError('invalid_reminder', `dispatch state 必须是 ${DISPATCH_STATES.join(' / ')}`);
    }
    const occurrence = db.prepare('SELECT reminder_revision FROM agenda_occurrences WHERE occurrence_id = ?').get(id);
    if (!occurrence) throw new AgendaError('agenda_not_found', `期次不存在：${id}`);
    const note = (typeof reason === 'string' ? reason : String(reason ?? '')).slice(0, DISPATCH_REASON_LIMIT);
    const observedAt = stamp(at);
    // 认领时已经写入占位行，这里必须能覆盖状态，否则失败原因会丢失。
    db.prepare(DISPATCH_UPSERT).run(id, Number(occurrence.reminder_revision), state, note, observedAt);
    return { occurrenceId: id, state, reason: note, observedAt };
  }

  function nextOccurrenceAfter(reminderId, { afterSequence, now } = {}) {
    const at = nowFrom({ now });
    const row = requireReminder(reminderId);
    if (row.state !== 'active') return null;
    const schedule = scheduleFromRow(row);
    const after = Number.isInteger(afterSequence) && afterSequence >= 0 ? afterSequence : -1;
    let target = null;
    try {
      target = firstAtOrAfter(schedule, at, after + 1);
    } catch (err) {
      if (err instanceof ScheduleError) return null;
      throw err;
    }
    if (!target || target.at < at) {
      // 估算失败或期次已过时，退回到当前仍有效的那一期。
      try {
        target = firstAtOrAfter(schedule, at, 0);
      } catch (err) {
        if (err instanceof ScheduleError) return null;
        throw err;
      }
    }
    if (!target || target.at < at) return null;
    const occurrenceId = `${row.reminder_id}:${target.sequence}`;
    // 同样按提前量落库：due_at 是提醒时刻，期次时刻仍在 target.at。
    const leadMs = (Number(row.lead_minutes) || 0) * MINUTE_MS;
    const dueAt = stamp(target.at - leadMs);
    db.prepare(OCCURRENCE_INSERT).run(
      occurrenceId,
      row.reminder_id,
      Number(row.revision),
      target.sequence,
      dueAt,
      stamp(at),
    );
    return { occurrenceId, sequence: target.sequence, dueAt };
  }

  function stats(opts = {}) {
    const at = nowFrom(opts);
    const count = (sql, ...params) => Number(db.prepare(sql).get(...params)?.n ?? 0);
    const events = count("SELECT COUNT(*) AS n FROM agenda_events WHERE state <> 'deleted'");
    const active = count("SELECT COUNT(*) AS n FROM agenda_events WHERE state = 'active'");
    const reminders = count("SELECT COUNT(*) AS n FROM agenda_reminders WHERE state = 'active'");
    const pendingDue = count(`SELECT COUNT(*) AS n FROM agenda_occurrences o
        JOIN agenda_reminders r ON r.reminder_id = o.reminder_id AND r.revision = o.reminder_revision
       WHERE o.state = 'scheduled' AND r.state = 'active'
         AND o.due_at <= ?
         AND NOT EXISTS (SELECT 1 FROM agenda_dispatches d WHERE d.occurrence_id = o.occurrence_id)`, stamp(at));
    return { events, active, reminders, pendingDue };
  }

  return {
    createEventId,
    createReminderId,
    createEvent,
    reviseEvent,
    cancelEvent,
    deleteEvent,
    setException,
    getEvent,
    listEvents,
    expandEvents,
    createReminder,
    rescheduleReminder,
    cancelReminder,
    listReminders,
    materializeOccurrences,
    dueReminders,
    claimOccurrence,
    markDispatch,
    nextOccurrenceAfter,
    stats,
  };
}