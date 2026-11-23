// 日程表（aurabot-agenda）：角色自己的节目单 —— 重复日程、单期例外、到点提醒、面板时间轴与模型工具。
//
// 这个文件只做装配：存储（lib/store.mjs）、业务（lib/service.mjs）、提醒调度（lib/dispatcher.mjs）、
// 模型工具（lib/tools.mjs）、注入文案（lib/prompt.mjs）各自独立，这里把它们接起来并暴露面板接口。
//
// 数据落在 api.dataDir()/agenda.sqlite；模块停掉时关连接、停定时器。

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { openStore } from './lib/store.mjs';
import { createService } from './lib/service.mjs';
import { createDispatcher } from './lib/dispatcher.mjs';
import { createTools, normalizeEventData } from './lib/tools.mjs';
import { scheduleInstruction, nowContextInstruction } from './lib/prompt.mjs';
import { isValidZone } from './lib/time.mjs';
import { createPlanner, PLANNING_DEFAULTS } from './lib/planner.mjs';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_SPAN_MS = 31 * DAY_MS;
const PAST_GRACE_MS = 30 * MINUTE_MS;
const PROMPT_SCAN = 32;       // 注入时一次最多捞几条（prompt 自己还会再截到 16）
const PROMPT_WINDOW_MIN = 30;
const PROMPT_WINDOW_MAX = 1440;
const FALLBACK_ZONE = 'Asia/Shanghai';
const INJECT_WARN_INTERVAL_MS = MINUTE_MS; // 同一条注入错误最多每分钟记一次，避免每轮刷日志

const DEFAULTS = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  mode: 'orchestrated',
  windowMinutes: 180,
  dispatchIntervalSeconds: 30,
  latenessSeconds: 300,
  scanSize: 16,
  deliveryChatId: '',
  maxItems: 32,
  ownerOnly: true,
  remindLeadMinutes: 0,
  ...PLANNING_DEFAULTS,
};

const SETTINGS = [
  { key: 'enabled', label: '启用', type: 'switch', hint: '关掉后日程表整个不启动，也不再发提醒；数据留在库里不删' },
  { key: 'timezone', label: '时区', type: 'text', hint: 'IANA 时区名，比如 Asia/Shanghai、Europe/Berlin；写错会退回 UTC', placeholder: 'Asia/Shanghai' },
  {
    key: 'mode',
    label: '注入模式',
    type: 'select',
    options: [
      { value: 'orchestrated', label: '按需窄窗口' },
      { value: 'continuous', label: '接下来 24 小时' },
    ],
    hint: '按需窄窗口：只注入当下前后一小段；接下来 24 小时：注入未来一天的安排',
  },
  { key: 'windowMinutes', label: '窄窗口往后多少分钟', type: 'number', min: PROMPT_WINDOW_MIN, max: PROMPT_WINDOW_MAX, step: 10, hint: '只在「按需窄窗口」模式下生效；往前固定多看 30 分钟' },
  { key: 'dispatchIntervalSeconds', label: '提醒扫描间隔（秒）', type: 'number', min: 10, max: 600, step: 5, hint: '多久查一次到期提醒；改动后要重新加载模块才生效' },
  { key: 'latenessSeconds', label: '迟到容忍（秒）', type: 'number', min: 30, max: 3600, step: 30, hint: '已经过去这么久的提醒直接跳过，不事后补发' },
  { key: 'scanSize', label: '每轮扫描条数', type: 'number', min: 1, max: 32, step: 1, hint: '一轮最多处理几条到期提醒，防止积压时一次刷屏' },
  { key: 'deliveryChatId', label: '提醒发到哪个会话', type: 'text', hint: '留空则发到最近活跃的会话；也可以固定成 private:QQ号 或 group:群号', placeholder: 'private:10001' },
  { key: 'maxItems', label: '列表最多几条', type: 'number', min: 1, max: 64, step: 1, hint: '面板时间轴和注入各取多少条的上限' },
  { key: 'ownerOnly', label: '只允许主人改日程', type: 'switch', hint: '打开后，只有这一轮说话的人全是主人才允许新增、修改、取消' },
  { key: 'remindLeadMinutes', label: '默认提醒提前量（分钟）', type: 'number', min: 0, max: 1440, step: 5, hint: '新建日程时给提醒用的默认提前量；0 表示到点提醒' },
  { key: 'planningEnabled', label: '每天自己排日程', type: 'switch', hint: '打开后每天在下面的时间之后，她会按自己的人格把今天一天排成一段段生活；关掉不影响手动触发' },
  {
    key: 'planningTime',
    label: '几点之后开始排',
    type: 'text',
    hint: '本地时间，HH:MM。只在这个点之后才生成，一天只排一次；写错按 07:30 算',
    placeholder: '07:30',
  },
  {
    key: 'planningDayStart',
    label: '一天的起点',
    type: 'text',
    hint: '从这一刻开始排，到下面那个时间结束',
    placeholder: '07:00',
  },
  {
    key: 'planningDayEnd',
    label: '一天的终点',
    type: 'text',
    hint: '最后一段在这之前收尾',
    placeholder: '23:00',
  },
  { key: 'planningMaxItems', label: '一天最多排几件', type: 'number', min: 1, max: 16, step: 1, hint: '上限而不是定数：实际段数按一天的起点到终点有多长自适应（平均每 85 分钟一段）；多出来的作为「超出上限」丢弃' },
  { key: 'planningRetryMinutes', label: '失败后多久重试（分钟）', type: 'number', min: 5, max: 120, step: 5, hint: '生成失败后至少等这么久再试；次数用完当天就不再自动重试' },
  { key: 'planningPrompt', label: '排日程的偏好', type: 'textarea', hint: '会作为规划偏好传给模型（最多 2000 字）。写你自己的作息、忌讳、想让她多做或别做的事' },
];

function intOf(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 面板 / 接口传来的时间既可能是 ISO 串，也可能是毫秒数字的字符串。
function msOf(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const text = String(value).trim();
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : fallback;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function zoneOf(value, fallback = FALLBACK_ZONE) {
  if (isValidZone(value)) return value;
  return isValidZone(fallback) ? fallback : 'UTC';
}

// 模块从「agenda」改名成「aurabot-agenda」：下面的两段迁移只在改名后第一次启动时真正干活，
// 之后靠标记位 / 目标库里已经有日程直接跳过。任何失败都只记 warn，绝不让 setup 起不来。

// 旧 id（agenda）下的设置搬到新 id 下，只搬一次
function migrateLegacySettings(api, log) {
  try {
    if (typeof api.core?.getConfig !== 'function') {
      log.warn('日程表：拿不到插件配置（api.core.getConfig 不可用），跳过旧设置迁移，可在面板手动改');
      return false;
    }
    const ext = api.core.getConfig()?.ext;
    const legacy = ext?.agenda;
    const current = ext?.['aurabot-agenda'];
    if (!legacy || typeof legacy !== 'object') return false;
    if (current && current.__migratedFromAgenda === true) return false;
    api.saveSettings?.({ ...legacy, __migratedFromAgenda: true });
    log.info('日程表：已把旧 id「agenda」下的设置搬到「aurabot-agenda」');
    return true;
  } catch (error) {
    log.warn('日程表：迁移旧设置失败，可在面板手动改：' + (error?.message || error));
    return false;
  }
}

// 数一下目标库里有多少条日程。返回 0 → 确定是空库；返回 null → 「判断不了」，
// 调用方必须保守跳过（打不开、被锁、查询报错都可能意味着库里有数据，绝不能覆盖）。
// 「表不存在」算确定的 0 条：一个刚被建出来还没建表的库，本来也一条日程都没有。
function countTargetEvents(file, DatabaseSync) {
  if (typeof DatabaseSync !== 'function') return null;
  let db = null;
  try {
    db = new DatabaseSync(file);
    const row = db.prepare('SELECT COUNT(*) AS n FROM agenda_events').get();
    if (!row) return null;
    const count = Number(row.n);
    return Number.isFinite(count) ? count : null;
  } catch (error) {
    if (/no such table/i.test(String(error?.message ?? error))) return 0;
    return null;
  } finally {
    try {
      db?.close(); // 必须关掉，后面 openStore 还要打开同一个文件
    } catch {
      // 关不掉也不影响结论，交给上面的返回值
    }
  }
}

// 旧数据目录（modules-data/agenda）里的库复制到新目录，只复制一次。
//
// 守卫不能只看「目标文件存在」：改名后宿主几秒内就重载，新模块的 openStore 往往抢先建出一个
// 空库（表建好了、0 条日程），旧库那十几条就成了孤儿。所以目标库存在时还要数条数 ——
// 只有明确数到 0 条才用旧库覆盖；判断不了一律跳过，绝不冒险拿旧库盖掉可能非空的新库。
function migrateLegacyData(api, log, DatabaseSync) {
  try {
    const newDir = api.dataDir();                          // modules-data/aurabot-agenda
    const legacyDir = join(dirname(newDir), 'agenda');     // modules-data/agenda
    const names = ['agenda.sqlite', 'agenda.sqlite-wal', 'agenda.sqlite-shm'];
    const target = join(newDir, 'agenda.sqlite');
    const source = join(legacyDir, 'agenda.sqlite');
    if (!existsSync(source)) return false;

    const targetExists = existsSync(target);
    if (targetExists) {
      const count = countTargetEvents(target, DatabaseSync);
      if (count === null) {
        log.warn('日程表：新目录里已有日程库但读不出条数（打不开或查询失败），保守跳过旧库迁移；确认新库为空时可手动把 modules-data/agenda 里的库拷过来');
        return false;
      }
      if (count > 0) return false;   // 已经有真实日程，不能覆盖
      // 防止改名后先被建出空库：目标库零条日程，才允许用旧库盖掉
      log.warn('日程表：新目录里的日程库是空的（改名后可能被抢先建出来），用旧库覆盖');
    }

    mkdirSync(newDir, { recursive: true });
    // 三个文件先全部删掉再拷：残留的空 -wal/-shm 会跟着新库一起被打开，反而搅坏数据
    for (const name of names) rmSync(join(newDir, name), { force: true });
    for (const name of names) {
      const from = join(legacyDir, name);
      if (existsSync(from)) copyFileSync(from, join(newDir, name));
    }
    log.info(targetExists
      ? '日程表：已用旧数据目录里的日程库覆盖新目录里的空库'
      : '日程表：已把旧数据目录里的日程库复制到「aurabot-agenda」');
    return true;
  } catch (error) {
    log.warn('日程表：迁移旧数据失败，将新建空库（旧库仍在 modules-data/agenda 里，可手工拷回来）：' + (error?.message || error));
    return false;
  }
}

/** @type {import('../aurabot').AurabotModule} */ // 编辑器的自动补全靠这一行
export default {
  id: 'aurabot-agenda',
  name: '日程表',
  version: '0.1.0',
  api: 1,
  description: '角色日程表：重复日程、到点提醒、面板时间轴与模型查询工具',
  panel: 'panel.js',
  defaults: DEFAULTS,
  settings: SETTINGS,

  async setup(api) {
    // 日志：先按 history-vault 的做法用模块自己的 api.log，取不到再退到插件的 logger。
    const log = api.log ?? api.core?.logger ?? { debug() {}, info() {}, warn() {}, error() {} };

    const settings = () => {
      let value = {};
      try {
        value = api.settings() ?? {};
      } catch {
        value = {};
      }
      return { ...DEFAULTS, ...value };
    };

    if (settings().enabled === false) return; // 关掉就安静不启动

    // node:sqlite 仍是实验性 API：取不到就停在这里，不牵连插件（history-vault 的做法）。
    // 拿到手的模块继续往下传：迁移时要靠它的 DatabaseSync 判断新库是不是空的（只 import 这一次）。
    let sqlite = null;
    try {
      sqlite = await import('node:sqlite');
    } catch (error) {
      log.warn(`这台机器的 Node 用不了 node:sqlite，日程表不启动：${error?.message ?? error}`);
      return;
    }

    // 改名的一次性迁移：必须赶在 openStore 之前，否则新 id 会先开出一个空库、旧库就成孤儿了。
    // 顺序是先设置、后数据（设置里可能带着 deliveryChatId 这类和数据无关的偏好）。
    migrateLegacySettings(api, log);
    migrateLegacyData(api, log, sqlite?.DatabaseSync);

    let store;
    try {
      store = await openStore({ dir: api.dataDir() });
    } catch (error) {
      log.error(`日程库打不开，日程表不启动：${error?.message ?? error}`);
      return;
    }

    // 历史默认值残留的一次性修正：上一版的 planningMaxItems 默认值是 2，而宿主播种设置时只补缺失键、
    // 不覆盖已有值，于是这个 2 被写死在 config.json 里。现在的段数是按全天时长自适应算的
    // （夹在 1..planningMaxItems），上限被钉成 2 就等于把「排满一整天」压死。
    // 只在值恰好等于 2 时升级；用户自己设的 3、5、8、16 一律不动。失败也不能打断启动。
    try {
      const current = api.settings();
      if (Number(current?.planningMaxItems) === 2) {
        try {
          api.saveSettings?.({ planningMaxItems: 10 });
          log.info('日程表：把「一天最多排几件」的旧默认值 2 升级为 10');
        } catch (error) {
          log.warn('日程表：升级 planningMaxItems 失败，可手动在面板改：' + (error?.message || error));
        }
      }
    } catch {
      // api.settings() 自己取不到时当作没有旧默认值残留，不影响模块启动
    }

    const service = createService({ db: store.db });
    createTools({ api, service, getSettings: settings });

    // ---------- 每日生成 ----------
    // 只做 daily 一档：一天一个 slot，到点之后由 tick 决定要不要真的叫模型。
    const planner = createPlanner({
      api,
      service,
      db: store.db,
      readSettings: settings,
    });
    planner.start();

    // ---------- 每轮注入 ----------
    // 两条通道，口径只有一处：窗口怎么算、取哪一批条目都在 windowAt 里，两段文案各自渲染。
    //
    // 面板的「当前注入预览」和 api.rule 也用同一段，不复制两份逻辑，
    // 否则预览和真正注入的行为迟早各自漂移。
    //
    // includePast：「此刻正在做」必须看得见早就开始的那一条。expandEvents 本身就按期次与窗口
    // 重叠来捞（搜索起点会按时长前推），进行中的条目本来就在里面；这里再多看 30 分钟只是余量，
    // 代价是多扫几条会被 nowContextInstruction 忽略的已结束行。
    function windowAt(atMs, { includePast = false } = {}) {
      const now = Number.isFinite(atMs) ? Number(atMs) : Date.now();
      const cfg = settings();
      const zone = zoneOf(cfg.timezone);
      const mode = cfg.mode === 'continuous' ? 'continuous' : 'orchestrated';
      const back = includePast || mode !== 'continuous' ? PAST_GRACE_MS : 0;
      const ahead = mode === 'continuous'
        ? DAY_MS
        : intOf(cfg.windowMinutes, PROMPT_WINDOW_MIN, PROMPT_WINDOW_MAX, 180) * MINUTE_MS;
      const page = service.expandEvents({ from: now - back, to: now + ahead, limit: PROMPT_SCAN });
      return {
        mode,
        zone,
        now,
        rows: page?.items ?? [],
        partial: page?.truncated === true,
      };
    }

    function renderInjection(atMs) {
      const win = windowAt(atMs);
      return {
        mode: win.mode,
        itemCount: win.rows.length,
        text: scheduleInstruction({
          mode: win.mode,
          rows: win.rows,
          partial: win.partial,
          zone: win.zone,
          now: win.now,
        }),
      };
    }

    // 主通道：此刻在做什么。走 api.context → 宿主挂在每轮 system-reminder 快照末尾的 runtime context，
    // 不并进 {{aurabot_rules_private}} 的 bullet 列表，多行结构完整、位置在最后。
    function renderNowContext(atMs) {
      const win = windowAt(atMs, { includePast: true });
      return nowContextInstruction({ rows: win.rows, zone: win.zone, now: win.now });
    }

    // 注入失败只降级成「这一轮没有日程材料」，但必须留痕；
    // 按「同样的消息 + 一分钟内」节流，坏了也不会把日志刷爆。
    let injectWarnAt = 0;
    let injectWarnText = '';
    function reportInjectionFailure(error) {
      const message = String(error?.message ?? error);
      const at = Date.now();
      if (message === injectWarnText && at - injectWarnAt < INJECT_WARN_INTERVAL_MS) return;
      injectWarnAt = at;
      injectWarnText = message;
      log.warn(`日程注入失败：${message}`);
    }

    api.rule(() => {
      try {
        if (settings().enabled === false) return '';
        return renderInjection(Date.now()).text;
      } catch (error) {
        // 注入失败绝不能冒到宿主：这一轮就当没有日程材料。
        reportInjectionFailure(error);
        return '';
      }
    });

    // 第二条通道（主）：「你此刻的状态」。宿主的 contextFor 是同步的、直接 String() 拼进去
    // （modules.js#L726），所以这里只能同步返回字符串 —— 返回 Promise 只会变成 "[object Promise]"。
    api.context((args) => {
      try {
        if (settings().enabled === false) return '';
        // 系统 / 后台会话（连「自己排今天的日程」那次叫模型也走这条路）不塞她的作息，免得自我指涉。
        const chat = args?.chat;
        if (!chat || chat.kind === 'system') return '';
        return renderNowContext(Date.now());
      } catch (error) {
        reportInjectionFailure(error);
        return '';
      }
    });

    // ---------- 提醒发送 ----------
    // 最近活跃会话缓存：没固定 deliveryChatId 时发到这里（system: 会话发不出去，直接忽略）。
    let recentChatId = '';
    api.on('activity', (event) => {
      const chatId = typeof event?.chatId === 'string' ? event.chatId : '';
      if (!chatId || chatId.startsWith('system:')) return;
      recentChatId = chatId;
    });

    function resolveChatId() {
      const explicit = String(settings().deliveryChatId ?? '').trim();
      if (explicit) return explicit;
      return recentChatId;
    }

    // dispatcher 读的是 intervalSeconds，而对外设置的键名是 dispatchIntervalSeconds，这里做一次映射。
    function dispatcherSettings() {
      const cfg = settings();
      return {
        enabled: cfg.enabled !== false,
        timezone: zoneOf(cfg.timezone),
        latenessSeconds: cfg.latenessSeconds,
        scanSize: cfg.scanSize,
        intervalSeconds: cfg.dispatchIntervalSeconds,
      };
    }

    const dispatcher = createDispatcher({
      api,
      service,
      readSettings: dispatcherSettings,
      resolveChatId,
    });

    // 铺期次：提醒真正能发出去，靠的是 agenda_occurrences 里有行。
    // 新建时铺一次，模块启动时给所有现存提醒再补齐一次（INSERT OR IGNORE，重复调用无害）。
    function primeOccurrences() {
      let items = [];
      try {
        items = service.listReminders({ limit: 64 })?.items ?? [];
      } catch (error) {
        log.debug?.(`读取提醒失败：${error?.message ?? error}`);
        return;
      }
      for (const item of items) {
        if (item?.state !== 'active') continue;
        try {
          service.materializeOccurrences({ reminderId: item.reminderId });
        } catch (error) {
          log.debug?.(`提醒 ${item.reminderId} 铺期失败：${error?.message ?? error}`);
        }
      }
    }

    primeOccurrences();
    dispatcher.start();

    // ---------- 面板接口（前缀 /aurabot/api/ext/aurabot-agenda）----------
    const fail = (error) => ({
      ok: false,
      code: String(error?.code ?? 'agenda_error'),
      message: String(error?.message ?? error),
    });

    // 同源守卫（照 history-vault 的 crossSite）：写接口和读接口都不接受跨站调用，
    // 命中时返回业务错误形状（HTTP 200），和其它失败分支一致。
    function crossSite(req) {
      const site = String(req?.headers?.['sec-fetch-site'] || '');
      if (site === 'cross-site') {
        return { ok: false, code: 'cross_site', message: '不允许跨站调用' };
      }
      const origin = String(req?.headers?.origin || '');
      if (origin) {
        try {
          if (new URL(origin).host !== String(req?.headers?.host || '')) {
            return { ok: false, code: 'cross_site', message: '不允许跨站调用' };
          }
        } catch {
          return { ok: false, code: 'cross_site', message: '不允许跨站调用' };
        }
      }
      return null;
    }

    api.route('/events', async (req) => {
      const guard = crossSite(req);
      if (guard) return guard;
      try {
        const query = api.core.http.query(req) ?? {};
        const now = Date.now();
        const from = msOf(query.from, now - PAST_GRACE_MS);
        const to = msOf(query.to, from + DAY_MS);
        if (!(to > from) || to - from > MAX_SPAN_MS) {
          return { ok: false, code: 'invalid_window', message: '时间范围要在 31 天以内，并且结束晚于开始' };
        }
        const limit = intOf(query.limit, 1, 128, intOf(settings().maxItems, 1, 64, 32));
        const page = service.expandEvents({ from, to, limit });
        return { ok: true, items: page?.items ?? [], truncated: page?.truncated === true };
      } catch (error) {
        return fail(error);
      }
    });

    api.route('/save', async (req) => {
      const guard = crossSite(req);
      if (guard) return guard;
      try {
        if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
          return { ok: false, code: 'method_not_allowed', message: '这个接口只收 POST' };
        }
        const body = (await api.core.http.body(req)) ?? {};
        const action = String(body.action ?? '').trim();
        const eventId = String(body.eventId ?? '').trim();
        const expectedRevision = intOf(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER, -1);
        if (expectedRevision < 0) {
          return { ok: false, code: 'invalid_revision', message: 'expectedRevision 必须是非负整数' };
        }
        const data = body.data && typeof body.data === 'object' ? body.data : {};

        if (action === 'create') {
          return { ok: true, receipt: service.createEvent(normalizeEventData(data)) };
        }
        if (action === 'revise') {
          if (!eventId) return { ok: false, code: 'invalid_event', message: '要改哪一条？给个 eventId' };
          return { ok: true, receipt: service.reviseEvent(eventId, { expectedRevision, patch: normalizeEventData(data) }) };
        }
        if (action === 'cancel') {
          if (!eventId) return { ok: false, code: 'invalid_event', message: '要取消哪一条？给个 eventId' };
          return { ok: true, receipt: service.cancelEvent(eventId, { expectedRevision }) };
        }
        if (action === 'remove') {
          if (!eventId) return { ok: false, code: 'invalid_event', message: '要删哪一条？给个 eventId' };
          return { ok: true, receipt: service.deleteEvent(eventId, { expectedRevision }) };
        }
        if (action === 'exception') {
          if (!eventId) return { ok: false, code: 'invalid_event', message: '要给哪一条设例外？给个 eventId' };
          const sequence = Number(data.sequence);
          if (!Number.isInteger(sequence) || sequence < 0) {
            return { ok: false, code: 'invalid_event', message: 'sequence 必须是非负整数' };
          }
          const start = data.start === null || data.start === undefined ? null : msOf(data.start, null);
          if (data.start !== null && data.start !== undefined && start === null) {
            return { ok: false, code: 'invalid_event', message: 'start 要么是 null（取消这一期），要么是合法时间' };
          }
          return { ok: true, receipt: service.setException(eventId, sequence, { start }) };
        }
        return { ok: false, code: 'unknown_action', message: `action 只能是 create / revise / cancel / remove / exception` };
      } catch (error) {
        return fail(error);
      }
    });

    api.route('/reminders', async (req) => {
      const guard = crossSite(req);
      if (guard) return guard;
      try {
        if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
          const query = api.core.http.query(req) ?? {};
          const list = service.listReminders({
            limit: intOf(query.limit, 1, 200, 50),
            includeCancelled: String(query.includeCancelled ?? '') === 'true',
          });
          return { ok: true, items: list?.items ?? [] };
        }

        const body = (await api.core.http.body(req)) ?? {};
        const action = String(body.action ?? 'create').trim();
        const data = body.data && typeof body.data === 'object' ? body.data : {};

        if (action === 'cancel') {
          const reminderId = String(body.reminderId ?? body.data?.reminderId ?? '').trim();
          if (!reminderId) return { ok: false, code: 'invalid_reminder', message: '要取消哪个提醒？给个 reminderId' };
          const expectedRevision = intOf(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER, -1);
          if (expectedRevision < 0) {
            return { ok: false, code: 'invalid_revision', message: 'expectedRevision 必须是非负整数' };
          }
          return { ok: true, receipt: service.cancelReminder(reminderId, { expectedRevision }) };
        }
        if (action !== 'create') {
          return { ok: false, code: 'unknown_action', message: 'action 只能是 create / cancel' };
        }

        const receipt = service.createReminder({
          message: data.message ?? '',
          schedule: normalizeEventData({ schedule: data.schedule }).schedule,
          // 没显式给提前量时回落到设置里的默认值（remindLeadMinutes 在这里生效）。
          leadMinutes: data.leadMinutes ?? data.lead_minutes ?? intOf(settings().remindLeadMinutes, 0, 1440, 0),
          eventId: data.eventId ?? body.eventId ?? null,
        });
        try {
          service.materializeOccurrences({ reminderId: receipt.reminderId });
        } catch (error) {
          log.debug?.(`提醒 ${receipt.reminderId} 铺期失败：${error?.message ?? error}`);
        }
        return { ok: true, receipt };
      } catch (error) {
        return fail(error);
      }
    });

    api.route('/stats', async (req) => {
      const guard = crossSite(req);
      if (guard) return guard;
      try {
        return { ok: true, ...service.stats() };
      } catch (error) {
        return fail(error);
      }
    });

    // 生成状态：面板顶部那张小卡片用它；顺带把「眼下这一轮会注入什么」一起发下去。
    //
    // 有两条通道，预览就分别取两段：rule 走 renderInjection（api.rule 的同一段），
    // now 走 renderNowContext（api.context 的同一段）。都直接调真实注入用的那个函数，
    // 不复制渲染逻辑，否则预览和真正注入迟早各自漂移。
    //
    // 任一通道算不出来只让那一段变空串并留痕，不能让整张生成状态卡片跟着读不到。
    api.route('/planning', async (req) => {
      const guard = crossSite(req);
      if (guard) return guard;
      try {
        const status = planner.status();
        const at = Date.now();

        let mode = 'orchestrated';
        let itemCount = 0;
        let ruleText = '';
        let nowText = '';

        try {
          const injected = renderInjection(at);
          mode = injected.mode;
          itemCount = injected.itemCount;
          ruleText = String(injected.text ?? '');
        } catch (error) {
          reportInjectionFailure(error);
        }

        try {
          nowText = String(renderNowContext(at) ?? '');
        } catch (error) {
          reportInjectionFailure(error);
        }

        const preview = {
          mode,
          itemCount,
          // 顶层 text 保留成 rule.text 的别名：面板和可能存在的其它脚本还在读 preview.text，
          // 去掉它会静默变成 undefined。
          text: ruleText,
          rule: { text: ruleText },
          now: { text: nowText },
        };
        return { ...status, preview };
      } catch (error) {
        return fail(error);
      }
    });

    // 手动排一次。不受「今天已经排过」限制，但仍然照常写记账，避免和自动流程打架。
    api.route('/planning/run', async (req) => {
      const guard = crossSite(req);
      if (guard) return guard;
      try {
        if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
          return { ok: false, code: 'method_not_allowed', message: '这个接口只收 POST' };
        }
        const body = (await api.core.http.body(req)) ?? {};
        const wanted = String(body.mode ?? 'daily').trim();
        if (wanted && wanted !== 'daily') {
          return { ok: false, code: 'unsupported_mode', message: '这个版本只支持 daily' };
        }
        const result = await planner.run({ now: Date.now(), mode: 'daily', manual: true });
        return {
          ok: result.ok === true,
          saved: result.saved ?? 0,
          rejected: result.rejected ?? 0,
          state: result.state ?? 'failed',
          message: result.message ?? '',
          ...(result.ok === true ? {} : { code: String(result.code ?? 'planning_failed') }),
        };
      } catch (error) {
        return fail(error);
      }
    });

    api.onDispose(() => {
      try {
        planner.stop();
      } catch {
        // 停生成定时器失败无需上报
      }
      try {
        dispatcher.stop();
      } catch {
        // 停定时器失败无需上报
      }
      try {
        store.close();
      } catch {
        // 关库失败时进程退出会回收
      }
    });

    log.info(`日程表就绪：${store.path}`);

    return { service, tick: dispatcher.tick, planner };
  },
};
