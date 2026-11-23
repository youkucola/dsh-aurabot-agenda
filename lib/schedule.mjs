// 重复日程：把锚点墙钟按频率与间隔直接映射到第 N 期，
// 不逐期推进，避免月末夹取与夏令时造成的漂移。

import {
  TimeError,
  isValidZone,
  utcToWall,
  wallToUtc,
  wallToUtcResolved,
  addDaysWall,
  addMonthsClamped,
  localWeekday,
} from './time.mjs';

export const FREQUENCIES = ['once', 'daily', 'weekly', 'monthly', 'yearly'];
export const GAP_POLICIES = ['reject', 'shift_forward'];
export const MAX_OCCURRENCES = 64;
export const MAX_SPAN_MS = 31 * 86400000;

const DAY_MS = 86400000;
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];
const MIN_WALL_YEAR = 1;
const MAX_WALL_YEAR = 9999;
// 无时区后缀的 ISO 串（含只有日期的写法）：按目标时区的墙钟解释。
const WALL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?)?$/;
// firstAtOrAfter 里「不存在的那一期」最多跳过几次，超过就说明不是偶发空洞。
const FIRST_AT_SKIP_LIMIT = 3;
// occurrences 逐期推进时的跳过上限，纯粹是防止持续跳过时空转。
const SCAN_SKIP_LIMIT = 8;

export class ScheduleError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 把 time.mjs 的 TimeError 统一转成 ScheduleError，保留原始 code。
function viaTime(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TimeError) throw new ScheduleError(err.code, err.message);
    throw err;
  }
}

function instantMs(value, code) {
  const ms = value instanceof Date ? value.getTime() : value;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new ScheduleError(code, '时间点必须是 Date 或毫秒数');
  }
  return ms;
}

function assertSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || typeof schedule.timezone !== 'string' || !schedule.anchorWall) {
    throw new ScheduleError('invalid_schedule', '请先通过 normalizeSchedule 规范化日程');
  }
}

function normalizeFold(value) {
  if (value === undefined || value === null || value === 0 || value === false) return 0;
  if (value === 1 || value === true) return 1;
  throw new ScheduleError('invalid_fold', 'fold 只能是 0 或 1');
}

function resolveAnchor(raw, timezone, fold, gapPolicy) {
  if (raw === undefined || raw === null) {
    throw new ScheduleError('invalid_anchor', '缺少 anchor');
  }
  if (raw instanceof Date) {
    const ms = raw.getTime();
    if (!Number.isFinite(ms)) throw new ScheduleError('invalid_anchor', '无效的 Date 锚点');
    return { anchor: ms, anchorWall: utcToWall(timezone, ms) };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new ScheduleError('invalid_anchor', '无效的毫秒锚点');
    return { anchor: raw, anchorWall: utcToWall(timezone, raw) };
  }
  if (typeof raw === 'string') {
    // 带 Z 或 ±hh:mm 的串按绝对时刻解析；不带时区后缀的串按目标时区的墙钟解释，
    // 否则 Date.parse 会用服务器本地时区，跨时区配置会整体偏几个小时。
    const matched = WALL_ISO_RE.exec(raw.trim());
    if (matched === null) {
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) throw new ScheduleError('invalid_anchor', `无法解析锚点时间：${raw}`);
      return { anchor: ms, anchorWall: utcToWall(timezone, ms) };
    }
    // 秒以下的零头在这里被丢掉：墙钟只保留到秒，不会进入 anchor。
    const wall = {
      y: Number(matched[1]),
      m: Number(matched[2]),
      d: Number(matched[3]),
      H: matched[4] === undefined ? 0 : Number(matched[4]),
      M: matched[5] === undefined ? 0 : Number(matched[5]),
      S: matched[6] === undefined ? 0 : Number(matched[6]),
    };
    let anchor;
    try {
      anchor = viaTime(() => wallToUtcResolved(timezone, wall, { fold, gapPolicy }));
    } catch (err) {
      // 字段越界（如 2026-02-30）说明这个串本身不成立，仍按「无法解析锚点」上报。
      if (err instanceof ScheduleError && err.code === 'invalid_wall_clock') {
        throw new ScheduleError('invalid_anchor', `无法解析锚点时间：${raw}`);
      }
      throw err;
    }
    return { anchor, anchorWall: wall };
  }
  if (typeof raw === 'object') {
    if (!Number.isInteger(raw.y) || !Number.isInteger(raw.m) || !Number.isInteger(raw.d)) {
      throw new ScheduleError('invalid_anchor', '墙钟锚点需要整数 y / m / d');
    }
    const wall = { y: raw.y, m: raw.m, d: raw.d, H: raw.H ?? 0, M: raw.M ?? 0, S: raw.S ?? 0 };
    const anchor = viaTime(() => wallToUtcResolved(timezone, wall, { fold, gapPolicy }));
    return { anchor, anchorWall: wall };
  }
  throw new ScheduleError('invalid_anchor', 'anchor 必须是 Date / 毫秒数 / ISO 字符串 / 墙钟对象');
}

export function normalizeSchedule(input) {
  if (!input || typeof input !== 'object') {
    throw new ScheduleError('invalid_schedule', '日程定义必须是对象');
  }
  const timezone = input.timezone;
  if (typeof timezone !== 'string' || !isValidZone(timezone)) {
    throw new ScheduleError('invalid_timezone', `无法识别的时区：${String(timezone)}`);
  }
  const frequency = input.frequency;
  if (!FREQUENCIES.includes(frequency)) {
    throw new ScheduleError('invalid_frequency', `frequency 必须是 ${FREQUENCIES.join(' / ')}`);
  }
  const interval = input.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) {
    throw new ScheduleError('invalid_interval', 'interval 必须是 1..1000 的整数');
  }
  const rawCount = input.count ?? null;
  let count = null;
  if (rawCount !== null) {
    if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 10000) {
      throw new ScheduleError('invalid_count', 'count 必须是 null 或 1..10000 的整数');
    }
    count = rawCount;
  }
  const gapPolicy = input.gapPolicy ?? 'reject';
  if (!GAP_POLICIES.includes(gapPolicy)) {
    throw new ScheduleError('invalid_gap_policy', `gapPolicy 必须是 ${GAP_POLICIES.join(' / ')}`);
  }
  const fold = normalizeFold(input.fold);
  const resolved = resolveAnchor(input.anchor, timezone, fold, gapPolicy);
  const anchorWall = resolved.anchorWall;
  if (fold === 1 && frequency !== 'once' && wallToUtc(timezone, anchorWall).candidates.length < 2) {
    throw new ScheduleError('invalid_fold', 'fold=1 只适用于一次性日程或确实重复的墙钟');
  }
  // 不变量：第 0 期必须等于 anchor。墙钟只到秒，所以统一按 anchorWall 重新解析一次，
  // 让毫秒锚点（以及折叠时刻）与 scheduleAt(schedule, 0) 完全对齐，JSON 往返也就幂等了。
  const anchor = viaTime(() => wallToUtcResolved(timezone, anchorWall, { fold, gapPolicy }));
  return Object.freeze({
    anchor,
    anchorWall: Object.freeze(anchorWall),
    timezone,
    frequency,
    interval,
    count,
    fold,
    gapPolicy,
  });
}

// 把第 sequence 期换算成锚点所在的墙钟（始终基于原始锚点，不累加）。
function periodWall(schedule, sequence) {
  const base = schedule.anchorWall;
  const step = sequence * schedule.interval;
  switch (schedule.frequency) {
    case 'daily':
      return addDaysWall(base, step);
    case 'weekly':
      return addDaysWall(base, step * 7);
    case 'monthly':
      return addMonthsClamped(base, step);
    case 'yearly':
      return addMonthsClamped(base, step * 12);
    default:
      throw new ScheduleError('invalid_frequency', `未知频率：${String(schedule.frequency)}`);
  }
}

// 期次墙钟必须落在可表示的年份里，否则下游会退化成 invalid_wall_clock（甚至 y=NaN）。
function periodWallInRange(schedule, sequence) {
  const wall = periodWall(schedule, sequence);
  if (!Number.isInteger(wall.y) || wall.y < MIN_WALL_YEAR || wall.y > MAX_WALL_YEAR) {
    throw new ScheduleError('schedule_out_of_range', `第 ${sequence} 期超出了可表示的年份范围`);
  }
  return wall;
}

function resolvePeriodWall(schedule, wall) {
  return viaTime(() => wallToUtcResolved(schedule.timezone, wall, {
    fold: schedule.fold,
    gapPolicy: schedule.gapPolicy,
  }));
}

export function scheduleAt(schedule, sequence) {
  assertSchedule(schedule);
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new ScheduleError('invalid_sequence', '期次必须是非负整数');
  }
  if (schedule.count !== null && sequence >= schedule.count) {
    throw new ScheduleError('schedule_out_of_range', `第 ${sequence} 期超出总期数 ${schedule.count}`);
  }
  if (schedule.frequency === 'once') {
    if (sequence !== 0) {
      throw new ScheduleError('schedule_out_of_range', '一次性日程只有第 0 期');
    }
    return schedule.anchor;
  }
  return resolvePeriodWall(schedule, periodWallInRange(schedule, sequence));
}

function wallDayNumber(wall) {
  const t = Date.UTC(wall.y, wall.m - 1, wall.d);
  if (wall.y >= 0 && wall.y < 100) {
    const dt = new Date(t);
    dt.setUTCFullYear(wall.y);
    return dt.getTime() / DAY_MS;
  }
  return t / DAY_MS;
}

// 闭式估算：直接由墙钟差值推断大概在第几期，避免线性扫描。
function estimateSequence(schedule, instantWall) {
  const base = schedule.anchorWall;
  const { interval, frequency } = schedule;
  switch (frequency) {
    case 'daily':
      return Math.floor((wallDayNumber(instantWall) - wallDayNumber(base)) / interval);
    case 'weekly':
      return Math.floor((wallDayNumber(instantWall) - wallDayNumber(base)) / (interval * 7));
    case 'monthly':
      return Math.floor(((instantWall.y * 12 + instantWall.m - 1) - (base.y * 12 + base.m - 1)) / interval);
    case 'yearly':
      return Math.floor(((instantWall.y * 12 + instantWall.m - 1) - (base.y * 12 + base.m - 1)) / (interval * 12));
    default:
      throw new ScheduleError('invalid_frequency', `未知频率：${String(frequency)}`);
  }
}

export function firstAtOrAfter(schedule, instantUtcMs, minimumSequence = 0) {
  assertSchedule(schedule);
  const instant = instantMs(instantUtcMs, 'invalid_instant');
  if (!Number.isInteger(minimumSequence) || minimumSequence < 0) {
    throw new ScheduleError('invalid_sequence', 'minimumSequence 必须是非负整数');
  }
  if (schedule.count !== null && minimumSequence >= schedule.count) return null;
  if (schedule.frequency === 'once') {
    if (minimumSequence > 0) return null;
    const at = scheduleAt(schedule, 0);
    return at >= instant ? { sequence: 0, at } : null;
  }
  const instantWall = utcToWall(schedule.timezone, instant);
  const estimate = estimateSequence(schedule, instantWall);
  let sequence = Math.max(estimate, minimumSequence, 0);
  let corrections = 0;
  let skips = 0;
  // 估算最多偏一期，两次校正足够；不存在的那一期（DST 空洞）额外放行 FIRST_AT_SKIP_LIMIT 次。
  for (;;) {
    if (schedule.count !== null && sequence >= schedule.count) return null;
    let at;
    try {
      at = scheduleAt(schedule, sequence);
    } catch (err) {
      if (err instanceof ScheduleError && err.code === 'schedule_out_of_range') return null;
      // 不存在的那一期按跳过处理：它没有对应时刻，继续向后找。
      if (err instanceof ScheduleError
        && err.code === 'schedule_needs_resolution'
        && skips < FIRST_AT_SKIP_LIMIT) {
        skips += 1;
        sequence += 1;
        continue;
      }
      throw err;
    }
    if (at >= instant) return { sequence, at };
    if (corrections >= 2) return null;
    corrections += 1;
    sequence += 1;
  }
}

export function occurrences(schedule, { from, to, durationMs, max = MAX_OCCURRENCES } = {}) {
  assertSchedule(schedule);
  const startWindow = instantMs(from, 'invalid_window');
  const endWindow = instantMs(to, 'invalid_window');
  const span = endWindow - startWindow;
  if (!(span > 0) || span > MAX_SPAN_MS) {
    throw new ScheduleError('invalid_window', '时间窗口必须满足 0 < to - from <= 31 天');
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 86400000) {
    throw new ScheduleError('invalid_duration', 'durationMs 必须在 (0, 86400000] 内');
  }
  if (!Number.isInteger(max) || max < 1) {
    throw new ScheduleError('invalid_max', 'max 必须是 >= 1 的整数');
  }
  // 搜索起点允许早于窗口起点，以便带上「进行中」的日程
  const first = firstAtOrAfter(schedule, startWindow - durationMs);
  if (!first) return [];
  const items = [];
  let sequence = first.sequence;
  let skips = 0;
  // 先算出这一期的时刻，拿到 start 之后才 push —— 否则跳过的那一期会带着没前进的 start
  // 和已经 +1 的 sequence 再进一轮，把同一条结果重复加进去。
  while (items.length < max) {
    let start;
    try {
      start = scheduleAt(schedule, sequence);
    } catch (err) {
      // 期次用尽 / 越过可表示年份：就地收尾，不抛给调用方。
      if (err instanceof ScheduleError && err.code === 'schedule_out_of_range') break;
      // 不存在的那一期（DST 空洞）按跳过处理：它没有对应时刻，不加进结果，
      // 只把期次 +1 往后找，start 保持未赋值。
      if (err instanceof ScheduleError && err.code === 'schedule_needs_resolution') {
        skips += 1;
        if (skips > SCAN_SKIP_LIMIT) break;
        sequence += 1;
        continue;
      }
      throw err;
    }
    if (!(start < endWindow)) break;
    const end = start + durationMs;
    if (end > startWindow) items.push({ sequence, start, end });
    sequence += 1;
  }
  return items;
}

export function scheduleToJson(schedule) {
  assertSchedule(schedule);
  return {
    anchor: schedule.anchor,
    anchorWall: { ...schedule.anchorWall },
    timezone: schedule.timezone,
    frequency: schedule.frequency,
    interval: schedule.interval,
    count: schedule.count,
    fold: schedule.fold,
    gapPolicy: schedule.gapPolicy,
  };
}

export function scheduleFromJson(json) {
  if (!json || typeof json !== 'object') {
    throw new ScheduleError('invalid_schedule', 'json 必须是对象');
  }
  return normalizeSchedule({
    anchor: json.anchorWall ?? json.anchor,
    timezone: json.timezone,
    frequency: json.frequency,
    interval: json.interval,
    count: json.count ?? null,
    fold: json.fold ?? 0,
    gapPolicy: json.gapPolicy ?? 'reject',
  });
}

export function describeSchedule(schedule) {
  assertSchedule(schedule);
  const { y, m, d, H, M } = schedule.anchorWall;
  const time = `${pad2(H)}:${pad2(M)}`;
  const { frequency, interval } = schedule;
  let text;
  if (frequency === 'once') {
    text = `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)} ${time}（一次性）`;
  } else if (frequency === 'daily') {
    text = interval === 1 ? `每天 ${time}` : `每 ${interval} 天 ${time}`;
  } else if (frequency === 'weekly') {
    const day = WEEKDAY_CN[localWeekday(schedule.timezone, schedule.anchor)];
    text = interval === 1 ? `每周${day} ${time}` : `每 ${interval} 周 星期${day} ${time}`;
  } else if (frequency === 'monthly') {
    text = interval === 1 ? `每月 ${d} 日 ${time}` : `每 ${interval} 个月 ${d} 日 ${time}`;
  } else {
    text = interval === 1 ? `每年 ${m} 月 ${d} 日 ${time}` : `每 ${interval} 年 ${m} 月 ${d} 日 ${time}`;
  }
  if (schedule.count !== null) text += `，共 ${schedule.count} 次`;
  if (schedule.gapPolicy === 'shift_forward') text += '（夏令时跳变顺延）';
  return text;
}