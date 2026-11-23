// 每日生成器（lib/planner.mjs）与其记账表的测试。
//
// 约定：所有时间显式传入 now，时区固定 Asia/Shanghai（无夏令时）；
// 数据库用真实的内存 SQLite（node:sqlite），不 mock SQL，tick / run 的落库效果直接查表核对。
// 模型与其它模块（night / memory）用假的 api 对象顶替。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  SCHEMA_VERSION,
  migrate,
  readPlanningSlot,
  writePlanningSlot,
  listPlanningSlots,
  deletePlanningSlot,
} from '../lib/store.mjs';
import { createService } from '../lib/service.mjs';
import {
  createPlanner,
  parsePlanningOutput,
  PLANNING_DEFAULTS,
  PLANNING_INSTRUCTION,
} from '../lib/planner.mjs';
import { localDateKey } from '../lib/time.mjs';

const ZONE = 'Asia/Shanghai';
const HOUR_MS = 3_600_000;

// 2026-03-08 12:00（+08:00）—— 已经过了默认的 07:30，也落在默认窗口 07:00–23:00 中间
const NOW = Date.UTC(2026, 2, 8, 4, 0, 0);
// 2026-03-08 07:00（+08:00）：默认的一天起点
const DAY_START = Date.UTC(2026, 2, 7, 23, 0, 0);
// 2026-03-08 23:00（+08:00）：默认的一天终点
const DAY_END = Date.UTC(2026, 2, 8, 15, 0, 0);

const pad2 = (n) => String(n).padStart(2, '0');

// 固定的 +08:00 格式化：上海没有夏令时，这里不必走 Intl。
function iso(ms) {
  const d = new Date(ms + 8 * HOUR_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
    + `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:00+08:00`;
}

function openDb(t) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  t.after(() => {
    try {
      db.close();
    } catch {
      // 关不掉也无所谓，内存库随进程回收
    }
  });
  return db;
}

function slotOf(nowMs, zone = ZONE) {
  return `daily:${zone}:${localDateKey(zone, nowMs)}`;
}

// 假 api：只实现 planner 用到的成员。think / ask 是可选的，缺了就走另一条路径。
function makeApi({ think, ask, use, every } = {}) {
  const calls = { think: 0, ask: 0, use: [], everyMs: 0, stopped: 0 };
  const api = {
    calls,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
  if (use) api.use = (id) => { calls.use.push(id); return use(id); };
  else api.use = (id) => { calls.use.push(id); return null; };
  if (think) api.think = async (prompt, opts) => { calls.think += 1; calls.prompt = prompt; calls.opts = opts; return think(prompt, opts); };
  if (ask) api.ask = async (opts) => { calls.ask += 1; calls.askOpts = opts; return ask(opts); };
  if (every) api.every = (ms, fn, label) => { calls.everyMs = ms; calls.label = label; return () => { calls.stopped += 1; }; };
  return api;
}

function mount(t, { settings = {}, api, now = NOW, db } = {}) {
  const database = db ?? openDb(t);
  const readSettings = () => ({ timezone: ZONE, ...PLANNING_DEFAULTS, ...settings });
  const planner = createPlanner({
    api: api ?? makeApi({ think: () => '{"items":[]}' }),
    service: createService({ db: database }),
    db: database,
    readSettings,
    now: () => now,
  });
  return { planner, db: database, api };
}

const eventCount = (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM agenda_events').get().n);
const eventRows = (db) => db.prepare('SELECT * FROM agenda_events ORDER BY anchor').all();

function item(title, startMs, minutes = 30, detail = '') {
  return { title, start: iso(startMs), minutes, detail };
}

// 提示词末尾是材料 JSON：切出来直接看模型到底收到了什么。
function materialOf(prompt) {
  const marker = '材料（JSON，仅作参考）：';
  const at = String(prompt ?? '').indexOf(marker);
  assert.ok(at >= 0, '提示词里应当带上材料段');
  return JSON.parse(String(prompt).slice(at + marker.length).trim());
}

// ---------- 1. 开关 ----------

test('tick：planningEnabled 为 false 返回 skipped disabled，且完全不叫模型', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner } = mount(t, { api, settings: { planningEnabled: false } });
  const result = await planner.tick();
  assert.equal(result.skipped, 'disabled');
  assert.equal(api.calls.think, 0);
  assert.equal(api.calls.ask, 0);
});

test('tick：整模块 enabled 为 false 时同样 disabled', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner } = mount(t, { api, settings: { enabled: false } });
  assert.equal((await planner.tick()).skipped, 'disabled');
  assert.equal(api.calls.think, 0);
});

// ---------- 2. 已经排过 ----------

test('tick：当天 slot 已经是 done 时返回 skipped already，不再调用模型', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner, db } = mount(t, { api });
  writePlanningSlot(db, slotOf(NOW), { state: 'done', attempts: 0, result: { saved: 1, rejected: 0 } });
  const result = await planner.tick();
  assert.equal(result.skipped, 'already');
  assert.equal(api.calls.think, 0);
});

// ---------- 3. 时间闸门 ----------

test('tick：本地时刻早于 planningTime 时 too_early，到点后才真的生成', async (t) => {
  // 2026-03-07 06:00（+08:00）：还没到 07:30
  const early = Date.UTC(2026, 2, 7, 22, 0, 0);
  const api = makeApi({ think: () => '{"items":[]}' });
  const earlyRun = mount(t, { api, now: early });
  assert.equal((await earlyRun.planner.tick()).skipped, 'too_early');
  assert.equal(api.calls.think, 0);

  const onTime = mount(t, { api: makeApi({ think: () => '{"items":[]}' }) });
  const result = await onTime.planner.tick();
  assert.equal(result.state, 'empty');
  assert.equal(onTime.api.calls.think, 1);
  assert.equal(onTime.api.calls.opts.title, '排今天的日程');
  assert.equal(onTime.api.calls.opts.timeoutMs, 90_000);
});

test('tick：时钟返回 NaN 时返回 invalid_clock，不抛错也不叫模型', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner } = mount(t, { api, now: NaN });
  const result = await planner.tick();
  assert.deepEqual(result, { skipped: 'invalid_clock' });
  assert.equal(api.calls.think, 0);
});

// ---------- 4. 正常生成与落库 ----------

test('run：合法 JSON 逐条落库，kind / accepted / creator_kind 符合角色自排语义，slot 变 done', async (t) => {
  const items = [
    item('读二十页书', NOW + 2 * HOUR_MS, 30, '把上周没读完的那本接着看'),
    item('下楼走一圈', NOW + 4 * HOUR_MS, 20, '顺便把垃圾带下去'),
  ];
  const api = makeApi({ think: () => JSON.stringify({ items }) });
  const { planner, db } = mount(t, { api, settings: { planningMaxItems: 2 } });

  const result = await planner.run({ now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.saved, 2);
  assert.equal(result.state, 'done');

  const rows = eventRows(db);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.kind, 'role_plan');
    assert.equal(row.state, 'active');
    assert.equal(row.creator_kind, 'role');
    assert.equal(Number(row.accepted), 1);
    assert.equal(row.presence, '');
    assert.equal(row.frequency, 'once');
    assert.equal(row.timezone, ZONE);
  }
  assert.deepEqual(rows.map((row) => row.title), ['读二十页书', '下楼走一圈']);
  assert.deepEqual(rows.map((row) => Number(row.duration_minutes)), [30, 20]);

  const slot = readPlanningSlot(db, slotOf(NOW));
  assert.equal(slot.state, 'done');
  assert.equal(slot.result.saved, 2);
  assert.equal(slot.attempts, 0);
});

// ---------- 4b. 段数按全天时长算 ----------

test('run：段数按全天时长算（dayMinutes / 85），超出 planningMaxItems 时被上限截断', async (t) => {
  // 09:00 生成：窗口仍是今天 07:00–23:00 的 960 分钟；960 / 85 四舍五入是 11 段，被上限 10 截断
  const morning = Date.UTC(2026, 2, 8, 1, 0, 0);
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner } = mount(t, { api, settings: { planningMaxItems: 10 } });
  assert.equal((await planner.run({ now: morning })).state, 'empty');

  const material = materialOf(api.calls.prompt);
  assert.equal(material.dayMinutes, 960);
  assert.equal(material.targetItems, 10);
  assert.equal(material.dayStart, iso(DAY_START));
  assert.equal(material.dayEnd, iso(DAY_END));
  assert.equal(material.remainingMinutes, undefined, '材料里不该再有 remainingMinutes');
  assert.equal(material.end, undefined, '材料里的结束时刻改叫 dayEnd');
  assert.ok(api.calls.prompt.includes('本次请安排 10 段'), '提示词要写明本次排几段');
  assert.ok(api.calls.prompt.includes(material.dayStart), '提示词要写明从哪一刻开始铺');
  assert.ok(api.calls.prompt.includes(material.dayEnd), '提示词要写明铺到哪一刻');
  assert.ok(api.calls.prompt.includes('一百字出头'), '段数多时要提醒控制正文长度');

  // 上限放宽到 16 时，按公式排 11 段
  const wideApi = makeApi({ think: () => '{"items":[]}' });
  const wide = mount(t, { api: wideApi, settings: { planningMaxItems: 16 } });
  assert.equal((await wide.planner.run({ now: morning })).state, 'empty');
  assert.equal(materialOf(wideApi.calls.prompt).targetItems, 11);
});

test('run：晚上 21:00 生成时段数仍按整天算（10 段），而不是只剩 2 段', async (t) => {
  // 21:00 生成：窗口仍然是 07:00–23:00，起点不随 now 往后挪
  const night = Date.UTC(2026, 2, 8, 13, 0, 0);
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner } = mount(t, { api, settings: { planningMaxItems: 10 } });
  assert.equal((await planner.run({ now: night })).state, 'empty');

  const material = materialOf(api.calls.prompt);
  assert.equal(material.dayMinutes, 960, '全天时长与 now 无关');
  assert.equal(material.targetItems, 10);
  assert.equal(material.dayStart, iso(DAY_START), '窗口起点不随 now 往后挪');
  assert.equal(material.dayEnd, iso(DAY_END));
  assert.ok(api.calls.prompt.includes('本次请安排 10 段'));
});

test('run：起点 / 终点把窗口收窄时，段数跟着窗口走，段数少就不补那句降级提醒', async (t) => {
  // 09:00–14:00 只有 300 分钟：300 / 85 四舍五入是 4 段；HH:MM 允许不补零
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner } = mount(t, {
    api,
    settings: { planningDayStart: '9:00', planningDayEnd: '14:00' },
  });
  assert.equal((await planner.run({ now: NOW })).state, 'empty');

  const material = materialOf(api.calls.prompt);
  assert.equal(material.dayMinutes, 300);
  assert.equal(material.targetItems, 4);
  assert.equal(material.dayStart, '2026-03-08T09:00:00+08:00');
  assert.equal(material.dayEnd, '2026-03-08T14:00:00+08:00');
  assert.equal(api.calls.prompt.includes('一百字出头'), false, '段数不多时不该补那句降级提醒');
});

test('run：起点 / 终点写坏或倒挂时回落到 07:00–23:00，返回里带 invalid_day_window', async (t) => {
  // 解析不出来：'aa:bb' 不是 HH:MM，'24:00' 小时越界
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner } = mount(t, { api, settings: { planningDayStart: 'aa:bb', planningDayEnd: '24:00' } });
  const result = await planner.run({ now: NOW });
  assert.equal(result.ok, true, '回落之后照常生成，不该算失败');
  assert.equal(result.state, 'empty');
  assert.equal(result.code, 'invalid_day_window');

  const material = materialOf(api.calls.prompt);
  assert.equal(material.dayStart, iso(DAY_START), '起点回落成 07:00');
  assert.equal(material.dayEnd, iso(DAY_END), '终点回落成 23:00');
  assert.equal(material.dayMinutes, 960);
  assert.equal(material.targetItems, 10);

  // 倒挂：dayEnd <= dayStart
  const reversedApi = makeApi({ think: () => '{"items":[]}' });
  const reversed = mount(t, {
    api: reversedApi,
    settings: { planningDayStart: '23:00', planningDayEnd: '07:00' },
  });
  const reversedResult = await reversed.planner.run({ now: NOW });
  assert.equal(reversedResult.code, 'invalid_day_window');
  const fallback = materialOf(reversedApi.calls.prompt);
  assert.equal(fallback.dayStart, iso(DAY_START));
  assert.equal(fallback.dayEnd, iso(DAY_END));
  assert.equal(fallback.dayMinutes, 960);
});

test('run / tick：now 已过 dayEnd 时返回 skipped too_late，不叫模型也不写记账', async (t) => {
  // 2026-03-08 23:30（+08:00）：今天 07:00–23:00 的整段窗口都过去了
  const past = Date.UTC(2026, 2, 8, 15, 30, 0);

  const api = makeApi({ think: () => { throw new Error('这个点不该再叫模型'); } });
  const { planner, db } = mount(t, { api, now: past });
  const result = await planner.run({ now: past });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'too_late');
  assert.equal(result.state, 'empty');
  assert.equal(result.saved, 0);
  assert.equal(result.message, '今天的日程时段已经过去了');
  assert.equal(api.calls.think, 0);
  assert.equal(eventCount(db), 0);
  assert.equal(planner.status().today.state, 'idle', '跳过时不写记账，别把 slot 卡在 running');

  const tickApi = makeApi({ think: () => { throw new Error('这个点不该再叫模型'); } });
  const ticking = mount(t, { api: tickApi, now: past });
  assert.equal((await ticking.planner.tick()).skipped, 'too_late');
  assert.equal(tickApi.calls.think, 0);
});

test('run：材料里的 existing 带上已有日程的正文，超过 160 字的部分截掉', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner, db } = mount(t, { api });
  const service = createService({ db });
  const base = '把昨天晾在椅背上的外套抖开，顺手把袖口的线头捻掉，屋里还是早上那股凉气。';
  const long = base.repeat(20).slice(0, 300);
  assert.equal(long.length, 300);
  service.createEvent({
    kind: 'user_report',
    title: '收晾了一夜的外套',
    detail: long,
    durationMinutes: 30,
    schedule: { anchor: NOW + 2 * HOUR_MS, timezone: ZONE, frequency: 'once' },
    creatorKind: 'owner',
  }, { now: NOW });

  assert.equal((await planner.run({ now: NOW })).state, 'empty');
  const material = materialOf(api.calls.prompt);
  assert.equal(material.existing.length, 1);
  const { detail } = material.existing[0];
  assert.equal(typeof detail, 'string', '已有日程的正文应当进材料');
  assert.ok(detail.length <= 160, `正文该截到 160 字以内，实际 ${detail.length}`);
  assert.equal(detail, long.slice(0, 160), '截断只该裁掉尾巴，不该改写内容');
});

// ---------- 4c. existing 材料的裁剪 ----------

test('run：材料里 existing 的标题截到 40 字，库里的标题保持原值', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner, db } = mount(t, { api });
  const service = createService({ db });
  const longTitle = '把晾在阳台上的外套收进来抖开叠好'.repeat(8).slice(0, 120);
  assert.equal(longTitle.length, 120);
  service.createEvent({
    kind: 'user_report',
    title: longTitle,
    detail: '袖口的线头还没捻干净。',
    durationMinutes: 30,
    schedule: { anchor: NOW + 2 * HOUR_MS, timezone: ZONE, frequency: 'once' },
    creatorKind: 'owner',
  }, { now: NOW });

  assert.equal((await planner.run({ now: NOW })).state, 'empty');
  const material = materialOf(api.calls.prompt);
  assert.equal(material.existing.length, 1);
  assert.ok(material.existing[0].title.length <= 40, `标题该截到 40 字以内，实际 ${material.existing[0].title.length}`);
  assert.equal(material.existing[0].title, longTitle.slice(0, 40), '截断只该裁掉尾巴');
  assert.equal(
    String(db.prepare('SELECT title FROM agenda_events').get().title),
    longTitle,
    '库里存的标题不该被材料口径裁短',
  );
});

test('run：材料里的 existing 最多 20 条', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner, db } = mount(t, { api });
  const service = createService({ db });
  for (let i = 0; i < 30; i += 1) {
    service.createEvent({
      kind: 'user_report',
      title: `第 ${i} 件小事`,
      durationMinutes: 5,
      schedule: { anchor: NOW + i * 10 * 60_000, timezone: ZONE, frequency: 'once' },
      creatorKind: 'owner',
    }, { now: NOW });
  }
  assert.equal(eventCount(db), 30);

  assert.equal((await planner.run({ now: NOW })).state, 'empty');
  const material = materialOf(api.calls.prompt);
  assert.ok(Array.isArray(material.existing));
  assert.ok(material.existing.length > 0, 'existing 不该为空');
  assert.ok(material.existing.length <= 20, `existing 最多 20 条，实际 ${material.existing.length}`);
});

test('run：existing 有独立预算，超了就停止加入后续条目并打 existingTruncated', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner, db } = mount(t, { api });
  const service = createService({ db });
  const body = '把外套抖开，顺手把袖口的线头捻掉，屋里还是早上那股凉气，窗台上的水渍还没干。'.repeat(6).slice(0, 160);
  assert.equal(body.length, 160);
  for (let i = 0; i < 20; i += 1) {
    service.createEvent({
      kind: 'user_report',
      title: `收外套 ${i}`,
      detail: body,
      durationMinutes: 5,
      schedule: { anchor: NOW + i * 10 * 60_000, timezone: ZONE, frequency: 'once' },
      creatorKind: 'owner',
    }, { now: NOW });
  }

  assert.equal((await planner.run({ now: NOW })).state, 'empty');
  const material = materialOf(api.calls.prompt);
  assert.ok(material.existing.length > 0, 'existing 不该为空');
  assert.ok(material.existing.length < 20, `独立预算应当截掉后面的条目，实际 ${material.existing.length}`);
  assert.equal(material.existingTruncated, true, '被独立预算截过就要打标');
  const chars = material.existing.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);
  assert.ok(chars <= 3000, `existing 各条序列化后合计该在 3000 以内，实际 ${chars}`);
});

test('run：偏好与记忆都很重时，existing 也不会被整块丢弃', async (t) => {
  const body = '把外套抖开，顺手把袖口的线头捻掉，屋里还是早上那股凉气，窗台上的水渍还没干。'.repeat(6).slice(0, 160);
  const longTitle = '把晾在阳台上的外套收进来抖开叠好'.repeat(8).slice(0, 120);
  const memoryText = '那天傍晚她把窗子推开一条缝，风把桌上的纸吹得哗啦响。'.repeat(8).slice(0, 238);
  const api = makeApi({
    think: () => '{"items":[]}',
    use: (id) => (id === 'memory'
      ? { list: () => Array.from({ length: 6 }, (_, i) => ({ text: `${memoryText}${i}`, at: NOW - (i + 1) * HOUR_MS })) }
      : null),
  });
  const { planner, db } = mount(t, { api, settings: { planningPrompt: '例'.repeat(2000) } });
  const service = createService({ db });
  for (let i = 0; i < 20; i += 1) {
    service.createEvent({
      kind: 'user_report',
      title: `${longTitle}${i}`,
      detail: body,
      durationMinutes: 5,
      schedule: { anchor: NOW + i * 10 * 60_000, timezone: ZONE, frequency: 'once' },
      creatorKind: 'owner',
    }, { now: NOW });
  }

  assert.equal((await planner.run({ now: NOW })).state, 'empty');
  const material = materialOf(api.calls.prompt);
  assert.ok(Array.isArray(material.existing), 'existing 必须还在材料里');
  assert.ok(material.existing.length > 0, '偏好与记忆再重也不该把 existing 整块丢掉');
  assert.ok(material.existing.length <= 20, `existing 最多 20 条，实际 ${material.existing.length}`);
  assert.equal(material.existingTruncated, true, '被独立预算截过就要打标');
  assert.ok(JSON.stringify(material).length <= 8000, '整段材料仍要落在 8000 字预算内');
});

// ---------- 4d. 长标题日程的去重：签名与材料同口径 ----------

test('run：库里 123 字标题的日程，模型回抄材料里的 40 字标题也判重复，不再落一份', async (t) => {
  const longTitle = '把晾在阳台上的外套收进来抖开叠好'.repeat(8).slice(0, 123);
  assert.equal(longTitle.length, 123);
  const anchor = NOW + 2 * HOUR_MS;

  let seenTitle = '';
  // 模型只看得见材料：回抄那条 40 字标题，起点与分钟数跟库里完全相同
  const api = makeApi({
    think: (prompt) => {
      const entry = materialOf(prompt).existing[0];
      seenTitle = entry.title;
      return JSON.stringify({ items: [{ title: entry.title, start: entry.start, minutes: 30, detail: '' }] });
    },
  });
  const { planner, db } = mount(t, { api });
  createService({ db }).createEvent({
    kind: 'user_report',
    title: longTitle,
    detail: '袖口的线头还没捻干净。',
    durationMinutes: 30,
    schedule: { anchor, timezone: ZONE, frequency: 'once' },
    creatorKind: 'owner',
  }, { now: NOW });
  assert.equal(eventCount(db), 1);

  const result = await planner.run({ now: NOW });
  assert.equal(seenTitle, longTitle.slice(0, 40), '模型能看到的标题只有前 40 字');
  assert.equal(result.saved, 0, '同起点同分钟的同一条日程不该再落一份');
  assert.equal(result.items, 0);
  assert.deepEqual(result.rejectedItems.map((row) => row.code), ['duplicate']);
  assert.equal(eventCount(db), 1, '库里事件数不变');
  assert.equal(String(db.prepare('SELECT title FROM agenda_events').get().title), longTitle, '原标题也不该被改写');
});

test('run：标题与起点都不同时不判重复，照常落库', async (t) => {
  const api = makeApi({ think: () => JSON.stringify({ items: [item('写点东西', NOW + 3 * HOUR_MS, 30)] }) });
  const { planner, db } = mount(t, { api });
  createService({ db }).createEvent({
    kind: 'user_report',
    title: '读书',
    durationMinutes: 30,
    schedule: { anchor: NOW + 2 * HOUR_MS, timezone: ZONE, frequency: 'once' },
    creatorKind: 'owner',
  }, { now: NOW });

  const result = await planner.run({ now: NOW });
  assert.equal(result.saved, 1, '换标题又换起点的正常条目不该被签名判成重复');
  assert.equal(result.items, 1);
  assert.deepEqual(result.rejectedItems, []);
  assert.equal(eventCount(db), 2);
});

// ---------- 5. 空结果 ----------

test('run：模型返回空列表时 slot 变 empty，库里零条', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner, db } = mount(t, { api });
  const result = await planner.run({ now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.saved, 0);
  assert.equal(result.state, 'empty');
  assert.equal(eventCount(db), 0);
  assert.equal(readPlanningSlot(db, slotOf(NOW)).state, 'empty');
});

// ---------- 6. 三种输出形态 ----------

test('parsePlanningOutput：代码围栏、末尾截断、裸数组三种形态都能解析', () => {
  const job = { dayStartMs: DAY_START, dayEndMs: DAY_END, timezone: ZONE, maxItems: 2, existing: [] };

  const fenced = '```json\n' + JSON.stringify({ items: [item('浇花', NOW + HOUR_MS, 10)] }) + '\n```';
  const fencedResult = parsePlanningOutput(fenced, job);
  assert.equal(fencedResult.items.length, 1);
  assert.equal(fencedResult.items[0].title, '浇花');

  const truncated = `{"items":[${JSON.stringify(item('浇花', NOW + HOUR_MS, 10))},` +
    '{"title":"写日记","start":"2026-03-08T21:00:00+08:00","minutes":20,"det';
  const truncatedResult = parsePlanningOutput(truncated, job);
  assert.equal(truncatedResult.items.length, 1);
  assert.equal(truncatedResult.items[0].title, '浇花');

  const bareArray = JSON.stringify([item('擦桌子', NOW + HOUR_MS, 15)]);
  const bareResult = parsePlanningOutput(bareArray, job);
  assert.equal(bareResult.items.length, 1);
  assert.equal(bareResult.items[0].title, '擦桌子');

  assert.throws(() => parsePlanningOutput('今天不想安排。', job), (error) => error.code === 'planning_output_invalid');
});

// ---------- 7. 逐条校验与去重 ----------

test('parsePlanningOutput：越界 / 跨零点 / 分钟越界 / 空标题 / 与已有日程重复都被拒绝', () => {
  const existingStart = NOW + 5 * HOUR_MS;
  const job = {
    dayStartMs: DAY_START,
    dayEndMs: DAY_END,
    timezone: ZONE,
    maxItems: 8,
    existing: [{ title: '散步', start: existingStart, minutes: 30 }],
  };
  const payload = {
    items: [
      item('天亮之前', DAY_START - HOUR_MS, 30),             // 0 start_out_of_range（早于 dayStart）
      item('跨零点', DAY_END - 30 * 60_000, 60),             // 1 cross_midnight
      item('零分钟', NOW + HOUR_MS, 0),                     // 2 invalid_minutes
      item('太久了', NOW + HOUR_MS, 1441),                  // 3 invalid_minutes
      { title: '   ', start: iso(NOW + HOUR_MS), minutes: 30 }, // 4 invalid_title
      item('散步', existingStart, 30),                       // 5 duplicate（和 existing 撞签名）
      item('写点东西', NOW + HOUR_MS, 30),                   // 6 合法
      item('写点东西', NOW + HOUR_MS, 30),                   // 7 duplicate（同批重复）
    ],
  };
  const result = parsePlanningOutput(JSON.stringify(payload), job);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, '写点东西');
  const codes = result.rejected.map((row) => `${row.index}:${row.code}`).sort();
  assert.deepEqual(codes.sort(), [
    '0:start_out_of_range',
    '1:cross_midnight',
    '2:invalid_minutes',
    '3:invalid_minutes',
    '4:invalid_title',
    '5:duplicate',
    '7:duplicate',
  ].sort());
  assert.equal(result.truncated, false);
});

test('parsePlanningOutput：start 恰好等于 dayEnd 也算越界', () => {
  const job = { dayStartMs: DAY_START, dayEndMs: DAY_END, timezone: ZONE, maxItems: 2, existing: [] };
  const payload = { items: [{ title: '刚好压线', start: '2026-03-08T23:00:00+08:00', minutes: 10 }] };
  const result = parsePlanningOutput(JSON.stringify(payload), job);
  assert.equal(result.items.length, 0);
  assert.equal(result.rejected[0].code, 'start_out_of_range');
});

test('run：19:00 生成时，09:00 这类早于 now 的条目不被拒绝，正常落库', async (t) => {
  // 19:00 本地；条目起点是 09:00（早于 now，但仍在 07:00–23:00 里）
  const evening = Date.UTC(2026, 2, 8, 11, 0, 0);
  const api = makeApi({
    think: () => JSON.stringify({
      items: [item('上午翻了两页书', DAY_START + 2 * HOUR_MS, 60, '窗子开着，纸页被风翻动，桌上的水凉透了')],
    }),
  });
  const { planner, db } = mount(t, { api, now: evening });
  const result = await planner.run({ now: evening });
  assert.equal(result.ok, true);
  assert.equal(result.saved, 1, '窗口内早于 now 的时段应当能落库');
  assert.equal(result.items, 1);
  assert.deepEqual(result.rejectedItems, []);
  assert.equal(eventCount(db), 1);
  assert.equal(Date.parse(eventRows(db)[0].anchor), DAY_START + 2 * HOUR_MS, '落库的起点就是模型给的那个过去时段');
});

// ---------- 8. maxItems ----------

test('parsePlanningOutput：超过 maxItems 的截断并记 over_limit', () => {
  const job = { dayStartMs: DAY_START, dayEndMs: DAY_END, timezone: ZONE, maxItems: 2, existing: [] };
  const payload = {
    items: [
      item('第一件', NOW + 3 * HOUR_MS, 20),
      item('第二件', NOW + 1 * HOUR_MS, 20),
      item('第三件', NOW + 2 * HOUR_MS, 20),
    ],
  };
  const result = parsePlanningOutput(JSON.stringify(payload), job);
  assert.equal(result.items.length, 2);
  // 按开始时间先排，最早的两件留下
  assert.deepEqual(result.items.map((row) => row.title), ['第二件', '第三件']);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rejected.map((row) => row.code), ['over_limit']);
});

// ---------- 标题上限：超过 200 字直接拒绝，不静默截断 ----------

test('parsePlanningOutput：200 字标题放行，230 字标题按 title_too_long 拒绝', () => {
  const job = { dayStartMs: DAY_START, dayEndMs: DAY_END, timezone: ZONE, maxItems: 2, existing: [] };
  const boundary = parsePlanningOutput(JSON.stringify({
    items: [{ title: '读'.repeat(200), start: iso(NOW + HOUR_MS), minutes: 30 }],
  }), job);
  assert.equal(boundary.items.length, 1, '正好 200 字应当放行');
  assert.equal(boundary.rejected.length, 0);

  const tooLong = parsePlanningOutput(JSON.stringify({
    items: [{ title: '读'.repeat(230), start: iso(NOW + HOUR_MS), minutes: 30 }],
  }), job);
  assert.equal(tooLong.items.length, 0);
  assert.deepEqual(tooLong.rejected.map((row) => row.code), ['title_too_long']);
});

test('run：230 字标题被整条拒绝，不落库也不切成 200 字', async (t) => {
  const longTitle = '读'.repeat(230);
  const api = makeApi({ think: () => JSON.stringify({ items: [item(longTitle, NOW + 2 * HOUR_MS, 30)] }) });
  const { planner, db } = mount(t, { api });
  const result = await planner.run({ now: NOW });
  assert.equal(result.saved, 0);
  assert.equal(result.items, 0);
  assert.equal(result.rejected, 1);
  assert.deepEqual(result.rejectedItems.map((row) => row.code), ['title_too_long']);
  assert.equal(eventCount(db), 0, '超长标题既不该落库，也不该被 clip 成 200 字存进去');
});

// ---------- 9. 失败与重试上限 ----------

test('run：模型抛错时 slot 变 failed、attempts 递增；到上限后 tick 返回 exhausted', async (t) => {
  const api = makeApi({ think: async () => { throw new Error('后台会话冷却中'); } });
  const { planner, db } = mount(t, { api, settings: { planningMaxAttempts: 3, planningRetryMinutes: 5 } });

  const first = await planner.run({ now: NOW });
  assert.equal(first.ok, false);
  assert.equal(first.state, 'failed');
  let slot = readPlanningSlot(db, slotOf(NOW));
  assert.equal(slot.state, 'failed');
  assert.equal(slot.attempts, 1);

  await planner.run({ now: NOW });
  await planner.run({ now: NOW });
  slot = readPlanningSlot(db, slotOf(NOW));
  assert.equal(slot.attempts, 3);

  const skipped = await planner.tick();
  assert.equal(skipped.skipped, 'exhausted');
  assert.equal(api.calls.think, 3, '到了上限就不该再叫模型');
  assert.equal(eventCount(db), 0);
});

test('tick：失败后未到重试间隔时 backoff', async (t) => {
  const api = makeApi({ think: async () => { throw new Error('超时'); } });
  // updated_at 是写入时的真实时间，所以记账也要用真实时钟写：直接写一条「刚失败」的 slot，
  // 这样用例不依赖「现在正好还在 07:00–23:00 里」，也不会被 too_late 提前拦下。
  const realNow = Date.now();
  const { planner, db } = mount(t, {
    api,
    settings: { planningTime: '00:00', planningMaxAttempts: 3, planningRetryMinutes: 15 },
    now: realNow,
  });
  writePlanningSlot(db, slotOf(realNow), { state: 'failed', attempts: 1, result: { saved: 0, message: '超时' } });

  const result = await planner.tick();
  assert.equal(result.skipped, 'backoff');
  assert.equal(api.calls.think, 0, '退避期间不该再叫模型');
  assert.equal(planner.status().today.attempts, 1);
});

// ---------- 10. 手动触发 ----------

test('run：manual 不受「今天已经排过」限制，仍能重新生成并写记账', async (t) => {
  let round = 0;
  const api = makeApi({
    think: () => {
      round += 1;
      return JSON.stringify({ items: [item(round === 1 ? '第一次的安排' : '第二次的安排', NOW + 2 * HOUR_MS, 30)] });
    },
  });
  const { planner, db } = mount(t, { api });

  const auto = await planner.tick();
  assert.equal(auto.state, 'done');
  assert.equal((await planner.tick()).skipped, 'already');

  const manual = await planner.run({ now: NOW, mode: 'daily', manual: true });
  assert.equal(manual.ok, true);
  assert.equal(manual.saved, 1);
  assert.equal(api.calls.think, 2);
  assert.equal(eventCount(db), 2);
  assert.equal(readPlanningSlot(db, slotOf(NOW)).state, 'done');
});

test('run：手工重排只拿到与已有日程重复的条目时，slot 保持 done 不降级成 empty', async (t) => {
  const items = [
    item('读二十页书', NOW + 2 * HOUR_MS, 30, '接着上周那本'),
    item('下楼走一圈', NOW + 4 * HOUR_MS, 20, '顺便把垃圾带下去'),
  ];
  // 两轮返回完全相同的条目：第二轮签名全部撞上已有的，一条都落不了库
  const api = makeApi({ think: () => JSON.stringify({ items }) });
  const { planner, db } = mount(t, { api, settings: { planningMaxItems: 2 } });

  const first = await planner.run({ now: NOW });
  assert.equal(first.state, 'done');
  assert.equal(first.saved, 2);
  assert.equal(eventCount(db), 2);

  const manual = await planner.run({ now: NOW, mode: 'daily', manual: true });
  assert.equal(manual.saved, 0);
  assert.equal(manual.items, 0);
  assert.equal(manual.state, 'done', '今天本来就排好了，不该降级成 empty');
  assert.ok(manual.message.includes('已经排过'), `消息应说明是重复而不是没安排：${manual.message}`);
  assert.equal(eventCount(db), 2, '重复的条目不该再落一份');

  const slot = readPlanningSlot(db, slotOf(NOW));
  assert.equal(slot.state, 'done');
  assert.equal(slot.attempts, 0);
  assert.equal(slot.result.saved, 0);
  assert.ok(String(slot.result.message).includes('已经排过'));
});

// ---------- 11. 可选材料静默降级 ----------

test('run：api.use 抛错或返回 undefined 时，生成流程照常完成', async (t) => {
  const api = makeApi({
    think: () => JSON.stringify({ items: [item('听一会儿歌', NOW + HOUR_MS, 15)] }),
    use: (id) => {
      if (id === 'night') throw new Error('night 没装');
      return undefined;
    },
  });
  const { planner, db } = mount(t, { api });
  const result = await planner.run({ now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.saved, 1);
  assert.equal(eventCount(db), 1);

  const night = makeApi({
    think: () => '{"items":[]}',
    use: (id) => {
      if (id === 'night') return { snapshot: () => ({ energy: 42.7, mode: 'awake', fatigue: 'night' }) };
      if (id === 'memory') return { list: () => [{ text: '昨天说想早睡', at: NOW - 24 * HOUR_MS }] };
      return null;
    },
  });
  const second = mount(t, { api: night });
  assert.equal((await second.planner.run({ now: NOW })).state, 'empty');
  const prompt = night.calls.prompt;
  assert.ok(prompt.includes('42.7'), '精力应当出现在材料里');
  assert.ok(prompt.includes('昨天说想早睡'), '最近记忆应当出现在材料里');
});

test('run：既没有 think 也没有 ask 时返回 planning_no_model，不冒泡', async (t) => {
  const { planner } = mount(t, { api: makeApi({}) });
  const result = await planner.run({ now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'planning_no_model');
});

test('run：材料里的 existing 只给中文 kind 标签，不透内部枚举名', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}' });
  const { planner, db } = mount(t, { api });
  const service = createService({ db });
  const kinds = ['role_plan', 'user_report', 'commitment'];
  kinds.forEach((kind, index) => {
    service.createEvent({
      kind,
      title: `材料 ${index}`,
      durationMinutes: 30,
      schedule: { anchor: NOW + (index + 1) * HOUR_MS, timezone: ZONE, frequency: 'once' },
      creatorKind: 'owner',
    }, { now: NOW });
  });

  assert.equal((await planner.run({ now: NOW })).state, 'empty');

  const prompt = api.calls.prompt;
  for (const label of ['自己的安排', '用户提过的事', '约定']) {
    assert.ok(prompt.includes(label), `材料里应当出现中文标签「${label}」`);
  }
  for (const enumName of kinds) {
    assert.equal(prompt.includes(enumName), false, `材料里不该出现内部枚举 ${enumName}`);
  }
});

// ---------- 记账与定时器 ----------

test('store：v3 的库升级到 v4 只加新表，旧表不动', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => { try { db.close(); } catch {} });
  db.exec('PRAGMA user_version = 3');
  db.exec('CREATE TABLE legacy_marker (id TEXT PRIMARY KEY NOT NULL)');
  assert.equal(migrate(db), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 4);
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  assert.equal(version, 4);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(names.includes('agenda_planning_slots'));
  assert.ok(names.includes('legacy_marker'), '升级不该删旧表');
});

test('store：planning slot 的读写、列出与删除', (t) => {
  const db = openDb(t);
  const slot = slotOf(NOW);
  assert.equal(readPlanningSlot(db, slot), null);

  const written = writePlanningSlot(db, slot, { state: 'failed', attempts: 2, result: { saved: 0, message: 'x' } });
  assert.equal(written.state, 'failed');
  assert.equal(written.attempts, 2);
  assert.equal(written.result.message, 'x');

  writePlanningSlot(db, slot, { state: 'done', attempts: 2, result: { saved: 1 } });
  const again = readPlanningSlot(db, slot);
  assert.equal(again.state, 'done');
  assert.equal(again.result.saved, 1);
  assert.equal(again.createdAt, written.createdAt, '更新不该换 created_at');

  assert.equal(listPlanningSlots(db, { limit: 5 }).length, 1);
  assert.equal(deletePlanningSlot(db, slot), true);
  assert.equal(readPlanningSlot(db, slot), null);
  assert.throws(() => writePlanningSlot(db, slot, { state: 'weird' }), (error) => error.code === 'invalid_slot_state');
});

test('start / stop 真的挂上并停掉定时器', async (t) => {
  const api = makeApi({ think: () => '{"items":[]}', every: () => {} });
  const { planner } = mount(t, { api });
  planner.start();
  assert.equal(api.calls.everyMs, 300_000);
  assert.equal(api.calls.label, '每日日程生成');
  planner.stop();
  assert.equal(api.calls.stopped, 1);
  planner.stop();
  assert.equal(api.calls.stopped, 1, '重复 stop 不该再调一次');
});

test('start：定时器回调自己吞掉 tick 的 rejection，不会变成未处理拒绝', async (t) => {
  const db = openDb(t);
  const warnings = [];
  let scheduled = null;
  const planner = createPlanner({
    api: {
      log: { debug() {}, info() {}, warn: (message) => warnings.push(String(message)), error() {} },
      every: (ms, fn, label) => {
        scheduled = { ms, fn, label };
        return () => {};
      },
    },
    service: createService({ db }),
    db,
    readSettings: () => ({ timezone: ZONE, ...PLANNING_DEFAULTS }),
    // 时钟本身抛错：tick 里没有别的地方能接住，只能靠回调上的 catch
    now: () => { throw new Error('时钟炸了'); },
  });

  planner.start();
  assert.equal(typeof scheduled?.fn, 'function');
  assert.equal(scheduled.fn(), undefined, '回调不该把 promise 漏给宿主');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /每日日程生成失败/);
  assert.match(warnings[0], /时钟炸了/);
});

test('status：没有记账时是 idle，生成后带出今天的结果', async (t) => {
  const api = makeApi({ think: () => JSON.stringify({ items: [item('泡茶', NOW + HOUR_MS, 10)] }) });
  const { planner } = mount(t, { api });

  const before = planner.status();
  assert.equal(before.ok, true);
  assert.equal(before.today.state, 'idle');
  assert.equal(before.today.slot, slotOf(NOW));
  assert.equal(before.enabled, true);
  assert.equal(before.time, PLANNING_DEFAULTS.planningTime);

  await planner.run({ now: NOW });
  const after = planner.status();
  assert.equal(after.today.state, 'done');
  assert.equal(after.today.saved, 1);
  assert.equal(after.today.rejected, 0);
  assert.ok(after.today.startedAt);
  assert.ok(after.today.updatedAt);
});

test('PLANNING_INSTRUCTION 覆盖必要约束与输出格式', () => {
  for (const snippet of [
    'targetItems',
    'dayStart',
    'dayEnd',
    '23:00',
    '60 到 100 分钟',
    '八十到一百六十',
    '17:00',
    'existing',
    '{"items":[]}',
    'ISO',
  ]) {
    assert.ok(PLANNING_INSTRUCTION.includes(snippet), `提示词里缺少「${snippet}」`);
  }
  assert.equal(PLANNING_INSTRUCTION.includes('1 到 2 件'), false, '段数不该再固定成一两件');
  assert.equal(PLANNING_INSTRUCTION.includes('30 到 90 分钟'), false, '每段时长已改成 60–100 分钟');
  assert.equal(PLANNING_INSTRUCTION.includes('只安排 now 之后'), false, '不该再把窗口限制在 now 之后');
  // 第 11 条是「将来的时段写的是打算」，属于将来语态，和「过去时段用叙述语气」并不冲突；
  // 所以这里只否定真正矛盾的说法，再正向确认两条语态规则都在位。
  assert.equal(PLANNING_INSTRUCTION.includes('过去的时段写的是打算'), false, '过去的时段写的是经过，不是打算');
  assert.equal(PLANNING_INSTRUCTION.includes('没到的时段不用排'), false, '还没到的时段也要照常排出来');
  assert.ok(PLANNING_INSTRUCTION.includes('已经过去的时段也照常排出来'), '提示词应要求过去时段照常排出');
  assert.ok(PLANNING_INSTRUCTION.includes('将来的时段写的是打算'), '提示词应要求将来时段写成打算');
  // detail 只写室内与自身：屋外的事她无从知道，提示词里也不该再有任何把视线引到外面的措辞。
  assert.ok(PLANNING_INSTRUCTION.includes('屋外的一切'), '提示词应明确屋外的事一律不写');
  assert.ok(PLANNING_INSTRUCTION.includes('只能写成自己的打算或者猜测'), '提到外面时只能是打算或猜测');
  assert.ok(PLANNING_INSTRUCTION.includes('不能写成观测到的事实'), '不能把外部观测写成事实');
  assert.equal(PLANNING_INSTRUCTION.includes('窗外的声音'), false, '不该再引导写窗外的声音');
  assert.equal(PLANNING_INSTRUCTION.includes('窗外'), false, '提示词整体不该再出现「窗外」');
  assert.equal(PLANNING_INSTRUCTION.includes('远处有什么声响'), false, '不该再引导写远处的声响');
  assert.equal(PLANNING_DEFAULTS.planningTime, '07:30');
  assert.equal(PLANNING_DEFAULTS.planningDayStart, '07:00');
  assert.equal(PLANNING_DEFAULTS.planningDayEnd, '23:00');
  assert.equal(PLANNING_DEFAULTS.planningMaxItems, 10);
  assert.equal(PLANNING_DEFAULTS.planningMaxAttempts, 3);
});
