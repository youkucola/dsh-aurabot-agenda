import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  REQUIRED_TABLES,
  SCHEMA_VERSION,
  StoreError,
  migrate,
  openStore,
  tx,
  updateGuarded,
  writePlanningSlot,
} from '../lib/store.mjs';
import { AgendaError, createEventId, createReminderId, createService } from '../lib/service.mjs';
import { DEFAULTS, createDispatcher, formatReminderText } from '../lib/dispatcher.mjs';

const SH = 'Asia/Shanghai';
const NY = 'America/New_York';
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
// 2026-05-01T00:00:00Z 即上海 08:00，用作所有用例的固定时钟。
const T0 = Date.UTC(2026, 4, 1, 0, 0, 0);

async function freshStore(t) {
  const dir = join(tmpdir(), `agenda-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const store = await openStore({ dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...store, dir };
}

function readVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version);
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agenda_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function historyRows(db, eventId) {
  return db.prepare('SELECT revision, record_json, updated_at FROM agenda_event_history WHERE event_id = ? ORDER BY revision')
    .all(eventId);
}

function dispatchRow(db, occurrenceId) {
  return db.prepare('SELECT * FROM agenda_dispatches WHERE occurrence_id = ?').get(occurrenceId);
}

function makeApi({ failAt = 0 } = {}) {
  const calls = [];
  const api = {
    calls,
    timer: null,
    closed: 0,
    async send(chatId, text) {
      calls.push({ chatId, text });
      if (failAt > 0 && calls.length === failAt) throw new Error('发送失败');
    },
    every(ms, fn, label) {
      api.timer = { ms, fn, label };
      return () => {
        api.closed += 1;
      };
    },
  };
  return api;
}

test('store：migrate 幂等，重复打开保持版本与表结构', async (t) => {
  const store = await freshStore(t);
  assert.equal(readVersion(store.db), SCHEMA_VERSION);
  const names = tableNames(store.db);
  assert.deepEqual(names, [
    'agenda_dispatches',
    'agenda_event_history',
    'agenda_events',
    'agenda_exceptions',
    'agenda_meta',
    'agenda_occurrences',
    'agenda_planning_slots',
    'agenda_reminders',
  ]);

  const again = await openStore({ dir: store.dir });
  try {
    assert.equal(readVersion(again.db), SCHEMA_VERSION);
    assert.deepEqual(tableNames(again.db), names);
    assert.equal(migrate(again.db), SCHEMA_VERSION);
    assert.equal(readVersion(again.db), SCHEMA_VERSION);
  } finally {
    again.close();
  }
});

test('store：user_version 已领先但缺表的库在打开时自愈', async (t) => {
  // 必须用真实文件库：要复现「库已经存在、user_version = 4，但某张表被删掉」的中毒状态。
  const dir = join(tmpdir(), `agenda-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const opened = [];
  t.after(() => {
    for (const store of opened) {
      try {
        store.close();
      } catch {
        // 已经关掉的连接不用再关一次
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const first = await openStore({ dir });
  opened.push(first);
  const service = createService({ db: first.db, clock: () => T0 });
  const event = service.createEvent({
    kind: 'commitment',
    title: '中毒库里的日程',
    durationMinutes: 30,
    schedule: { anchor: T0, timezone: SH, frequency: 'once' },
  }, { now: T0 });
  assert.deepEqual(tableNames(first.db), [...REQUIRED_TABLES].sort());
  assert.equal(readVersion(first.db), SCHEMA_VERSION);
  first.close();

  // 用裸连接删掉 v4 的表，user_version 保持在 4 —— 复刻线上「版本领先」的库。
  const raw = new DatabaseSync(join(dir, 'agenda.sqlite'));
  raw.exec('DROP TABLE agenda_planning_slots');
  assert.equal(Number(raw.prepare('PRAGMA user_version').get().user_version), 4);
  assert.equal(
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agenda_planning_slots'").get(),
    undefined,
  );
  raw.close();

  const healed = await openStore({ dir });
  opened.push(healed);
  assert.deepEqual(tableNames(healed.db), [...REQUIRED_TABLES].sort(), '缺失的表应当被补齐');
  assert.equal(readVersion(healed.db), 4, '自愈不该改动已经正确的版本号');
  const row = healed.db.prepare('SELECT title, state FROM agenda_events WHERE event_id = ?').get(event.eventId);
  assert.equal(row?.title, '中毒库里的日程', '旧数据不该丢');
  assert.equal(row?.state, 'active');
  // 补出来的表是真能用的（原来这里会 no such table）
  assert.equal(
    writePlanningSlot(healed.db, 'daily:Asia/Shanghai:2026-05-01', { state: 'done', attempts: 1 }).state,
    'done',
  );
});

test('store：缺表时重跑 migrate 不报 store_incomplete，DDL 会把表建回来', async (t) => {
  const store = await freshStore(t);
  store.db.exec('DROP TABLE agenda_meta');
  assert.equal(migrate(store.db), SCHEMA_VERSION);
  assert.ok(tableNames(store.db).includes('agenda_meta'));
  assert.equal(readVersion(store.db), SCHEMA_VERSION);
});

test('store：DDL 之后仍缺表才抛 store_incomplete，缺表时也不写版本号', () => {
  // 用伪 db 让所有 DDL 变成空操作，构造出「DDL 跑完表还是没有」这个理论分支。
  const execs = [];
  const fake = {
    exec(sql) {
      execs.push(String(sql));
    },
    prepare(sql) {
      if (String(sql).includes('sqlite_master')) return { get: () => undefined };
      return { get: () => ({ user_version: SCHEMA_VERSION }) };
    },
  };
  assert.throws(
    () => migrate(fake),
    (err) => err instanceof StoreError
      && err.code === 'store_incomplete'
      && REQUIRED_TABLES.every((name) => err.message.includes(name)),
  );
  assert.equal(execs.length, 4, '四段 DDL 都该被执行');
  assert.equal(execs.some((sql) => sql.includes('PRAGMA user_version')), false);
});

test('store：版本更高的库直接拒绝，且不执行任何 DDL', () => {
  const execs = [];
  const fake = {
    exec(sql) {
      execs.push(String(sql));
    },
    prepare() {
      return { get: () => ({ user_version: SCHEMA_VERSION + 1 }) };
    },
  };
  assert.throws(
    () => migrate(fake),
    (err) => err instanceof StoreError
      && err.code === 'schema_too_new'
      && err.message === `数据库版本 ${SCHEMA_VERSION + 1} 高于当前支持的 ${SCHEMA_VERSION}`,
  );
  assert.equal(execs.length, 0, 'schema_too_new 必须在任何 DDL 之前抛出');
});

test('store：updateGuarded、事务回滚与嵌套事务', async (t) => {
  const { db } = await freshStore(t);
  db.prepare("INSERT INTO agenda_meta (key, value) VALUES ('k', '1')").run();
  assert.equal(
    updateGuarded(db, 'UPDATE agenda_meta SET value = ? WHERE key = ? AND value = ?', ['2', 'k', '1'], 1, '测试更新'),
    1,
  );
  assert.throws(
    () => updateGuarded(db, 'UPDATE agenda_meta SET value = ? WHERE key = ? AND value = ?', ['3', 'k', '1'], 9, '测试更新'),
    (err) => err instanceof StoreError && err.code === 'revision_conflict',
  );
  assert.equal(db.prepare("SELECT value FROM agenda_meta WHERE key = 'k'").get().value, '2');
  assert.throws(
    () => tx(db, () => {
      db.prepare("UPDATE agenda_meta SET value = '9' WHERE key = 'k'").run();
      throw new RangeError('boom');
    }),
    RangeError,
  );
  assert.equal(db.prepare("SELECT value FROM agenda_meta WHERE key = 'k'").get().value, '2');
  assert.equal(tx(db, () => tx(db, () => 'ok')), 'ok');
});

test('service：事件 revision 与历史快照只增不改', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const created = service.createEvent({
    kind: 'role_plan',
    title: '写周报',
    detail: '汇总本周进展',
    presence: '在线',
    durationMinutes: 30,
    schedule: { anchor: { y: 2026, m: 5, d: 4, H: 9, M: 0, S: 0 }, timezone: SH, frequency: 'once' },
    creatorKind: 'owner',
  }, { now: T0 });
  assert.equal(created.revision, 1);
  assert.equal(created.state, 'active');
  assert.equal(created.accepted, true);
  const before = historyRows(db, created.eventId);
  assert.equal(before.length, 1);
  const firstSnapshot = before[0].record_json;

  const revised = service.reviseEvent(created.eventId, {
    expectedRevision: 1,
    patch: { title: '写周报（终稿）' },
  }, { now: T0 + MINUTE });
  assert.equal(revised.revision, 2);
  assert.equal(revised.title, '写周报（终稿）');
  const after = historyRows(db, created.eventId);
  assert.equal(after.length, 2);
  assert.equal(after.find((row) => Number(row.revision) === 1).record_json, firstSnapshot);
  assert.equal(JSON.parse(after.find((row) => Number(row.revision) === 2).record_json).revision, 2);

  const deleted = service.deleteEvent(created.eventId, { expectedRevision: 2 }, { now: T0 + 2 * MINUTE });
  assert.equal(deleted.state, 'deleted');
  assert.equal(deleted.revision, 3);
  assert.equal(historyRows(db, created.eventId).length, 3);
  assert.throws(
    () => service.getEvent(created.eventId, { now: T0 }),
    (err) => err instanceof AgendaError && err.code === 'agenda_not_found',
  );
});

test('service：同一 expectedRevision 被并发使用时后者冲突', async (t) => {
  const { db } = await freshStore(t);
  const a = createService({ db, clock: () => T0 });
  const b = createService({ db, clock: () => T0 });
  const event = a.createEvent({
    kind: 'commitment',
    title: '跑步',
    durationMinutes: 20,
    schedule: { anchor: T0, timezone: SH, frequency: 'once' },
  }, { now: T0 });
  a.reviseEvent(event.eventId, { expectedRevision: 1, patch: { title: '夜跑' } }, { now: T0 + MINUTE });
  assert.throws(
    () => b.reviseEvent(event.eventId, { expectedRevision: 1, patch: { title: '晨跑' } }, { now: T0 + MINUTE }),
    (err) => err instanceof AgendaError && err.code === 'agenda_revision_conflict',
  );
  assert.throws(
    () => b.cancelEvent(event.eventId, { expectedRevision: 1 }, { now: T0 + MINUTE }),
    (err) => err instanceof AgendaError && err.code === 'agenda_revision_conflict',
  );
  assert.equal(b.getEvent(event.eventId, { now: T0 + MINUTE }).title, '夜跑');
});

test('service：expandEvents 展开一次性与每周日程并截断', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const from = Date.UTC(2026, 4, 1, 0, 0);
  const to = Date.UTC(2026, 5, 1, 0, 0);
  const once = service.createEvent({
    kind: 'commitment',
    title: '一次性会议',
    detail: '醒了先摸了摸枕头边，人还有点糊。',
    durationMinutes: 30,
    schedule: { anchor: { y: 2026, m: 5, d: 4, H: 9, M: 0, S: 0 }, timezone: SH, frequency: 'once' },
  }, { now: T0 });
  const weekly = service.createEvent({
    kind: 'role_plan',
    title: '周会',
    durationMinutes: 30,
    schedule: {
      anchor: { y: 2026, m: 5, d: 4, H: 9, M: 0, S: 0 },
      timezone: SH,
      frequency: 'weekly',
      count: 3,
    },
  }, { now: T0 });

  const expanded = service.expandEvents({ from, to, limit: 32, now: T0 });
  assert.equal(expanded.truncated, false);
  assert.equal(expanded.items.length, 4);
  const onceItems = expanded.items.filter((item) => item.eventId === once.eventId);
  assert.equal(onceItems.length, 1);
  assert.equal(onceItems[0].start, Date.UTC(2026, 4, 4, 1, 0));
  assert.equal(onceItems[0].end, onceItems[0].start + 30 * MINUTE);
  // 叙事正文要原样带出：面板靠它显示这一条具体在干什么。
  assert.equal(onceItems[0].detail, '醒了先摸了摸枕头边，人还有点糊。');
  const weeklyItems = expanded.items.filter((item) => item.eventId === weekly.eventId);
  assert.deepEqual(weeklyItems.map((item) => item.start), [
    Date.UTC(2026, 4, 4, 1, 0),
    Date.UTC(2026, 4, 11, 1, 0),
    Date.UTC(2026, 4, 18, 1, 0),
  ]);
  // 没写叙事的日程给空串而不是 undefined，面板据此整段省略。
  assert.equal(weeklyItems[0].detail, '');
  const starts = expanded.items.map((item) => item.start);
  assert.deepEqual(starts, [...starts].sort((x, y) => x - y));

  const limited = service.expandEvents({ from, to, limit: 1, now: T0 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.truncated, true);
});

test('service：setException 取消或改期单期', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const from = Date.UTC(2026, 4, 1, 0, 0);
  const to = Date.UTC(2026, 4, 10, 0, 0);
  const daily = service.createEvent({
    kind: 'role_plan',
    title: '晨读',
    durationMinutes: 30,
    schedule: {
      anchor: { y: 2026, m: 5, d: 2, H: 8, M: 0, S: 0 },
      timezone: SH,
      frequency: 'daily',
      count: 5,
    },
  }, { now: T0 });
  const baseline = service.expandEvents({ from, to, limit: 32, now: T0 });
  assert.deepEqual(baseline.items.map((item) => item.sequence), [0, 1, 2, 3, 4]);

  service.setException(daily.eventId, 1, { start: null }, { now: T0 + MINUTE });
  const cancelled = service.expandEvents({ from, to, limit: 32, now: T0 + MINUTE });
  assert.deepEqual(cancelled.items.map((item) => item.sequence), [0, 2, 3, 4]);

  const movedTo = Date.UTC(2026, 4, 6, 0, 0);
  service.setException(daily.eventId, 2, { start: movedTo }, { now: T0 + 2 * MINUTE });
  const moved = service.expandEvents({ from, to, limit: 32, now: T0 + 2 * MINUTE });
  const second = moved.items.find((item) => item.sequence === 2);
  assert.equal(second.start, movedTo);
  assert.equal(second.end, movedTo + 30 * MINUTE);
  assert.equal(moved.items.filter((item) => item.start === Date.UTC(2026, 4, 4, 0, 0)).length, 0);
});

test('service：expandEvents 在纽约夏令时切换前后保持本地 09:00', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  service.createEvent({
    kind: 'user_report',
    title: '纽约站会',
    durationMinutes: 30,
    schedule: {
      anchor: { y: 2026, m: 3, d: 7, H: 9, M: 0, S: 0 },
      timezone: NY,
      frequency: 'daily',
      count: 4,
    },
  }, { now: T0 });
  const expanded = service.expandEvents({
    from: Date.UTC(2026, 2, 7, 0, 0),
    to: Date.UTC(2026, 2, 10, 0, 0),
    limit: 8,
    now: T0,
  });
  assert.deepEqual(expanded.items.map((item) => item.start), [
    Date.UTC(2026, 2, 7, 14, 0),
    Date.UTC(2026, 2, 8, 13, 0),
    Date.UTC(2026, 2, 9, 13, 0),
  ]);
});

// 窗口起点只该在 occurrences() 内部前推一处；service 再减一次 durationMs，
// 就会把「已经结束、但没超过一个时长」的期次当成当下窗口里的安排带进提示词。
test('service：expandEvents 不再带回已结束的期次，跨过窗口起点的进行中仍命中', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const PAST_GRACE = 30 * MINUTE;
  const AHEAD = 180 * MINUTE;
  // 上海墙钟 → UTC 毫秒（五月，东八区没有夏令时）
  const sh = (day, hour, minute = 0) => Date.UTC(2026, 4, day, hour - 8, minute);
  const expandAt = (eventId, now) => service.expandEvents({
    from: now - PAST_GRACE,
    to: now + AHEAD,
    now,
  }).items.filter((item) => item.eventId === eventId);

  // 进行中跨过窗口起点：now=08:30、日程 07:00-09:30、窗口 08:00 起
  const morning = service.createEvent({
    kind: 'role_plan',
    title: '晨跑',
    durationMinutes: 150,
    schedule: { anchor: { y: 2026, m: 5, d: 2, H: 7, M: 0, S: 0 }, timezone: SH, frequency: 'daily', count: 3 },
  }, { now: T0 });
  const morningItems = expandAt(morning.eventId, sh(2, 8, 30));
  assert.equal(morningItems.length, 1);
  assert.equal(morningItems[0].start, sh(2, 7, 0));
  assert.equal(morningItems[0].end, sh(2, 9, 30));

  // 跨天进行中：now=00:30、日程昨天 23:00 - 今天 01:00
  const night = service.createEvent({
    kind: 'role_plan',
    title: '守夜',
    durationMinutes: 120,
    schedule: { anchor: { y: 2026, m: 5, d: 2, H: 23, M: 0, S: 0 }, timezone: SH, frequency: 'daily', count: 3 },
  }, { now: T0 });
  const nightItems = expandAt(night.eventId, sh(3, 0, 30));
  assert.equal(nightItems.length, 1);
  assert.equal(nightItems[0].start, sh(2, 23, 0));
  assert.equal(nightItems[0].end, sh(3, 1, 0));

  // 超长日程整段盖住窗口起点：now=09:00、日程 06:00-12:00
  const long = service.createEvent({
    kind: 'user_report',
    title: '长会',
    durationMinutes: 360,
    schedule: { anchor: { y: 2026, m: 5, d: 2, H: 6, M: 0, S: 0 }, timezone: SH, frequency: 'once' },
  }, { now: T0 });
  const longItems = expandAt(long.eventId, sh(2, 9, 0));
  assert.equal(longItems.length, 1);
  assert.equal(longItems[0].start, sh(2, 6, 0));
  assert.equal(longItems[0].end, sh(2, 12, 0));

  // 已经结束 76 分钟：now=22:46、日程 19:50-21:30、窗口 22:16 起 —— 必须不再出现
  const evening = service.createEvent({
    kind: 'role_plan',
    title: '晚饭',
    durationMinutes: 100,
    schedule: { anchor: { y: 2026, m: 5, d: 2, H: 19, M: 50, S: 0 }, timezone: SH, frequency: 'once' },
  }, { now: T0 });
  assert.deepEqual(expandAt(evening.eventId, sh(2, 22, 46)), []);

  // 结束时刻恰好落在窗口起点：结束时不算进行中，同样不该带出来
  const endedOnStart = service.createEvent({
    kind: 'role_plan',
    title: '收尾',
    durationMinutes: 60,
    schedule: { anchor: { y: 2026, m: 5, d: 2, H: 21, M: 16, S: 0 }, timezone: SH, frequency: 'once' },
  }, { now: T0 });
  assert.deepEqual(expandAt(endedOnStart.eventId, sh(2, 22, 46)), []);
});

test('service：materializeOccurrences 铺期，dueReminders 去重并游标分页', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const reminder = service.createReminder({
    message: '晨会',
    schedule: { anchor: { y: 2026, m: 5, d: 1, H: 8, M: 0, S: 0 }, timezone: SH, frequency: 'daily' },
  }, { now: T0 });
  assert.equal(service.materializeOccurrences({ reminderId: reminder.reminderId, horizonMs: 3 * DAY }, { now: T0 }), 4);
  assert.equal(service.materializeOccurrences({ reminderId: reminder.reminderId, horizonMs: 3 * DAY }, { now: T0 }), 0);

  const firstPage = service.dueReminders({ now: T0, limit: 8 });
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].dueAt, new Date(T0).toISOString());
  assert.equal(firstPage.more, false);
  service.markDispatch(firstPage.items[0].occurrenceId, { state: 'queued', reason: 'sent' }, { now: T0 });
  assert.equal(service.dueReminders({ now: T0, limit: 8 }).items.length, 0);

  const later = T0 + 3 * DAY + 1;
  const page1 = service.dueReminders({ now: later, limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.more, true);
  const page2 = service.dueReminders({ now: later, limit: 2, after: page1.nextCursor });
  assert.deepEqual(page2.items.map((item) => item.sequence), [3]);
  assert.equal(page2.more, false);
  const all = [...page1.items, ...page2.items];
  assert.deepEqual(all.map((item) => item.sequence), [1, 2, 3]);
  assert.equal(new Set(all.map((item) => item.occurrenceId)).size, 3);
});

test('service：claimOccurrence 是幂等闸门', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const reminder = service.createReminder({
    message: '打卡',
    schedule: { anchor: T0, timezone: SH, frequency: 'once' },
  }, { now: T0 });
  service.materializeOccurrences({ reminderId: reminder.reminderId, horizonMs: DAY }, { now: T0 });
  const occurrenceId = `${reminder.reminderId}:0`;
  assert.deepEqual(service.claimOccurrence(occurrenceId, { now: T0 }), { claimed: true });
  assert.deepEqual(service.claimOccurrence(occurrenceId, { now: T0 + 1000 }), { claimed: false });
  assert.equal(dispatchRow(db, occurrenceId).state, 'queued');
});

test('service：nextOccurrenceAfter 跳跃式补下一期', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const reminder = service.createReminder({
    message: '每日提醒',
    schedule: { anchor: T0, timezone: SH, frequency: 'daily' },
  }, { now: T0 });
  const now = T0 + 10 * DAY;
  const next = service.nextOccurrenceAfter(reminder.reminderId, { afterSequence: 0, now });
  assert.equal(next.sequence, 10);
  assert.notEqual(next.sequence, 1);
  assert.equal(next.dueAt, new Date(now).toISOString());
  const booked = db.prepare('SELECT sequence, due_at FROM agenda_occurrences WHERE occurrence_id = ?').get(next.occurrenceId);
  assert.equal(Number(booked.sequence), 10);
  assert.equal(booked.due_at, new Date(now).toISOString());

  const once = service.createReminder({
    message: '一次提醒',
    schedule: { anchor: T0, timezone: SH, frequency: 'once' },
  }, { now: T0 });
  assert.equal(service.nextOccurrenceAfter(once.reminderId, { afterSequence: 0, now: T0 + DAY }), null);
});

test('service：rescheduleReminder 作废旧期次，cancelReminder 推进 revision', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const reminder = service.createReminder({
    message: '喝水',
    schedule: { anchor: T0, timezone: SH, frequency: 'daily' },
  }, { now: T0 });
  assert.equal(service.materializeOccurrences({ reminderId: reminder.reminderId, horizonMs: 2 * DAY }, { now: T0 }), 3);

  const rescheduled = service.rescheduleReminder(reminder.reminderId, {
    expectedRevision: 1,
    schedule: { anchor: T0 + HOUR, timezone: SH, frequency: 'daily' },
    leadMinutes: 10,
  }, { now: T0 + MINUTE });
  assert.equal(rescheduled.revision, 2);
  assert.equal(rescheduled.leadMinutes, 10);

  const oldRows = db.prepare('SELECT state FROM agenda_occurrences WHERE reminder_id = ? AND reminder_revision = 1')
    .all(reminder.reminderId);
  assert.equal(oldRows.length, 3);
  assert.ok(oldRows.every((row) => row.state === 'cancelled'));
  assert.equal(service.dueReminders({ now: T0 + 2 * DAY + 1, limit: 8 }).items.length, 0);

  assert.equal(service.materializeOccurrences({ reminderId: reminder.reminderId, horizonMs: 2 * DAY }, { now: T0 + MINUTE }), 2);
  const due = service.dueReminders({ now: T0 + 2 * DAY + 1, limit: 8 });
  assert.deepEqual(due.items.map((item) => item.reminderRevision), [2, 2]);

  assert.throws(
    () => service.rescheduleReminder(reminder.reminderId, {
      expectedRevision: 1,
      schedule: { anchor: T0, timezone: SH, frequency: 'daily' },
    }, { now: T0 + 2 * MINUTE }),
    (err) => err instanceof AgendaError && err.code === 'agenda_revision_conflict',
  );

  const cancelled = service.cancelReminder(reminder.reminderId, { expectedRevision: 2 }, { now: T0 + 3 * MINUTE });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.revision, 3);
  assert.equal(service.dueReminders({ now: T0 + 2 * DAY + 1, limit: 8 }).items.length, 0);
  const pending = db.prepare("SELECT COUNT(*) AS n FROM agenda_occurrences WHERE reminder_id = ? AND state = 'scheduled'")
    .get(reminder.reminderId);
  assert.equal(Number(pending.n), 0);
  assert.throws(
    () => service.cancelReminder(reminder.reminderId, { expectedRevision: 3 }, { now: T0 + 4 * MINUTE }),
    (err) => err instanceof AgendaError && err.code === 'invalid_reminder',
  );
});

test('service：角色未确认的日程需要先确认，listEvents 与 stats 可查', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const roleEvent = service.createEvent({
    kind: 'role_plan',
    title: '散步',
    durationMinutes: 30,
    schedule: { anchor: T0, timezone: SH, frequency: 'once' },
    creatorKind: 'role',
  }, { now: T0 });
  assert.equal(roleEvent.accepted, false);
  assert.throws(
    () => service.createReminder({
      eventId: roleEvent.eventId,
      message: '散步',
      schedule: { anchor: T0, timezone: SH, frequency: 'once' },
    }, { now: T0 }),
    (err) => err instanceof AgendaError && err.code === 'calendar_confirmation_required',
  );
  const confirmed = service.reviseEvent(roleEvent.eventId, {
    expectedRevision: 1,
    patch: { accepted: true },
  }, { now: T0 + MINUTE });
  assert.equal(confirmed.accepted, true);
  const reminder = service.createReminder({
    eventId: roleEvent.eventId,
    message: '散步',
    schedule: { anchor: T0, timezone: SH, frequency: 'once' },
  }, { now: T0 + MINUTE });
  assert.equal(reminder.eventId, roleEvent.eventId);

  const listed = service.listEvents({ limit: 10 }, { now: T0 });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].eventId, roleEvent.eventId);
  assert.equal(listed.more, false);
  assert.equal(service.listEvents({ kind: 'commitment' }, { now: T0 }).items.length, 0);

  const stats = service.stats({ now: T0 });
  assert.equal(stats.events, 1);
  assert.equal(stats.active, 1);
  assert.equal(stats.reminders, 1);
  assert.equal(stats.pendingDue, 0);

  assert.throws(
    () => service.createEvent({ kind: 'nope', title: 'x', durationMinutes: 30, schedule: { anchor: T0, timezone: SH, frequency: 'once' } }, { now: T0 }),
    (err) => err instanceof AgendaError && err.code === 'invalid_event',
  );
  assert.throws(
    () => service.createEvent({ kind: 'commitment', title: '', durationMinutes: 30, schedule: { anchor: T0, timezone: SH, frequency: 'once' } }, { now: T0 }),
    (err) => err instanceof AgendaError && err.code === 'invalid_event',
  );
  assert.throws(
    () => service.createEvent({ kind: 'commitment', title: 'x', durationMinutes: 30, schedule: { anchor: T0, timezone: 'Bad/Zone', frequency: 'once' } }, { now: T0 }),
    (err) => err instanceof AgendaError && err.code === 'invalid_schedule',
  );
  assert.throws(
    () => service.getEvent(createEventId(), { now: T0 }),
    (err) => err instanceof AgendaError && err.code === 'agenda_not_found',
  );
  assert.match(createReminderId(), /^rem_[0-9a-f-]{36}$/);
});

test('dispatcher：发送到期提醒、跳过禁用与过期条目', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const at = Date.UTC(2026, 4, 20, 0, 0);
  const reminder = service.createReminder({
    message: '开会',
    schedule: { anchor: at, timezone: SH, frequency: 'once' },
  }, { now: at });
  service.materializeOccurrences({ reminderId: reminder.reminderId, horizonMs: DAY }, { now: at });

  const api = makeApi();
  let settings = { enabled: true, latenessSeconds: 300, scanSize: 16, intervalSeconds: 30, timezone: SH };
  let chatId = 'private:10001';
  const dispatcher = createDispatcher({
    api,
    service,
    readSettings: () => settings,
    resolveChatId: () => chatId,
  });

  settings = { ...settings, enabled: false };
  assert.deepEqual(await dispatcher.tick({ now: at + MINUTE }), { skipped: 'disabled' });
  assert.equal(api.calls.length, 0);
  settings = { ...settings, enabled: true };

  const sent = await dispatcher.tick({ now: at + MINUTE });
  assert.deepEqual(sent, { sent: 1, skipped: 0, failed: 0 });
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].chatId, 'private:10001');
  assert.equal(api.calls[0].text, '[日程提醒] 08:00 开会');
  assert.equal(dispatchRow(db, `${reminder.reminderId}:0`).state, 'queued');
  assert.equal(dispatchRow(db, `${reminder.reminderId}:0`).reason, 'sent');

  assert.deepEqual(await dispatcher.tick({ now: at + 2 * MINUTE }), { sent: 0, skipped: 0, failed: 0 });
  assert.equal(api.calls.length, 1);

  const late = service.createReminder({
    message: '迟到提醒',
    schedule: { anchor: at, timezone: SH, frequency: 'once' },
  }, { now: at });
  service.materializeOccurrences({ reminderId: late.reminderId, horizonMs: DAY }, { now: at });
  const lateTick = await dispatcher.tick({ now: at + 301000 });
  assert.equal(lateTick.sent, 0);
  assert.equal(lateTick.skipped, 1);
  assert.equal(api.calls.length, 1);
  const lateRow = dispatchRow(db, `${late.reminderId}:0`);
  assert.equal(lateRow.state, 'skipped');
  assert.equal(lateRow.reason, 'late');

  chatId = '';
  const noTarget = service.createReminder({
    message: '无目标',
    schedule: { anchor: at, timezone: SH, frequency: 'once' },
  }, { now: at });
  service.materializeOccurrences({ reminderId: noTarget.reminderId, horizonMs: DAY }, { now: at });
  const noTargetTick = await dispatcher.tick({ now: at + MINUTE });
  assert.equal(noTargetTick.skipped, 1);
  assert.equal(api.calls.length, 1);
  const noTargetRow = dispatchRow(db, `${noTarget.reminderId}:0`);
  assert.equal(noTargetRow.state, 'skipped');
  assert.equal(noTargetRow.reason, 'no_target');
});

test('dispatcher：单条发送失败记为 failed 且不影响后续', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const at = Date.UTC(2026, 4, 21, 0, 0);
  const first = service.createReminder({
    message: '第一条',
    schedule: { anchor: at, timezone: SH, frequency: 'once' },
  }, { now: at });
  const second = service.createReminder({
    message: '第二条',
    schedule: { anchor: at, timezone: SH, frequency: 'once' },
  }, { now: at });
  service.materializeOccurrences({ reminderId: first.reminderId, horizonMs: DAY }, { now: at });
  service.materializeOccurrences({ reminderId: second.reminderId, horizonMs: DAY }, { now: at });

  const api = makeApi({ failAt: 1 });
  const dispatcher = createDispatcher({
    api,
    service,
    readSettings: () => ({ enabled: true, latenessSeconds: 300, scanSize: 8, timezone: SH }),
    resolveChatId: () => 'group:20002',
  });
  const result = await dispatcher.tick({ now: at + MINUTE });
  assert.equal(api.calls.length, 2);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  const rows = db.prepare('SELECT state, reason FROM agenda_dispatches ORDER BY state').all();
  assert.deepEqual(rows.map((row) => row.state), ['failed', 'queued']);
  assert.equal(rows.find((row) => row.state === 'failed').reason, '发送失败');
});

test('dispatcher：start 注册定时任务并在 stop 时解绑', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const api = makeApi();
  const dispatcher = createDispatcher({
    api,
    service,
    readSettings: () => ({ enabled: true, intervalSeconds: 0.5 }),
    resolveChatId: () => 'private:1',
  });
  const stop = dispatcher.start();
  assert.equal(api.timer.label, '日程提醒');
  assert.equal(api.timer.ms, 1000);
  assert.equal(typeof api.timer.fn, 'function');
  stop();
  assert.equal(api.closed, 1);
  assert.equal(DEFAULTS.latenessSeconds, 300);
  assert.equal(DEFAULTS.scanSize, 16);
  assert.equal(DEFAULTS.intervalSeconds, 30);
});

test('service：提醒提前量落到 due_at，dueReminders 与 nextOccurrenceAfter 都按提前后的时刻', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  // 上海每天 09:00 = 01:00Z；T0 是上海 08:00，首期在一小时后。
  const occurrenceStart = Date.UTC(2026, 4, 1, 1, 0);
  const dueAt = occurrenceStart - 30 * MINUTE;
  const reminder = service.createReminder({
    message: '上班提醒',
    leadMinutes: 30,
    schedule: { anchor: { y: 2026, m: 5, d: 1, H: 9, M: 0, S: 0 }, timezone: SH, frequency: 'daily' },
  }, { now: T0 });
  assert.equal(reminder.leadMinutes, 30);
  assert.equal(service.materializeOccurrences({ reminderId: reminder.reminderId, horizonMs: DAY }, { now: T0 }), 1);

  const occurrenceId = `${reminder.reminderId}:0`;
  const stored = db.prepare('SELECT due_at FROM agenda_occurrences WHERE occurrence_id = ?').get(occurrenceId);
  assert.equal(stored.due_at, new Date(dueAt).toISOString(), 'due_at 必须是期次时刻减 30 分钟');

  const onTime = service.dueReminders({ now: dueAt, limit: 8 });
  assert.deepEqual(onTime.items.map((item) => item.occurrenceId), [occurrenceId]);
  assert.equal(onTime.items[0].leadMinutes, 30);
  assert.equal(service.dueReminders({ now: dueAt - MINUTE, limit: 8 }).items.length, 0, '提前一分钟还没到期');

  // 下一期同样带 -30 分钟偏移
  const next = service.nextOccurrenceAfter(reminder.reminderId, { afterSequence: 0, now: occurrenceStart + MINUTE });
  assert.equal(next.sequence, 1);
  assert.equal(next.dueAt, new Date(occurrenceStart + DAY - 30 * MINUTE).toISOString());
  const nextRow = db.prepare('SELECT due_at FROM agenda_occurrences WHERE occurrence_id = ?').get(next.occurrenceId);
  assert.equal(nextRow.due_at, next.dueAt);
});

test('service：materializeOccurrences 跳过夏令时空洞后继续铺后面的期次', async (t) => {
  const { db } = await freshStore(t);
  const service = createService({ db, clock: () => T0 });
  const now = Date.UTC(2026, 2, 6, 12, 0);
  const reminder = service.createReminder({
    message: '夜班',
    schedule: {
      anchor: { y: 2026, m: 3, d: 6, H: 2, M: 30, S: 0 },
      timezone: NY,
      frequency: 'daily',
      gapPolicy: 'reject',
    },
  }, { now });

  // 3 月 6 日 02:30 是锚点，3 月 8 日那一期落进 DST 空洞。
  const inserted = service.materializeOccurrences({ reminderId: reminder.reminderId, horizonMs: 10 * DAY }, { now });
  const rows = db.prepare('SELECT sequence, due_at FROM agenda_occurrences WHERE reminder_id = ? ORDER BY sequence')
    .all(reminder.reminderId);
  assert.deepEqual(rows.map((row) => Number(row.sequence)), [1, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(inserted, rows.length);
  assert.ok(rows.every((row) => Number(row.sequence) !== 2), '空洞里那一期不该有行');
  // 第 3 期是 3 月 9 日 02:30 EDT = 06:30Z，leadMinutes 为 0 所以 due_at 就是期次时刻。
  assert.equal(
    rows.find((row) => Number(row.sequence) === 3).due_at,
    new Date(Date.UTC(2026, 2, 9, 6, 30)).toISOString(),
  );
});

test('dispatcher：formatReminderText 输出无 emoji 的中文提醒', () => {
  const dueShanghai = new Date(Date.UTC(2026, 4, 1, 6, 30)).toISOString();
  assert.equal(
    formatReminderText({ dueAt: dueShanghai, message: '开会', eventTitle: '' }, { zone: SH }),
    '[日程提醒] 14:30 开会',
  );
  assert.equal(
    formatReminderText({ dueAt: dueShanghai, message: '开会', eventTitle: '周会' }, { zone: SH }),
    '[日程提醒] 14:30 开会（周会）',
  );
  assert.equal(
    formatReminderText({ dueAt: dueShanghai, message: '开会', eventTitle: '开会' }, { zone: SH }),
    '[日程提醒] 14:30 开会',
  );
  assert.equal(
    formatReminderText({ dueAt: dueShanghai, message: '', eventTitle: '周会' }, { zone: SH }),
    '[日程提醒] 14:30 周会',
  );
  const dueNewYork = new Date(Date.UTC(2026, 2, 8, 18, 30)).toISOString();
  assert.equal(
    formatReminderText({ dueAt: dueNewYork, message: '站会' }, { zone: NY }),
    '[日程提醒] 14:30 站会',
  );
  const output = formatReminderText({ dueAt: dueShanghai, message: '开会' }, { zone: SH });
  assert.equal(/[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(output), false);
});