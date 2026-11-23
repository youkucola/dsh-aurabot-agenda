import test from 'node:test';
import assert from 'node:assert/strict';

import { utcToWall } from '../lib/time.mjs';
import {
  ScheduleError,
  FREQUENCIES,
  GAP_POLICIES,
  MAX_OCCURRENCES,
  MAX_SPAN_MS,
  normalizeSchedule,
  scheduleAt,
  firstAtOrAfter,
  occurrences,
  scheduleToJson,
  scheduleFromJson,
  describeSchedule,
} from '../lib/schedule.mjs';

const throwsCode = (code) => (err) => err instanceof ScheduleError && err.code === code;

test('导出常量符合契约', () => {
  assert.deepEqual(FREQUENCIES, ['once', 'daily', 'weekly', 'monthly', 'yearly']);
  assert.deepEqual(GAP_POLICIES, ['reject', 'shift_forward']);
  assert.equal(MAX_OCCURRENCES, 64);
  assert.equal(MAX_SPAN_MS, 31 * 86400000);
});

test('normalizeSchedule 接受墙钟 / ISO 字符串 / Date / 毫秒锚点', () => {
  const base = { timezone: 'America/New_York', frequency: 'daily' };
  const fromWall = normalizeSchedule({ ...base, anchor: { y: 2026, m: 3, d: 8, H: 9, M: 0, S: 0 } });
  // 纽约 2026-03-08 已进入夏令时，09:00 本地 = 13:00Z
  assert.equal(fromWall.anchor, Date.UTC(2026, 2, 8, 13, 0, 0));
  assert.deepEqual(fromWall.anchorWall, { y: 2026, m: 3, d: 8, H: 9, M: 0, S: 0 });

  const fromIso = normalizeSchedule({ ...base, anchor: '2026-03-08T13:00:00.000Z' });
  assert.equal(fromIso.anchor, fromWall.anchor);
  assert.deepEqual(fromIso.anchorWall, fromWall.anchorWall);

  const fromDate = normalizeSchedule({ ...base, anchor: new Date(Date.UTC(2026, 2, 8, 13, 0, 0)) });
  assert.equal(fromDate.anchor, fromWall.anchor);

  const fromMs = normalizeSchedule({ ...base, anchor: Date.UTC(2026, 2, 8, 13, 0, 0) });
  assert.equal(fromMs.anchor, fromWall.anchor);

  // 默认值归一
  assert.equal(fromMs.interval, 1);
  assert.equal(fromMs.count, null);
  assert.equal(fromMs.fold, 0);
  assert.equal(fromMs.gapPolicy, 'reject');
});

test('normalizeSchedule 在 DST 空洞内默认拒绝，shift_forward 顺延', () => {
  const at = { y: 2026, m: 3, d: 8, H: 2, M: 30, S: 0 };
  assert.throws(
    () => normalizeSchedule({ anchor: at, timezone: 'America/New_York', frequency: 'once' }),
    throwsCode('schedule_needs_resolution'),
  );
  const shifted = normalizeSchedule({
    anchor: at,
    timezone: 'America/New_York',
    frequency: 'once',
    gapPolicy: 'shift_forward',
  });
  assert.equal(shifted.anchor, Date.UTC(2026, 2, 8, 7, 30, 0));
});

test('daily 跨 DST 后墙钟仍是 09:00', () => {
  const schedule = normalizeSchedule({
    anchor: { y: 2026, m: 3, d: 6, H: 9, M: 0, S: 0 },
    timezone: 'America/New_York',
    frequency: 'daily',
  });
  const expected = [
    Date.UTC(2026, 2, 6, 14, 0, 0),
    Date.UTC(2026, 2, 7, 14, 0, 0),
    Date.UTC(2026, 2, 8, 13, 0, 0),
    Date.UTC(2026, 2, 9, 13, 0, 0),
  ];
  expected.forEach((ms, index) => {
    assert.equal(scheduleAt(schedule, index), ms, `第 ${index} 期`);
    assert.deepEqual(utcToWall('America/New_York', scheduleAt(schedule, index)), {
      y: 2026,
      m: 3,
      d: 6 + index,
      H: 9,
      M: 0,
      S: 0,
    });
  });
});

test('weekly 的 count 限制期次范围', () => {
  const schedule = normalizeSchedule({
    anchor: { y: 2026, m: 1, d: 1, H: 9, M: 0, S: 0 },
    timezone: 'UTC',
    frequency: 'weekly',
    count: 8,
  });
  assert.equal(scheduleAt(schedule, 0), Date.UTC(2026, 0, 1, 9, 0, 0));
  assert.equal(scheduleAt(schedule, 7), Date.UTC(2026, 1, 19, 9, 0, 0));
  assert.throws(() => scheduleAt(schedule, 8), throwsCode('schedule_out_of_range'));
  assert.equal(firstAtOrAfter(schedule, Date.UTC(2026, 1, 20, 0, 0, 0)), null);
});

test('monthly 月末夹取且始终从锚点直接计算', () => {
  const schedule = normalizeSchedule({
    anchor: { y: 2026, m: 1, d: 31, H: 9, M: 0, S: 0 },
    timezone: 'UTC',
    frequency: 'monthly',
  });
  const expected = [
    Date.UTC(2026, 0, 31, 9, 0, 0),
    Date.UTC(2026, 1, 28, 9, 0, 0),
    Date.UTC(2026, 2, 31, 9, 0, 0),
    Date.UTC(2026, 3, 30, 9, 0, 0),
  ];
  expected.forEach((ms, index) => assert.equal(scheduleAt(schedule, index), ms, `第 ${index} 期`));
  assert.equal(scheduleAt(schedule, 12), Date.UTC(2027, 0, 31, 9, 0, 0));
  assert.equal(scheduleAt(schedule, 13), Date.UTC(2027, 1, 28, 9, 0, 0));
});

test('yearly 以闰日为锚点按月夹取', () => {
  const schedule = normalizeSchedule({
    anchor: { y: 2024, m: 2, d: 29, H: 9, M: 0, S: 0 },
    timezone: 'UTC',
    frequency: 'yearly',
  });
  assert.equal(scheduleAt(schedule, 0), Date.UTC(2024, 1, 29, 9, 0, 0));
  assert.equal(scheduleAt(schedule, 1), Date.UTC(2025, 1, 28, 9, 0, 0));
  assert.equal(scheduleAt(schedule, 2), Date.UTC(2026, 1, 28, 9, 0, 0));
  assert.equal(scheduleAt(schedule, 3), Date.UTC(2027, 1, 28, 9, 0, 0));
  assert.equal(scheduleAt(schedule, 4), Date.UTC(2028, 1, 29, 9, 0, 0));
});

test('once 只有第 0 期', () => {
  const schedule = normalizeSchedule({
    anchor: { y: 2026, m: 3, d: 8, H: 14, M: 30, S: 0 },
    timezone: 'Asia/Shanghai',
    frequency: 'once',
  });
  assert.equal(scheduleAt(schedule, 0), schedule.anchor);
  assert.throws(() => scheduleAt(schedule, 1), throwsCode('schedule_out_of_range'));
  assert.deepEqual(firstAtOrAfter(schedule, schedule.anchor - 1), { sequence: 0, at: schedule.anchor });
  assert.equal(firstAtOrAfter(schedule, schedule.anchor + 1), null);
});

test('firstAtOrAfter 用闭式估算处理大跨度', () => {
  const schedule = normalizeSchedule({
    anchor: { y: 1970, m: 1, d: 1, H: 9, M: 0, S: 0 },
    timezone: 'UTC',
    frequency: 'daily',
  });
  const instant = Date.UTC(2400, 5, 15, 0, 0, 0);
  const found = firstAtOrAfter(schedule, instant);
  assert.ok(found);
  // 期望期次由测试端算出的估算公式给出，说明实现没有线性扫描
  const instantWall = utcToWall('UTC', instant);
  const estimate = Math.floor(
    (Date.UTC(instantWall.y, instantWall.m - 1, instantWall.d) - Date.UTC(1970, 0, 1)) / 86400000,
  );
  assert.ok(estimate > 150000);
  assert.equal(found.sequence, estimate);
  assert.ok(found.at >= instant);
  assert.ok(scheduleAt(schedule, found.sequence) >= instant);
  assert.ok(scheduleAt(schedule, found.sequence - 1) < instant);
});

test('firstAtOrAfter 不早于 minimumSequence', () => {
  const schedule = normalizeSchedule({
    anchor: { y: 2026, m: 1, d: 1, H: 9, M: 0, S: 0 },
    timezone: 'UTC',
    frequency: 'daily',
  });
  const instant = Date.UTC(2026, 0, 5, 0, 0, 0);
  const found = firstAtOrAfter(schedule, instant, 100);
  assert.equal(found.sequence, 100);
  assert.equal(found.at, Date.UTC(2026, 3, 11, 9, 0, 0));

  // 估算值大于 minimumSequence 时仍然按估算值前进
  const later = firstAtOrAfter(schedule, instant, 2);
  assert.equal(later.sequence, 4);
});

test('occurrences 裁剪窗口并保留进行中的日程', () => {
  const schedule = normalizeSchedule({
    anchor: { y: 2026, m: 1, d: 1, H: 0, M: 0, S: 0 },
    timezone: 'UTC',
    frequency: 'daily',
  });

  // 1 月 1 日那期 00:00-02:00，窗口从 01:00 开始，仍在进行中
  const items = occurrences(schedule, {
    from: Date.UTC(2026, 0, 1, 1, 0, 0),
    to: Date.UTC(2026, 0, 3, 0, 0, 0),
    durationMs: 2 * 3600000,
  });
  assert.deepEqual(items.map((item) => item.sequence), [0, 1]);
  assert.deepEqual(items[0], {
    sequence: 0,
    start: Date.UTC(2026, 0, 1, 0, 0, 0),
    end: Date.UTC(2026, 0, 1, 2, 0, 0),
  });

  // end 正好等于 from 的条目被过滤掉
  const trimmed = occurrences(schedule, {
    from: Date.UTC(2026, 0, 2, 1, 0, 0),
    to: Date.UTC(2026, 0, 3, 12, 0, 0),
    durationMs: 3600000,
  });
  assert.deepEqual(trimmed.map((item) => item.sequence), [2]);

  // max 截断
  const limited = occurrences(schedule, {
    from: Date.UTC(2026, 0, 1, 0, 0, 0),
    to: Date.UTC(2026, 0, 10, 0, 0, 0),
    durationMs: 3600000,
    max: 3,
  });
  assert.equal(limited.length, 3);
  assert.deepEqual(limited.map((item) => item.sequence), [0, 1, 2]);

  // 窗口与时长校验
  assert.throws(
    () => occurrences(schedule, {
      from: Date.UTC(2026, 0, 1, 0, 0, 0),
      to: Date.UTC(2026, 1, 2, 0, 0, 0),
      durationMs: 3600000,
    }),
    throwsCode('invalid_window'),
  );
  assert.throws(
    () => occurrences(schedule, { from: Date.UTC(2026, 0, 2), to: Date.UTC(2026, 0, 1), durationMs: 3600000 }),
    throwsCode('invalid_window'),
  );
  assert.throws(
    () => occurrences(schedule, { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 2), durationMs: 0 }),
    throwsCode('invalid_duration'),
  );
  assert.throws(
    () => occurrences(schedule, { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 2), durationMs: 86400001 }),
    throwsCode('invalid_duration'),
  );
});

test('occurrences 在 count 用尽后停止', () => {
  const schedule = normalizeSchedule({
    anchor: { y: 2026, m: 1, d: 1, H: 0, M: 0, S: 0 },
    timezone: 'UTC',
    frequency: 'daily',
    count: 3,
  });
  const items = occurrences(schedule, {
    from: Date.UTC(2025, 11, 28, 0, 0, 0),
    to: Date.UTC(2026, 0, 10, 0, 0, 0),
    durationMs: 3600000,
  });
  assert.deepEqual(items.map((item) => item.sequence), [0, 1, 2]);
});

test('normalizeSchedule 的校验矩阵', () => {
  const base = { anchor: { y: 2026, m: 1, d: 1, H: 9, M: 0, S: 0 }, timezone: 'UTC', frequency: 'daily' };
  assert.throws(() => normalizeSchedule({ ...base, frequency: 'hourly' }), throwsCode('invalid_frequency'));
  assert.throws(() => normalizeSchedule({ ...base, interval: 0 }), throwsCode('invalid_interval'));
  assert.throws(() => normalizeSchedule({ ...base, interval: 1.5 }), throwsCode('invalid_interval'));
  assert.throws(() => normalizeSchedule({ ...base, interval: 1001 }), throwsCode('invalid_interval'));
  assert.throws(() => normalizeSchedule({ ...base, count: 0 }), throwsCode('invalid_count'));
  assert.throws(() => normalizeSchedule({ ...base, count: 1.5 }), throwsCode('invalid_count'));
  assert.throws(() => normalizeSchedule({ ...base, count: 10001 }), throwsCode('invalid_count'));
  assert.throws(() => normalizeSchedule({ ...base, timezone: 'Mars/Olympus' }), throwsCode('invalid_timezone'));
  assert.throws(() => normalizeSchedule({ ...base, gapPolicy: 'keep' }), throwsCode('invalid_gap_policy'));
  assert.throws(() => normalizeSchedule({ ...base, fold: 2 }), throwsCode('invalid_fold'));
  assert.throws(() => normalizeSchedule({ ...base, anchor: undefined }), throwsCode('invalid_anchor'));
  assert.throws(() => normalizeSchedule({ ...base, anchor: 'not-a-date' }), throwsCode('invalid_anchor'));
  assert.throws(() => normalizeSchedule({ ...base, interval: -1 }), throwsCode('invalid_interval'));
});

test('fold: 1 只允许一次性日程或真正重复的墙钟', () => {
  assert.throws(
    () => normalizeSchedule({
      anchor: { y: 2026, m: 6, d: 1, H: 9, M: 0, S: 0 },
      timezone: 'Asia/Shanghai',
      frequency: 'daily',
      fold: 1,
    }),
    throwsCode('invalid_fold'),
  );
  // 一次性日程允许 fold: 1
  const once = normalizeSchedule({
    anchor: { y: 2026, m: 6, d: 1, H: 9, M: 0, S: 0 },
    timezone: 'Asia/Shanghai',
    frequency: 'once',
    fold: 1,
  });
  assert.equal(once.fold, 1);
  // 折叠中的墙钟允许 fold: 1，并取第二个候选
  const folded = normalizeSchedule({
    anchor: { y: 2026, m: 11, d: 1, H: 1, M: 30, S: 0 },
    timezone: 'America/New_York',
    frequency: 'daily',
    fold: 1,
  });
  assert.equal(folded.anchor, Date.UTC(2026, 10, 1, 6, 30, 0));
  assert.equal(scheduleAt(folded, 0), Date.UTC(2026, 10, 1, 6, 30, 0));
});

test('scheduleToJson / scheduleFromJson 往返一致', () => {
  const schedule = normalizeSchedule({
    anchor: { y: 2026, m: 3, d: 8, H: 14, M: 30, S: 0 },
    timezone: 'Asia/Shanghai',
    frequency: 'monthly',
    interval: 2,
    count: 5,
    gapPolicy: 'shift_forward',
  });
  const json = scheduleToJson(schedule);
  assert.deepEqual(Object.keys(json).sort(), [
    'anchor',
    'anchorWall',
    'count',
    'fold',
    'frequency',
    'gapPolicy',
    'interval',
    'timezone',
  ]);
  const restored = scheduleFromJson(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(restored, schedule);
  assert.equal(scheduleAt(restored, 3), scheduleAt(schedule, 3));

  const infinite = normalizeSchedule({
    anchor: { y: 2026, m: 1, d: 5, H: 8, M: 0, S: 0 },
    timezone: 'Europe/London',
    frequency: 'weekly',
  });
  assert.equal(infinite.count, null);
  const roundTrip = scheduleFromJson(JSON.parse(JSON.stringify(scheduleToJson(infinite))));
  assert.deepEqual(roundTrip, infinite);
  assert.equal(roundTrip.count, null);
});

test('describeSchedule 输出中文描述', () => {
  const once = normalizeSchedule({
    anchor: { y: 2026, m: 3, d: 8, H: 14, M: 30, S: 0 },
    timezone: 'Asia/Shanghai',
    frequency: 'once',
  });
  assert.equal(describeSchedule(once), '2026-03-08 14:30（一次性）');

  const daily = normalizeSchedule({
    anchor: { y: 2026, m: 3, d: 8, H: 7, M: 30, S: 0 },
    timezone: 'Asia/Shanghai',
    frequency: 'daily',
  });
  assert.equal(describeSchedule(daily), '每天 07:30');

  const everyTwoDays = normalizeSchedule({
    anchor: { y: 2026, m: 3, d: 8, H: 7, M: 30, S: 0 },
    timezone: 'Asia/Shanghai',
    frequency: 'daily',
    interval: 2,
  });
  assert.equal(describeSchedule(everyTwoDays), '每 2 天 07:30');

  const weekly = normalizeSchedule({
    anchor: { y: 2026, m: 1, d: 7, H: 14, M: 30, S: 0 },
    timezone: 'Asia/Shanghai',
    frequency: 'weekly',
    count: 8,
  });
  assert.equal(describeSchedule(weekly), '每周三 14:30，共 8 次');

  const monthly = normalizeSchedule({
    anchor: { y: 2026, m: 1, d: 8, H: 9, M: 0, S: 0 },
    timezone: 'Asia/Shanghai',
    frequency: 'monthly',
  });
  assert.equal(describeSchedule(monthly), '每月 8 日 09:00');

  const yearly = normalizeSchedule({
    anchor: { y: 2026, m: 3, d: 8, H: 9, M: 0, S: 0 },
    timezone: 'Asia/Shanghai',
    frequency: 'yearly',
  });
  assert.equal(describeSchedule(yearly), '每年 3 月 8 日 09:00');

  const shifted = normalizeSchedule({
    anchor: { y: 2026, m: 3, d: 8, H: 9, M: 0, S: 0 },
    timezone: 'America/New_York',
    frequency: 'daily',
    gapPolicy: 'shift_forward',
  });
  assert.equal(describeSchedule(shifted), '每天 09:00（夏令时跳变顺延）');
});

test('毫秒锚点被截到整秒：五个频率都满足 scheduleAt(s, 0) === s.anchor', () => {
  const anchorMs = Date.UTC(2026, 0, 15, 9, 0, 0) + 750;
  for (const frequency of FREQUENCIES) {
    const schedule = normalizeSchedule({ anchor: anchorMs, timezone: 'Asia/Shanghai', frequency });
    // 上海 UTC+8：09:00:00.750Z 的墙钟是 17:00:00，毫秒零头不进 anchorWall
    assert.deepEqual(schedule.anchorWall, { y: 2026, m: 1, d: 15, H: 17, M: 0, S: 0 }, `${frequency} anchorWall`);
    assert.equal(schedule.anchor, Date.UTC(2026, 0, 15, 9, 0, 0), `${frequency} anchor 截到整秒`);
    assert.equal(scheduleAt(schedule, 0), schedule.anchor, `${frequency} 第 0 期等于 anchor`);
    const restored = scheduleFromJson(JSON.parse(JSON.stringify(scheduleToJson(schedule))));
    assert.deepEqual(restored, schedule, `${frequency} JSON 往返幂等`);
  }

  // Date / 带毫秒的 ISO 串走同一条不变量
  for (const anchor of [new Date(anchorMs), new Date(anchorMs).toISOString()]) {
    const schedule = normalizeSchedule({ anchor, timezone: 'Europe/London', frequency: 'weekly' });
    assert.equal(schedule.anchor, Date.UTC(2026, 0, 15, 9, 0, 0));
    assert.equal(scheduleAt(schedule, 0), schedule.anchor);
  }

  // 折叠时刻从绝对锚点进入时按 fold 取候选，往返仍然幂等
  const folded = normalizeSchedule({
    anchor: Date.UTC(2026, 10, 1, 6, 30, 0),
    timezone: 'America/New_York',
    frequency: 'daily',
    fold: 1,
  });
  assert.equal(folded.anchor, Date.UTC(2026, 10, 1, 6, 30, 0));
  assert.equal(scheduleAt(folded, 0), folded.anchor);
  assert.deepEqual(scheduleFromJson(JSON.parse(JSON.stringify(scheduleToJson(folded)))), folded);
});

test('无时区后缀的 ISO 锚点按目标时区的墙钟解释', () => {
  const zone = 'America/New_York';
  const local = normalizeSchedule({ anchor: '2026-03-08T09:00:00', timezone: zone, frequency: 'daily' });
  assert.deepEqual(local.anchorWall, { y: 2026, m: 3, d: 8, H: 9, M: 0, S: 0 });
  // 纽约当日已进入 EDT（−4），09:00 本地 = 13:00Z
  assert.equal(local.anchor, Date.UTC(2026, 2, 8, 13, 0, 0));

  // 带 Z / ±hh:mm 的写法按绝对时刻解析，结果必须一致
  const utcMarked = normalizeSchedule({ anchor: '2026-03-08T13:00:00Z', timezone: zone, frequency: 'daily' });
  assert.equal(utcMarked.anchor, local.anchor);
  assert.deepEqual(utcMarked.anchorWall, local.anchorWall);
  const offsetMarked = normalizeSchedule({ anchor: '2026-03-08T21:00:00+08:00', timezone: zone, frequency: 'daily' });
  assert.equal(offsetMarked.anchor, local.anchor);

  // 只有日期时按目标时区当日 00:00（此刻还是 EST −5）
  const dateOnly = normalizeSchedule({ anchor: '2026-03-08', timezone: zone, frequency: 'daily' });
  assert.deepEqual(dateOnly.anchorWall, { y: 2026, m: 3, d: 8, H: 0, M: 0, S: 0 });
  assert.equal(dateOnly.anchor, Date.UTC(2026, 2, 8, 5, 0, 0));

  // 无后缀串落进 DST 空洞时仍按 gapPolicy 处理
  assert.throws(
    () => normalizeSchedule({ anchor: '2026-03-08T02:30:00', timezone: zone, frequency: 'once' }),
    throwsCode('schedule_needs_resolution'),
  );
  const shifted = normalizeSchedule({
    anchor: '2026-03-08T02:30:00',
    timezone: zone,
    frequency: 'once',
    gapPolicy: 'shift_forward',
  });
  assert.equal(shifted.anchor, Date.UTC(2026, 2, 8, 7, 30, 0));

  // 字段本身不成立的串仍按 invalid_anchor 上报
  assert.throws(
    () => normalizeSchedule({ anchor: '2026-02-30', timezone: zone, frequency: 'daily' }),
    throwsCode('invalid_anchor'),
  );
});

test('越界期次收敛成 schedule_out_of_range，occurrences 在年份边界截断收尾', () => {
  const daily = normalizeSchedule({
    anchor: { y: 2026, m: 1, d: 15, H: 9, M: 0, S: 0 },
    timezone: 'UTC',
    frequency: 'daily',
  });
  assert.throws(() => scheduleAt(daily, 2 ** 40), throwsCode('schedule_out_of_range'));

  const monthly = normalizeSchedule({
    anchor: { y: 2026, m: 1, d: 15, H: 9, M: 0, S: 0 },
    timezone: 'UTC',
    frequency: 'monthly',
  });
  assert.throws(() => scheduleAt(monthly, 200000), throwsCode('schedule_out_of_range'));

  // 窗口末期落进 10000 年：只截断收尾，不让整个窗口抛错
  const tail = normalizeSchedule({
    anchor: { y: 9999, m: 12, d: 25, H: 0, M: 0, S: 0 },
    timezone: 'UTC',
    frequency: 'daily',
  });
  const windowEnd = Date.UTC(10000, 0, 4, 0, 0, 0);
  const items = occurrences(tail, {
    from: Date.UTC(9999, 11, 25, 0, 0, 0),
    to: windowEnd,
    durationMs: 3600000,
  });
  assert.deepEqual(items.map((item) => item.sequence), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(items.every((item) => item.start < windowEnd));

  // firstAtOrAfter 越过可表示年份时返回 null 而不是抛错
  assert.equal(firstAtOrAfter(tail, Date.UTC(10000, 0, 5, 0, 0, 0)), null);
});

test('重复日程撞上 DST 空洞：不存在的那一期按跳过处理', () => {
  // 锚点本身合法（3 月 6 日 02:30 不在空洞里），3 月 8 日那一期落进空洞
  const schedule = normalizeSchedule({
    anchor: { y: 2026, m: 3, d: 6, H: 2, M: 30, S: 0 },
    timezone: 'America/New_York',
    frequency: 'daily',
  });
  // 单期查询保持原语义：该期确实无法解析
  assert.throws(() => scheduleAt(schedule, 2), throwsCode('schedule_needs_resolution'));

  // 窗口查询跳过第 2 期，不抛错
  const items = occurrences(schedule, {
    from: Date.UTC(2026, 2, 7, 0, 0, 0),
    to: Date.UTC(2026, 2, 10, 0, 0, 0),
    durationMs: 3600000,
  });
  assert.deepEqual(items.map((item) => item.sequence), [1, 3]);

  const wider = occurrences(schedule, {
    from: Date.UTC(2026, 2, 6, 0, 0, 0),
    to: Date.UTC(2026, 2, 10, 0, 0, 0),
    durationMs: 3600000,
  });
  assert.deepEqual(wider.map((item) => item.sequence), [0, 1, 3]);

  // 越过空洞后落到第 3 期（3 月 9 日 02:30 EDT = 06:30Z）
  const found = firstAtOrAfter(schedule, Date.parse('2026-03-08T00:00:00Z'));
  assert.equal(found.sequence, 3);
  assert.equal(found.at, Date.UTC(2026, 2, 9, 6, 30, 0));
});