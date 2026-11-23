// 时间与时区工具：在 UTC 毫秒与指定 IANA 时区的墙钟时间之间转换。
// 只使用内置 Intl / Date，不依赖 Temporal。

const FORMATTERS = new Map();
const ZONE_OK = new Map();
const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Date 能表示的时间戳上限（±8.64e15 毫秒），超出的值原生 API 会抛无 code 的 RangeError。
const MAX_INSTANT_MS = 8.64e15;

export class TimeError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'TimeError';
    this.code = code;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad4(n) {
  return String(n).padStart(4, '0');
}

// Date.UTC 会把 0-99 的年份映射到 1900+，这里还原成真实年份。
function makeUtc(y, m, d, H, M, S) {
  const t = Date.UTC(y, m - 1, d, H, M, S);
  if (y >= 0 && y < 100) {
    const dt = new Date(t);
    dt.setUTCFullYear(y);
    return dt.getTime();
  }
  return t;
}

// 把「被当作墙钟数值使用」的毫秒读数拆成墙钟对象。
function wallFromNaive(naiveMs) {
  const dt = new Date(naiveMs);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    H: dt.getUTCHours(),
    M: dt.getUTCMinutes(),
    S: dt.getUTCSeconds(),
  };
}

function formatterFor(zone) {
  let formatter = FORMATTERS.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(zone, formatter);
  }
  return formatter;
}

function instantOf(value) {
  const ms = value instanceof Date ? value.getTime() : value;
  // 越界值交给原生 Date / Intl 会抛没有 code 的 RangeError，这里统一收敛成 TimeError。
  if (typeof ms !== 'number' || !Number.isFinite(ms) || Math.abs(ms) > MAX_INSTANT_MS) {
    throw new TimeError('invalid_wall_clock', `无效的时间戳：${String(ms)}`);
  }
  return ms;
}

export function isValidZone(name) {
  if (typeof name !== 'string' || name.trim() === '') return false;
  const cached = ZONE_OK.get(name);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    formatterFor(name);
  } catch {
    ok = false;
  }
  ZONE_OK.set(name, ok);
  return ok;
}

export function parseZone(name) {
  if (!isValidZone(name)) {
    throw new TimeError('invalid_timezone', `无法识别的时区：${String(name)}`);
  }
  return name;
}

export function offsetMinutesAt(zone, utcMs) {
  const z = parseZone(zone);
  const ms = instantOf(utcMs);
  const parts = Object.create(null);
  for (const part of formatterFor(z).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const y = Number(parts.year);
  const m = Number(parts.month);
  let d = Number(parts.day);
  let H = Number(parts.hour);
  const M = Number(parts.minute);
  const S = Number(parts.second);
  if (H === 24) {
    // 部分 locale 会把午夜表示成 24:00:00
    H = 0;
    d += 1;
  }
  const naive = makeUtc(y, m, d, H, M, S);
  const truncated = Math.floor(ms / 1000) * 1000;
  return Math.round((naive - truncated) / 60000);
}

export function utcToWall(zone, utcMs) {
  const z = parseZone(zone);
  const ms = instantOf(utcMs);
  return wallFromNaive(ms + offsetMinutesAt(z, ms) * 60000);
}

function checkWall(wall) {
  const bad = (field, value) => new TimeError('invalid_wall_clock', `非法墙钟字段 ${field}=${String(value)}`);
  if (!wall || typeof wall !== 'object') {
    throw new TimeError('invalid_wall_clock', '墙钟必须是 { y, m, d, H, M, S } 对象');
  }
  const y = wall.y;
  const m = wall.m;
  const d = wall.d;
  const H = wall.H ?? 0;
  const M = wall.M ?? 0;
  const S = wall.S ?? 0;
  if (!Number.isInteger(y) || y < 1 || y > 9999) throw bad('y', y);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw bad('m', m);
  if (!Number.isInteger(d) || d < 1 || d > daysInMonth(y, m)) throw bad('d', d);
  if (!Number.isInteger(H) || H < 0 || H > 23) throw bad('H', H);
  if (!Number.isInteger(M) || M < 0 || M > 59) throw bad('M', M);
  if (!Number.isInteger(S) || S < 0 || S > 59) throw bad('S', S);
  return { y, m, d, H, M, S };
}

export function wallToUtc(zone, wall) {
  const z = parseZone(zone);
  const w = checkWall(wall);
  const naive = makeUtc(w.y, w.m, w.d, w.H, w.M, w.S);
  const before = offsetMinutesAt(z, naive - 86400000);
  const after = offsetMinutesAt(z, naive + 86400000);
  const seen = new Set();
  const candidates = [];
  for (const candidate of [naive - before * 60000, naive - after * 60000]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    // 复查：用该候选自身的偏移反推，必须回到同一个时刻
    if (naive - offsetMinutesAt(z, candidate) * 60000 === candidate) candidates.push(candidate);
  }
  candidates.sort((a, b) => a - b);
  if (candidates.length === 0) {
    return { utc: null, fold: 0, gap: true, candidates: [] };
  }
  return { utc: candidates[0], fold: 0, gap: false, candidates };
}

export function wallToUtcResolved(zone, wall, { fold = 0, gapPolicy = 'reject' } = {}) {
  const z = parseZone(zone);
  const w = checkWall(wall);
  const f = fold === true ? 1 : fold === false ? 0 : fold;
  if (f !== 0 && f !== 1) {
    throw new TimeError('invalid_wall_clock', 'fold 只能是 0 或 1');
  }
  const resolved = wallToUtc(z, w);
  if (!resolved.gap) {
    return resolved.candidates[f] ?? resolved.candidates[0];
  }
  const label = `${pad4(w.y)}-${pad2(w.m)}-${pad2(w.d)} ${pad2(w.H)}:${pad2(w.M)}`;
  if (gapPolicy !== 'shift_forward') {
    throw new TimeError('schedule_needs_resolution', `${label} 落在夏令时跳变的空洞里，需要显式指定 gapPolicy`);
  }
  // 先按跳变时长顺延（02:30 → 03:30），不可行时再逐分钟找最早有效墙钟
  const naive = makeUtc(w.y, w.m, w.d, w.H, w.M, w.S);
  const gapMs = (offsetMinutesAt(z, naive + 86400000) - offsetMinutesAt(z, naive - 86400000)) * 60000;
  if (gapMs > 0) {
    const shifted = wallToUtc(z, wallFromNaive(naive + gapMs));
    if (!shifted.gap) return shifted.candidates[0];
  }
  for (let step = 1; step <= 240; step += 1) {
    const probe = wallToUtc(z, wallFromNaive(naive + step * 60000));
    if (!probe.gap) return probe.candidates[0];
  }
  throw new TimeError('schedule_out_of_range', `${label} 附近的时区跳变无法解析`);
}

export function localDateKey(zone, utcMs) {
  const wall = utcToWall(zone, utcMs);
  return `${pad4(wall.y)}-${pad2(wall.m)}-${pad2(wall.d)}`;
}

function weekdayOfWall(wall) {
  return new Date(makeUtc(wall.y, wall.m, wall.d, 0, 0, 0)).getUTCDay();
}

export function localWeekday(zone, utcMs) {
  return weekdayOfWall(utcToWall(zone, utcMs));
}

export function formatLocal(zone, utcMs, opts = {}) {
  const options = { date: true, time: true, weekday: true, ...opts };
  const wall = utcToWall(zone, utcMs);
  const chunks = [];
  if (options.date) chunks.push(`${pad4(wall.y)}-${pad2(wall.m)}-${pad2(wall.d)}`);
  if (options.weekday) chunks.push(WEEKDAY_NAMES[weekdayOfWall(wall)]);
  if (options.time) chunks.push(`${pad2(wall.H)}:${pad2(wall.M)}`);
  return chunks.join(' ');
}

export function daysInMonth(y, m) {
  const month = Number(m);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new TimeError('invalid_wall_clock', `非法月份：${String(m)}`);
  }
  if (month !== 2) return MONTH_DAYS[month - 1];
  const year = Number(y);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 29 : 28;
}

export function addDaysWall(wall, days) {
  const w = checkWall(wall);
  if (!Number.isInteger(days)) {
    throw new TimeError('invalid_wall_clock', '天数必须是整数');
  }
  const base = makeUtc(w.y, w.m, w.d, 0, 0, 0);
  const shifted = wallFromNaive(base + days * 86400000);
  return { y: shifted.y, m: shifted.m, d: shifted.d, H: w.H, M: w.M, S: w.S };
}

export function addMonthsClamped(wall, months) {
  const w = checkWall(wall);
  if (!Number.isInteger(months)) {
    throw new TimeError('invalid_wall_clock', '月数必须是整数');
  }
  const total = w.y * 12 + (w.m - 1) + months;
  const y2 = Math.floor(total / 12);
  const m2 = (((total % 12) + 12) % 12) + 1;
  const d2 = Math.min(w.d, daysInMonth(y2, m2));
  return { y: y2, m: m2, d: d2, H: w.H, M: w.M, S: w.S };
}

export function startOfLocalDay(zone, utcMs) {
  const wall = utcToWall(zone, utcMs);
  return wallToUtcResolved(zone, { ...wall, H: 0, M: 0, S: 0 }, { gapPolicy: 'shift_forward' });
}