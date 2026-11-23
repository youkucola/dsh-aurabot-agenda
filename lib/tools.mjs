// 给模型用的两个工具：agenda_query 查日程、agenda_command 改日程。
//
// 三条边界（工具描述与实现保持一致）：
// - 日程只是计划，不代表已经发生；工具返回的文字也这么写。
// - 不替主人确认约定：`accept` 一律拒绝，`accepted` 字段也不接受模型改写。
// - ownerOnly 打开时，只有本轮说话的人全是主人才允许改；
//   判断走 api.core.hub.turnSendersAllOwner(sessionId)，sessionId 来自工具构建器的 where。

import { formatLocal, isValidZone } from './time.mjs';
import { KIND_LABELS } from './prompt.mjs';

const KINDS = ['role_plan', 'user_report', 'commitment'];
const ACTIONS = ['create', 'revise', 'cancel', 'exception', 'remind'];
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_SPAN_MS = 31 * DAY_MS;
const QUERY_LIMIT_MIN = 1;
const QUERY_LIMIT_MAX = 20;
const QUERY_LOOKBACK_MS = 30 * MINUTE_MS;
const QUERY_LOOKAHEAD_MS = DAY_MS;

const EMPTY_MESSAGE = '这个时间范围没有日程';
const TRUNCATED_NOTE = '（条目过多已截断）';

function msOf(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function intOf(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function zoneOf(value) {
  return isValidZone(value) ? value : 'UTC';
}

// 工具 schema 用 snake_case（duration_minutes / gap_policy），业务层用 camelCase，
// 这里一次性归一，面板接口也复用同一个函数。
function scheduleInput(schedule) {
  if (!schedule || typeof schedule !== 'object') return schedule;
  const next = { ...schedule };
  if (next.gapPolicy === undefined && next.gap_policy !== undefined) next.gapPolicy = next.gap_policy;
  delete next.gap_policy;
  return next;
}

/**
 * 把工具 / 面板传来的事件字段归一成 service.createEvent 认识的形状。
 * 只挑认识的字段，别的一律丢掉（防止模型顺手塞进 state、revision 之类的内部字段）。
 */
export function normalizeEventData(data) {
  const source = data && typeof data === 'object' ? data : {};
  const out = {};
  if (source.kind !== undefined) out.kind = source.kind;
  if (source.title !== undefined) out.title = source.title;
  if (source.detail !== undefined) out.detail = source.detail;
  if (source.presence !== undefined) out.presence = source.presence;
  const duration = source.durationMinutes ?? source.duration_minutes;
  if (duration !== undefined) out.durationMinutes = duration;
  if (source.accepted !== undefined) out.accepted = source.accepted;
  if (source.creatorKind !== undefined) out.creatorKind = source.creatorKind;
  if (source.schedule !== undefined) out.schedule = scheduleInput(source.schedule);
  return out;
}

function renderRows(items, zone, truncated) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return EMPTY_MESSAGE;
  const lines = [];
  for (const item of list) {
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!Number.isFinite(start)) continue;
    let head;
    try {
      head = formatLocal(zone, start, { weekday: false, time: true });
      if (Number.isFinite(end)) {
        head += `-${formatLocal(zone, end, { date: false, weekday: false, time: true })}`;
      }
    } catch {
      continue;
    }
    const flags = [KIND_LABELS[item?.kind] ?? '安排'];
    if (item?.accepted === false) flags.push('待确认');
    lines.push(`${head} ${String(item?.title ?? '')}（${flags.join('，')}）`.trim());
  }
  if (lines.length === 0) return EMPTY_MESSAGE;
  return truncated === true ? `${lines.join('\n')}\n${TRUNCATED_NOTE}` : lines.join('\n');
}

/**
 * 主人在不在场：true 放行、false 拒绝、null 表示读不到（退化为不限制）。
 * 只认「本轮说话的人全是主人」——turnHasOwner 会在主人和群友同轮时被借权。
 */
function ownerPresence(api, sessionId) {
  const hub = api?.core?.hub;
  if (!hub || typeof hub.turnSendersAllOwner !== 'function') return null;
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return null;
  try {
    return hub.turnSendersAllOwner(id) === true;
  } catch {
    return null;
  }
}

function confirmationError() {
  const error = new Error('约定要主人自己在聊天里确认，我不能替他确认');
  error.code = 'calendar_confirmation_required';
  return error;
}

// 内部 id（evt_… / rem_…）对模型没用，还会把库里的主键带出去，返回前统一遮掉。
const INTERNAL_ID_RE = /\b(?:evt|rem)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ID_PLACEHOLDER = '该条';

/**
 * 工具失败统一走这里：模型只看结构化的 { ok, code, message }，
 * 异常只在本层收口，不让它冒到宿主。
 */
function failure(err, fallbackMessage = '日程操作失败') {
  const raw = typeof err?.message === 'string' && err.message.trim() !== '' ? err.message : fallbackMessage;
  const message = raw.replace(INTERNAL_ID_RE, ID_PLACEHOLDER).replace(/\s{2,}/g, ' ').trim();
  return {
    ok: false,
    code: String(err?.code ?? 'agenda_failed'),
    message: message === '' ? fallbackMessage : message,
  };
}

/**
 * 注册两个工具。
 *
 * @param {object} options
 * @param {any} options.api 宿主 api
 * @param {any} options.service createService 的返回值
 * @param {() => Record<string, any>} [options.getSettings] 每次现读设置
 * @returns {{ names: string[] }}
 */
export function createTools({ api, service, getSettings } = {}) {
  if (!api || !service) throw new TypeError('createTools 需要 api 与 service');

  const readSettingsNow = () => {
    if (typeof getSettings !== 'function') return {};
    try {
      const value = getSettings();
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  };

  const names = [];

  api.tool(() => api.defineTool({
    name: 'agenda_query',
    description: '查看角色自己的日程表。日程只是计划，不代表已经发生。',
    properties: {
      from: { type: 'string', description: '开始时间，ISO 时间或毫秒时间戳，可省略（默认从现在稍前开始）' },
      to: { type: 'string', description: '结束时间，ISO 时间或毫秒时间戳，可省略（默认 24 小时以内）' },
      limit: { type: 'integer', minimum: QUERY_LIMIT_MIN, maximum: QUERY_LIMIT_MAX, description: '最多返回几条，默认 12' },
      kind: { type: 'string', enum: KINDS, description: '只看某一类：role_plan 计划 / user_report 告知 / commitment 约定' },
    },
    required: [],
    execute: async (args = {}) => {
      try {
        const zone = zoneOf(readSettingsNow().timezone);
        const now = Date.now();
        const from = msOf(args.from) ?? now - QUERY_LOOKBACK_MS;
        const to = msOf(args.to) ?? from + QUERY_LOOKAHEAD_MS;
        if (!(to > from)) return { ok: false, code: 'invalid_window', message: '时间范围不合法：结束时间要晚于开始时间' };
        if (to - from > MAX_SPAN_MS) return { ok: false, code: 'invalid_window', message: '时间范围太大了，一次最多查 31 天' };
        const limit = intOf(args.limit, QUERY_LIMIT_MIN, QUERY_LIMIT_MAX, 12);
        // 多要一条：按 kind 过滤后条目会变少，截断判断仍交给 service 的 truncated 兜底。
        const page = service.expandEvents({ from, to, limit: args.kind ? limit * 4 : limit });
        const items = Array.isArray(page?.items) ? page.items : [];
        const filtered = args.kind ? items.filter((item) => item.kind === args.kind) : items;
        const sliced = filtered.slice(0, limit);
        const truncated = page?.truncated === true || filtered.length > sliced.length;
        return { ok: true, message: renderRows(sliced, zone, truncated) };
      } catch (err) {
        return failure(err, '查日程失败');
      }
    },
  }));

  api.tool((where) => api.defineTool({
    name: 'agenda_command',
    description: '新增、修改、取消计划或约定，设置单期例外与提醒；不替主人确认约定。',
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'create 新增 / revise 修改 / cancel 取消 / exception 单期例外 / remind 提醒' },
      id: {
        type: 'string',
        description: 'create 以外的动作要带：日程 id（remind 时是可选关联日程 id）。只能关联主人已确认的日程；模型自己新登记、仍在待确认状态的日程不能挂提醒',
      },
      expected_revision: { type: 'integer', minimum: 0, description: '并发控制：新增填 0，修改 / 取消填查到的当前 revision' },
      data: {
        type: 'object',
        description: 'create: kind,title,detail,presence,schedule{anchor,timezone,frequency,interval,count,fold,gap_policy},duration_minutes；'
          + 'revise: 同 create 的可选字段；exception: sequence,start(null 表示取消该期)；'
          + 'remind: message,schedule,lead_minutes（lead_minutes 是提前多少分钟提醒，省略时用设置里的默认提前量）',
      },
    },
    required: ['action', 'expected_revision'],
    execute: async (args = {}, exec) => {
      try {
        const action = String(args.action ?? '').trim();
        // 代主人确认一律拒绝；走和失败一样的结构化返回，不抛异常，
        // 免得异常里的内部 id / revision 直接进模型上下文。
        if (action === 'accept') return failure(confirmationError());

        const current = readSettingsNow();
        if (current.ownerOnly === true) {
          const sessionId = where?.sessionId ?? exec?.sessionId ?? '';
          if (ownerPresence(api, sessionId) === false) {
            return { ok: false, code: 'owner_only', message: '改日程要主人开口，这一轮说话的人不全是主人' };
          }
        }

        const expectedRevision = intOf(args.expected_revision, 0, Number.MAX_SAFE_INTEGER, -1);
        if (expectedRevision < 0) return { ok: false, code: 'invalid_revision', message: 'expected_revision 必须是非负整数' };
        const eventId = String(args.id ?? '').trim();
        const data = args.data && typeof args.data === 'object' ? args.data : {};
        // 模型没给 lead_minutes 时回落到设置里的默认提前量（remindLeadMinutes 在这里生效）。
        const leadFallback = intOf(current.remindLeadMinutes, 0, 1440, 0);

        if (action === 'create') {
          const input = normalizeEventData(data);
          // 模型写的日程一律算角色提的：默认「待确认」，确认这一步留给主人。
          delete input.accepted;
          input.creatorKind = 'role';
          const receipt = service.createEvent(input);
          const tail = receipt?.accepted === true ? '' : '（待主人确认）';
          return { ok: true, message: `已登记：${receipt?.scheduleText ?? ''} ${receipt?.title ?? ''}${tail}`.replace(/\s+/g, ' ').trim() };
        }

        if (action === 'revise') {
          if (!eventId) return { ok: false, code: 'invalid_event', message: '要改哪一条？给个 id' };
          const patch = normalizeEventData(data);
          delete patch.accepted;
          delete patch.creatorKind;
          const receipt = service.reviseEvent(eventId, { expectedRevision, patch });
          const tail = receipt?.accepted === true ? '' : '（待主人确认）';
          return { ok: true, message: `已更新：${receipt?.scheduleText ?? ''} ${receipt?.title ?? ''}${tail}`.replace(/\s+/g, ' ').trim() };
        }

        if (action === 'cancel') {
          if (!eventId) return { ok: false, code: 'invalid_event', message: '要取消哪一条？给个 id' };
          const receipt = service.cancelEvent(eventId, { expectedRevision });
          return { ok: true, message: `已取消：${receipt?.title ?? '该条日程'}` };
        }

        if (action === 'exception') {
          if (!eventId) return { ok: false, code: 'invalid_event', message: '要给哪一条设例外？给个 id' };
          const sequence = Number(data.sequence);
          if (!Number.isInteger(sequence) || sequence < 0) return { ok: false, code: 'invalid_event', message: 'sequence 必须是非负整数' };
          const rawStart = data.start;
          const start = rawStart === null || rawStart === undefined ? null : msOf(rawStart);
          if (rawStart !== null && rawStart !== undefined && start === null) {
            return { ok: false, code: 'invalid_event', message: 'start 要么是 null（取消这一期），要么是合法时间' };
          }
          const receipt = service.setException(eventId, sequence, { start });
          if (receipt?.start === null) return { ok: true, message: `已取消第 ${sequence} 期` };
          const at = formatLocal(zoneOf(current.timezone), receipt.start, { weekday: true, time: true });
          return { ok: true, message: `第 ${sequence} 期改到 ${at}` };
        }

        if (action === 'remind') {
          const reminder = service.createReminder({
            message: data.message ?? '',
            schedule: scheduleInput(data.schedule),
            leadMinutes: data.lead_minutes ?? data.leadMinutes ?? leadFallback,
            eventId: eventId || null,
          });
          try {
            service.materializeOccurrences({ reminderId: reminder.reminderId });
          } catch {
            // 铺期失败不影响提醒本身登记成功，下一轮扫描会补
          }
          const lead = Number(reminder?.leadMinutes ?? 0);
          const when = lead > 0 ? `，提前 ${lead} 分钟` : '，到点提醒';
          return { ok: true, message: `已设置提醒：${reminder?.scheduleText ?? ''}${when}`.trim() };
        }

        return { ok: false, code: 'invalid_action', message: `action 只能是 ${ACTIONS.join(' / ')}` };
      } catch (err) {
        return failure(err);
      }
    },
  }));

  names.push('agenda_query', 'agenda_command');
  return { names };
}
