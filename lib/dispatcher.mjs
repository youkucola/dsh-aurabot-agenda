// 提醒调度器：定时扫描到期期次，先认领再发送，单条失败不影响整批。

import { formatLocal, isValidZone } from './time.mjs';

export const DEFAULTS = {
  latenessSeconds: 300,
  scanSize: 16,
  intervalSeconds: 30,
};

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

function pickZone(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    if (isValidZone(candidate)) return candidate;
  }
  return 'UTC';
}

// 形如「[日程提醒] 14:30 开会（周会）」。
export function formatReminderText(item, { zone } = {}) {
  const dueMs = Date.parse(item?.dueAt ?? '');
  if (!Number.isFinite(dueMs)) {
    throw new TypeError('formatReminderText 需要有效的 dueAt');
  }
  // due_at 是提醒时刻（已按 leadMinutes 提前），文案要展示日程本身的时间。
  const leadMinutes = Number(item?.leadMinutes);
  const leadMs = Number.isFinite(leadMinutes) && leadMinutes > 0 ? leadMinutes * 60000 : 0;
  const shifted = dueMs + leadMs;
  const scheduleMs = Math.abs(shifted) <= 8.64e15 ? shifted : dueMs;
  const timezone = pickZone(zone, item?.timezone);
  const time = formatLocal(timezone, scheduleMs, { date: false, weekday: false, time: true });
  const message = typeof item?.message === 'string' ? item.message.trim() : '';
  const title = typeof item?.eventTitle === 'string' ? item.eventTitle.trim() : '';
  let subject;
  if (message !== '' && title !== '' && title !== message) subject = `${message}（${title}）`;
  else if (message !== '') subject = message;
  else if (title !== '') subject = title;
  else subject = '日程提醒';
  return `[日程提醒] ${time} ${subject}`;
}

export function createDispatcher({ api, service, readSettings, resolveChatId } = {}) {
  if (!api || !service) throw new TypeError('createDispatcher 需要 api 与 service');
  let off = null;

  function settingsSync() {
    try {
      const value = readSettings?.();
      return value && typeof value === 'object' && typeof value.then !== 'function' ? value : {};
    } catch {
      return {};
    }
  }

  async function settingsAsync() {
    try {
      const value = await readSettings?.();
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  async function tick({ now } = {}) {
    const counts = { sent: 0, skipped: 0, failed: 0 };
    const at = Number.isFinite(now) ? Number(now) : Date.now();
    try {
      // 设置每轮都重新读，面板改完立刻生效。
      const cfg = await settingsAsync();
      if (cfg.enabled === false) return { skipped: 'disabled' };
      const latenessSeconds = finiteNumber(cfg.latenessSeconds, DEFAULTS.latenessSeconds);
      const scanSize = Math.min(positiveInteger(cfg.scanSize, DEFAULTS.scanSize), 100);

      let page;
      try {
        page = await service.dueReminders({ now: at, limit: scanSize });
      } catch (err) {
        return { ...counts, error: String(err?.message ?? err) };
      }
      const items = Array.isArray(page?.items) ? page.items : [];

      const rollForward = async (item) => {
        try {
          await service.nextOccurrenceAfter(item.reminderId, { afterSequence: item.sequence, now: at });
        } catch {
          // 补偿下一期失败不阻塞本批
        }
      };

      for (const item of items) {
        let counted = false;
        try {
          const dueMs = Date.parse(item.dueAt);
          if (Number.isFinite(dueMs) && at - dueMs > latenessSeconds * 1000) {
            await service.markDispatch(item.occurrenceId, { state: 'skipped', reason: 'late' }, { now: at });
            await rollForward(item);
            counts.skipped += 1;
            counted = true;
            continue;
          }

          const claim = await service.claimOccurrence(item.occurrenceId, { now: at });
          if (!claim || claim.claimed !== true) continue;

          const chatId = await resolveChatId?.(item);
          if (!chatId) {
            await service.markDispatch(item.occurrenceId, { state: 'skipped', reason: 'no_target' }, { now: at });
            await rollForward(item);
            counts.skipped += 1;
            counted = true;
            continue;
          }

          try {
            await api.send(chatId, formatReminderText(item, { zone: cfg.timezone ?? item.timezone }));
            await service.markDispatch(item.occurrenceId, { state: 'queued', reason: 'sent' }, { now: at });
            counts.sent += 1;
            counted = true;
          } catch (err) {
            await service.markDispatch(item.occurrenceId, {
              state: 'failed',
              reason: String(err?.message ?? err),
            }, { now: at });
            counts.failed += 1;
            counted = true;
          }
          await rollForward(item);
        } catch {
          if (!counted) counts.failed += 1;
        }
      }
      return counts;
    } catch (err) {
      return { ...counts, error: String(err?.message ?? err) };
    }
  }

  function start() {
    if (off) return stop;
    const cfg = settingsSync();
    const intervalSeconds = finiteNumber(cfg.intervalSeconds, DEFAULTS.intervalSeconds);
    const everyMs = Math.max(1000, Math.round(intervalSeconds * 1000));
    const handle = api.every(everyMs, () => {
      tick().catch(() => {
        // tick 内部已兜底，这里只防意外拒绝
      });
    }, '日程提醒');
    off = typeof handle === 'function' ? handle : () => {};
    return stop;
  }

  function stop() {
    const handle = off;
    off = null;
    if (typeof handle === 'function') {
      try {
        handle();
      } catch {
        // 关闭定时任务失败无需上报
      }
    }
  }

  return { start, stop, tick };
}