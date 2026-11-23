import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TimeError,
  isValidZone,
  parseZone,
  offsetMinutesAt,
  utcToWall,
  wallToUtc,
  wallToUtcResolved,
  localDateKey,
  localWeekday,
  formatLocal,
  daysInMonth,
  addDaysWall,
  addMonthsClamped,
  startOfLocalDay,
} from '../lib/time.mjs';

const throwsCode = (code) => (err) => err instanceof TimeError && err.code === code;

test('offsetMinutesAt 在各时区返回正确的分钟偏移', () => {
  assert.equal(offsetMinutesAt('Asia/Shanghai', Date.UTC(2026, 0, 15, 0, 0, 0)), 480);
  assert.equal(offsetMinutesAt('Asia/Shanghai', Date.UTC(2026, 6, 15, 0, 0, 0)), 480);
  assert.equal(offsetMinutesAt('America/New_York', Date.UTC(2026, 0, 15, 12, 0, 0)), -300);
  assert.equal(offsetMinutesAt('America/New_York', Date.UTC(2026, 6, 15, 12, 0, 0)), -240);
  assert.equal(offsetMinutesAt('Europe/London', Date.UTC(2026, 0, 15, 12, 0, 0)), 0);
  assert.equal(offsetMinutesAt('Europe/London', Date.UTC(2026, 6, 15, 12, 0, 0)), 60);
  // 豪勋爵岛用 30 分钟偏移，夏令时再顺延 30 分钟
  assert.equal(offsetMinutesAt('Australia/Lord_Howe', Date.UTC(2026, 0, 15, 0, 0, 0)), 660);
  assert.equal(offsetMinutesAt('Australia/Lord_Howe', Date.UTC(2026, 6, 15, 0, 0, 0)), 630);
  assert.equal(offsetMinutesAt('Asia/Kathmandu', Date.UTC(2026, 0, 15, 0, 0, 0)), 345);
});

test('wallToUtc / utcToWall 在多时区往返一致', () => {
  const zones = [
    'UTC',
    'Asia/Shanghai',
    'America/New_York',
    'Europe/London',
    'Australia/Lord_Howe',
    'Asia/Kathmandu',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
  ];
  // 固定种子的伪随机，保证测试确定性
  let seed = 20260308;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const instants = [];
  for (let i = 0; i < 24; i += 1) {
    const day = Math.floor(rand() * 4000);
    const hour = Math.floor(rand() * 24);
    const minute = Math.floor(rand() * 60);
    instants.push(Date.UTC(2026, 0, 1) + day * 86400000 + hour * 3600000 + minute * 60000);
  }
  for (const zone of zones) {
    for (const ms of instants) {
      const wall = utcToWall(zone, ms);
      const resolved = wallToUtc(zone, wall);
      const label = `${zone} ${new Date(ms).toISOString()}`;
      assert.equal(resolved.gap, false, `${label} 不应落在空洞里`);
      assert.ok(resolved.candidates.includes(ms), `${label} 应在候选中`);
      if (resolved.candidates.length === 1) assert.equal(resolved.utc, ms, label);
    }
  }
});

test('DST 空洞：纽约 2026-03-08 02:30 不存在', () => {
  const wall = { y: 2026, m: 3, d: 8, H: 2, M: 30, S: 0 };
  const resolved = wallToUtc('America/New_York', wall);
  assert.equal(resolved.gap, true);
  assert.equal(resolved.utc, null);
  assert.deepEqual(resolved.candidates, []);
  assert.throws(() => wallToUtcResolved('America/New_York', wall), throwsCode('schedule_needs_resolution'));
  assert.throws(
    () => wallToUtcResolved('America/New_York', wall, { gapPolicy: 'reject' }),
    throwsCode('schedule_needs_resolution'),
  );
  const shifted = wallToUtcResolved('America/New_York', wall, { gapPolicy: 'shift_forward' });
  assert.equal(shifted, Date.UTC(2026, 2, 8, 7, 30, 0));
  assert.deepEqual(utcToWall('America/New_York', shifted), { y: 2026, m: 3, d: 8, H: 3, M: 30, S: 0 });
});

test('DST 折叠：纽约 2026-11-01 01:30 有两个候选', () => {
  const wall = { y: 2026, m: 11, d: 1, H: 1, M: 30, S: 0 };
  const resolved = wallToUtc('America/New_York', wall);
  assert.equal(resolved.gap, false);
  assert.equal(resolved.candidates.length, 2);
  assert.deepEqual(resolved.candidates, [Date.UTC(2026, 10, 1, 5, 30, 0), Date.UTC(2026, 10, 1, 6, 30, 0)]);
  assert.equal(resolved.utc, Date.UTC(2026, 10, 1, 5, 30, 0));
  assert.equal(wallToUtcResolved('America/New_York', wall, { fold: 0 }), Date.UTC(2026, 10, 1, 5, 30, 0));
  assert.equal(wallToUtcResolved('America/New_York', wall, { fold: 1 }), Date.UTC(2026, 10, 1, 6, 30, 0));
  // 不重复的墙钟只有一个候选
  const plain = wallToUtc('America/New_York', { y: 2026, m: 12, d: 1, H: 12, M: 0, S: 0 });
  assert.equal(plain.candidates.length, 1);
  assert.equal(plain.candidates[0], Date.UTC(2026, 11, 1, 17, 0, 0));
});

test('addMonthsClamped 月末夹取且不漂移', () => {
  const jan31 = { y: 2026, m: 1, d: 31, H: 9, M: 15, S: 0 };
  assert.deepEqual(addMonthsClamped(jan31, 1), { y: 2026, m: 2, d: 28, H: 9, M: 15, S: 0 });
  assert.deepEqual(addMonthsClamped(jan31, 2), { y: 2026, m: 3, d: 31, H: 9, M: 15, S: 0 });
  assert.deepEqual(
    addMonthsClamped({ y: 2024, m: 2, d: 29, H: 0, M: 0, S: 0 }, 12),
    { y: 2025, m: 2, d: 28, H: 0, M: 0, S: 0 },
  );
  assert.deepEqual(
    addMonthsClamped({ y: 2025, m: 12, d: 31, H: 0, M: 0, S: 0 }, 1),
    { y: 2026, m: 1, d: 31, H: 0, M: 0, S: 0 },
  );
  assert.deepEqual(
    addMonthsClamped({ y: 2026, m: 3, d: 31, H: 0, M: 0, S: 0 }, -1),
    { y: 2026, m: 2, d: 28, H: 0, M: 0, S: 0 },
  );
  assert.deepEqual(
    addMonthsClamped({ y: 2026, m: 1, d: 31, H: 0, M: 0, S: 0 }, 14),
    { y: 2027, m: 3, d: 31, H: 0, M: 0, S: 0 },
  );
});

test('addDaysWall 只做日历天数偏移', () => {
  assert.deepEqual(
    addDaysWall({ y: 2026, m: 2, d: 28, H: 9, M: 15, S: 0 }, 1),
    { y: 2026, m: 3, d: 1, H: 9, M: 15, S: 0 },
  );
  assert.deepEqual(
    addDaysWall({ y: 2024, m: 2, d: 28, H: 0, M: 0, S: 0 }, 1),
    { y: 2024, m: 2, d: 29, H: 0, M: 0, S: 0 },
  );
  assert.deepEqual(
    addDaysWall({ y: 2026, m: 1, d: 1, H: 0, M: 0, S: 0 }, -1),
    { y: 2025, m: 12, d: 31, H: 0, M: 0, S: 0 },
  );
});

test('daysInMonth 处理闰年与世纪闰年', () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(1900, 2), 28);
  assert.equal(daysInMonth(2026, 4), 30);
  assert.equal(daysInMonth(2026, 12), 31);
});

test('localDateKey 与 startOfLocalDay 按目标时区的本地日期计算', () => {
  // 上海本地 2026-03-09 04:30
  const shanghai = Date.UTC(2026, 2, 8, 20, 30, 0);
  assert.equal(localDateKey('Asia/Shanghai', shanghai), '2026-03-09');
  assert.equal(startOfLocalDay('Asia/Shanghai', shanghai), Date.UTC(2026, 2, 8, 16, 0, 0));
  assert.equal(localWeekday('Asia/Shanghai', shanghai), 1);

  // 基里巴斯 UTC+14，本地 2026-03-09 02:00
  const kiritimati = Date.UTC(2026, 2, 8, 12, 0, 0);
  assert.equal(localDateKey('Pacific/Kiritimati', kiritimati), '2026-03-09');
  assert.equal(startOfLocalDay('Pacific/Kiritimati', kiritimati), Date.UTC(2026, 2, 8, 10, 0, 0));

  // 帕果帕果 UTC-11，本地 2026-03-08 01:00
  const pago = Date.UTC(2026, 2, 8, 12, 0, 0);
  assert.equal(localDateKey('Pacific/Pago_Pago', pago), '2026-03-08');
  assert.equal(startOfLocalDay('Pacific/Pago_Pago', pago), Date.UTC(2026, 2, 8, 11, 0, 0));
  assert.equal(localWeekday('Pacific/Pago_Pago', pago), 0);
});

test('formatLocal 输出稳定可断言的中文格式', () => {
  // 上海本地 2026-03-08 14:30，周日
  const ms = Date.UTC(2026, 2, 8, 6, 30, 0);
  assert.equal(formatLocal('Asia/Shanghai', ms), '2026-03-08 星期日 14:30');
  assert.equal(formatLocal('Asia/Shanghai', ms, {}), '2026-03-08 星期日 14:30');
  assert.equal(formatLocal('Asia/Shanghai', ms, { weekday: false }), '2026-03-08 14:30');
  assert.equal(formatLocal('Asia/Shanghai', ms, { date: false, weekday: false }), '14:30');
  assert.equal(formatLocal('Asia/Shanghai', ms, { time: false }), '2026-03-08 星期日');
});

test('非法时区与非法墙钟抛 TimeError', () => {
  assert.equal(isValidZone('UTC'), true);
  assert.equal(isValidZone('Asia/Shanghai'), true);
  assert.equal(isValidZone('Mars/Olympus'), false);
  assert.equal(isValidZone(''), false);
  assert.equal(isValidZone(undefined), false);

  assert.throws(() => parseZone('Mars/Olympus'), throwsCode('invalid_timezone'));
  assert.throws(() => offsetMinutesAt('Mars/Olympus', 0), throwsCode('invalid_timezone'));

  assert.throws(
    () => wallToUtc('UTC', { y: 2026, m: 13, d: 1, H: 0, M: 0, S: 0 }),
    throwsCode('invalid_wall_clock'),
  );
  assert.throws(
    () => wallToUtc('UTC', { y: 2026, m: 1, d: 1, H: 24, M: 0, S: 0 }),
    throwsCode('invalid_wall_clock'),
  );
  assert.throws(
    () => wallToUtc('UTC', { y: 2026, m: 2, d: 30, H: 0, M: 0, S: 0 }),
    throwsCode('invalid_wall_clock'),
  );
  assert.throws(() => wallToUtcResolved('UTC', { y: 2026, m: 1, d: 1, H: 0, M: 0, S: 0 }, { fold: 2 }), throwsCode('invalid_wall_clock'));
  assert.throws(() => utcToWall('UTC', Number.NaN), throwsCode('invalid_wall_clock'));
});

test('越界时间戳抛 TimeError，不泄漏原生 RangeError', () => {
  // Date 能表示的上限是 ±8.64e15，超出后原生 Date / Intl 会抛无 code 的 RangeError
  for (const ms of [8.64e15 + 1, 9e15, -9e15, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => offsetMinutesAt('Asia/Shanghai', ms), throwsCode('invalid_wall_clock'), `offsetMinutesAt ${ms}`);
    assert.throws(() => utcToWall('Asia/Shanghai', ms), throwsCode('invalid_wall_clock'), `utcToWall ${ms}`);
    assert.throws(() => localDateKey('Asia/Shanghai', ms), throwsCode('invalid_wall_clock'), `localDateKey ${ms}`);
  }
  assert.throws(() => utcToWall('Asia/Shanghai', new Date(Number.NaN)), throwsCode('invalid_wall_clock'));
  assert.throws(() => offsetMinutesAt('Asia/Shanghai', '1768467600750'), throwsCode('invalid_wall_clock'));

  // 边界内仍可用：9999-12-31 这种远端时刻不受影响
  const tail = Date.UTC(9999, 11, 31, 12, 0, 0);
  assert.equal(offsetMinutesAt('UTC', tail), 0);
  assert.deepEqual(utcToWall('UTC', tail), { y: 9999, m: 12, d: 31, H: 12, M: 0, S: 0 });
  assert.deepEqual(utcToWall('Asia/Shanghai', tail), { y: 9999, m: 12, d: 31, H: 20, M: 0, S: 0 });
});