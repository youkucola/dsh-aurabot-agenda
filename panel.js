// 日程表 · 自定义面板
// 拿到 React、h、ui（面板自带组件：Card / Btn / Switch / Row / Empty / Select）、call（调模块接口），
// 最后 return 一个 React 组件。数据来自 /events、/stats，写操作走 /save 与 /reminders。
//
// 三块内容：今日时间轴、未来 7 天、新建日程；设置只做只读一览（表单在模块自己的设置页里，不重复实现）。

const { useState } = React

const KIND_LABELS = { role_plan: '计划', user_report: '告知', commitment: '约定' }
const KIND_COLORS = { role_plan: '#4c8dff', user_report: '#37b26c', commitment: '#e8912d' }
const KIND_OPTIONS = [
  { value: 'role_plan', label: '计划（角色自己的安排）' },
  { value: 'user_report', label: '告知（主人说过的安排）' },
  { value: 'commitment', label: '约定（双方谈定的）' },
]
const REPEAT_OPTIONS = [
  { value: 'once', label: '一次' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' },
]
const SETTING_LABELS = {
  enabled: '启用',
  timezone: '时区',
  mode: '注入模式',
  windowMinutes: '窄窗口（分钟）',
  dispatchIntervalSeconds: '扫描间隔（秒）',
  latenessSeconds: '迟到容忍（秒）',
  scanSize: '每轮扫描条数',
  deliveryChatId: '提醒会话',
  maxItems: '列表上限',
  ownerOnly: '只允许主人改',
  remindLeadMinutes: '默认提前量（分钟）',
  planningEnabled: '每天自己排日程',
  planningTime: '几点之后开始排',
  planningMaxItems: '一天最多排几件',
  planningRetryMinutes: '失败后多久重试（分钟）',
  planningPrompt: '排日程的偏好',
}

const DAY_MS = 86400000
const WEEK_MS = 7 * DAY_MS
const MAX_PER_DAY = 6
// 注入预览最多显示这么多字符，再长就截断提示，避免长文案把面板撑爆。
const PREVIEW_LIMIT = 1200
const MODE_LABELS = { orchestrated: '按需窄窗口', continuous: '接下来 24 小时' }
// 三态只看钟点，不读数据库里的 state，与源项目保持一致。
const STATUS_LABELS = { upcoming: '未开始', ongoing: '进行中', done: '已完成' }
const STATUS_COLORS = { upcoming: '#8a8f98', ongoing: '#2f6fe4', done: '#b6bcc4' }
const MINUTE_MS = 60000

const NOTE = { className: 'ab-note', style: { margin: '6px 0' } }
const FIELD = { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 96 }
const LABEL = { fontSize: 12, opacity: 0.7 }

const PLANNING_STATE_LABELS = {
  idle: '今天还没生成',
  running: '正在安排……',
  empty: '今天没有要特意安排的事',
  unknown: '读取不到生成状态',
}

function planningText(info) {
  if (!info) return '正在读取生成状态……'
  const today = info.today || {}
  const state = String(today.state || 'idle')
  if (state === 'done') return '已排好 ' + (today.saved || 0) + ' 条'
  if (state === 'failed') return '失败 ' + (today.attempts || 0) + ' 次' + (today.message ? '：' + today.message : '')
  return PLANNING_STATE_LABELS[state] || ('状态：' + state)
}

function planningTimeText(info) {
  const at = info && info.today ? info.today.updatedAt : ''
  const ms = at ? Date.parse(at) : NaN
  if (!Number.isFinite(ms)) return '还没生成过'
  return dayKey(ms) + ' ' + hhmm(ms)
}

// 注入预览里的一段：小标题 + 一句说明 + 等宽文本。
// 两条通道（api.context 的此刻状态、api.rule 的窗口列表）各调一次，截断规则共用一份。
// 文本为空时不渲染空的 pre，直接给一句说明，免得面板上出现一块空白灰框。
function previewBlock(title, hint, text, emptyText) {
  const body = String(text || '')
  const clipped = body.length > PREVIEW_LIMIT ? body.slice(0, PREVIEW_LIMIT) : body
  return h('div', { style: { marginTop: 10 } },
    h('div', { style: { fontSize: 13, fontWeight: 600 } }, title),
    h('p', { className: 'ab-note', style: { margin: '2px 0 4px', fontSize: 12 } }, hint),
    body
      ? h('pre', {
          style: {
            margin: '4px 0 0',
            padding: 8,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 320,
            overflow: 'auto',
            background: 'rgba(127,127,127,.08)',
            borderRadius: 6,
          },
        }, clipped + (clipped.length < body.length ? '\n……（只显示前 ' + PREVIEW_LIMIT + ' 个字符）' : ''))
      : h('p', NOTE, emptyText))
}

function pad2(n) { return String(n).padStart(2, '0') }

function hhmm(ms) {
  const d = new Date(ms)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function dayKey(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

// 纯按钟点算三态：now < start 未开始，start <= now < end 进行中，now >= end 已完成。
// 「未来 7 天」里跨天的条目还没轮到今天，一律按未开始；昨天开始、今天仍在进行的那类仍按钟点算。
function statusOf(item, now) {
  const start = Number(item.start)
  const end = Number(item.end)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'upcoming'
  if (start > now && dayKey(start) !== dayKey(now)) return 'upcoming'
  if (now < start) return 'upcoming'
  if (now < end) return 'ongoing'
  return 'done'
}

function elapsedMinutes(item, now) {
  const start = Number(item.start)
  if (!Number.isFinite(start)) return 0
  return Math.max(0, Math.floor((now - start) / MINUTE_MS))
}

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function todayValue() {
  return dayKey(Date.now())
}

return function Panel({ settings, save, toast }) {
  const cfg = settings || {}
  const [today, setToday] = useState(null)
  const [week, setWeek] = useState(null)
  const [stats, setStats] = useState(null)
  const [planning, setPlanning] = useState(null)
  const [planningBusy, setPlanningBusy] = useState(false)
  const [busy, setBusy] = useState('')
  // 三态按当前钟点算，每分钟刷新一次，卸载时清掉定时器。
  const [now, setNow] = useState(Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS)
    return () => clearInterval(timer)
  }, [])
  const [form, setForm] = useState({
    title: '',
    date: todayValue(),
    time: '09:00',
    duration: 60,
    repeat: 'once',
    count: '',
    lead: Number(cfg.remindLeadMinutes) || 0,
    kind: 'role_plan',
    presence: '',
  })

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const reload = () => {
    setToday(null)
    setWeek(null)
    setStats(null)
  }

  const loadToday = async () => {
    try {
      const from = startOfToday()
      const r = await call('/events?from=' + from + '&to=' + (from + DAY_MS) + '&limit=64')
      if (r && r.ok === false) throw new Error(r.message || '读取失败')
      setToday(r.items || [])
    } catch (e) {
      toast('读取今日时间轴失败：' + e.message)
      setToday([])
    }
  }

  const loadWeek = async () => {
    try {
      const now = Date.now()
      const r = await call('/events?from=' + now + '&to=' + (now + WEEK_MS) + '&limit=128')
      if (r && r.ok === false) throw new Error(r.message || '读取失败')
      setWeek(r.items || [])
    } catch (e) {
      toast('读取未来 7 天失败：' + e.message)
      setWeek([])
    }
  }

  const loadStats = async () => {
    try {
      const r = await call('/stats')
      setStats(r || null)
    } catch (e) {
      toast('读取统计失败：' + e.message)
    }
  }

  const loadPlanning = async () => {
    try {
      const r = await call('/planning')
      if (r && r.ok === false) throw new Error(r.message || '读取失败')
      setPlanning(r || { today: {} })
    } catch (e) {
      setPlanning({ today: { state: 'unknown' } })
    }
  }

  const runPlanning = async () => {
    setPlanningBusy(true)
    try {
      const r = await call('/planning/run', {})
      if (r && r.ok === false) {
        toast(r.code === 'planning_busy' ? '已经在排了，稍等一会儿' : ('排日程失败：' + (r.message || '原因不明')))
      } else {
        toast(r && r.message ? r.message : '排好了')
      }
      await loadPlanning()
      reload()
    } catch (e) {
      toast('排日程失败：' + e.message)
    } finally {
      setPlanningBusy(false)
    }
  }

  if (!today) loadToday()
  if (!week) loadWeek()
  if (!stats) loadStats()
  if (!planning) loadPlanning()

  const saveEvent = async (payload, okText) => {
    setBusy('save')
    try {
      const r = await call('/save', payload)
      if (r && r.ok === false) throw new Error(r.message || '操作失败')
      toast(okText + (r.receipt && r.receipt.scheduleText ? '：' + r.receipt.scheduleText : ''))
      return r.receipt || null
    } catch (e) {
      toast('操作失败：' + e.message)
      return null
    } finally {
      setBusy('')
    }
  }

  const createEvent = async () => {
    const title = String(form.title || '').trim()
    if (!title) { toast('先写个标题'); return }
    const dateParts = String(form.date || '').split('-').map(Number)
    const timeParts = String(form.time || '').split(':').map(Number)
    if (dateParts.length !== 3 || timeParts.length !== 2) { toast('日期或时间格式不对'); return }
    const [y, m, d] = dateParts
    const [H, M] = timeParts
    if (!y || !m || !d || !Number.isFinite(H) || !Number.isFinite(M)) { toast('日期或时间填得不对'); return }

    const anchor = new Date(y, m - 1, d, H, M, 0, 0).getTime()
    const count = form.count === '' ? null : Number(form.count)
    const schedule = {
      anchor,
      timezone: cfg.timezone || 'Asia/Shanghai',
      frequency: form.repeat,
      interval: 1,
      count: form.repeat === 'once' ? null : (Number.isFinite(count) ? count : null),
      fold: 0,
      gapPolicy: 'reject',
    }
    const receipt = await saveEvent({
      action: 'create',
      expectedRevision: 0,
      data: {
        kind: form.kind,
        title,
        presence: String(form.presence || '').trim(),
        durationMinutes: Number(form.duration) || 60,
        schedule,
      },
    }, '已登记')
    if (!receipt) return

    const lead = Number(form.lead) || 0
    if (receipt.eventId) {
      try {
        const r = await call('/reminders', {
          action: 'create',
          data: { message: title, leadMinutes: lead, eventId: receipt.eventId, schedule },
        })
        if (r && r.ok === false) toast('日程已登记，但提醒没挂上：' + (r.message || '原因不明'))
      } catch (e) {
        toast('日程已登记，但提醒没挂上：' + e.message)
      }
    }
    setForm((prev) => ({ ...prev, title: '' }))
    reload()
  }

  const cancelEvent = async (item) => {
    const text = '取消「' + item.title + '」的整条日程？以后各期都不会再提醒。'
    if (!confirm(text)) return
    const receipt = await saveEvent(
      { action: 'cancel', eventId: item.eventId, expectedRevision: item.revision },
      '已取消 ' + item.title,
    )
    if (receipt) reload()
  }

  const confirmEvent = async (item) => {
    const receipt = await saveEvent(
      { action: 'revise', eventId: item.eventId, expectedRevision: item.revision, data: { accepted: true } },
      '已确认 ' + item.title,
    )
    if (receipt) reload()
  }

  const renderList = (items, withDate) => {
    if (!items || items.length === 0) {
      return h('p', NOTE, '这个时间段没有日程。')
    }
    return h('div', null, items.map((item) => {
      const status = statusOf(item, now)
      const color = KIND_COLORS[item.kind] || '#8a8a8a'
      const ongoing = status === 'ongoing'
      const detail = String(item.detail || '')
      // 进行中给「已持续」，其余给这条本身的时长。
      const spanText = ongoing
        ? '已持续 ' + elapsedMinutes(item, now) + ' 分钟'
        : (Number(item.durationMinutes) || 0) + ' 分钟'
      return h('div', {
        key: String(item.eventId) + ':' + String(item.sequence),
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '8px 0',
          borderBottom: '1px solid rgba(127,127,127,.16)',
          opacity: status === 'done' ? 0.6 : 1,
        },
      },
        h('div', {
          style: { minWidth: 46, fontSize: 13, opacity: status === 'upcoming' ? 0.8 : 0.95, fontVariantNumeric: 'tabular-nums' },
        },
          h('div', null, hhmm(item.start)),
          h('div', { style: { fontSize: 11, opacity: 0.65, marginTop: 1 } }, '至 ' + hhmm(item.end))),
        h('div', {
          style: { width: ongoing ? 6 : 4, alignSelf: 'stretch', borderRadius: 2, background: color },
        }),
        h('div', {
          style: {
            flex: 1,
            minWidth: 0,
            padding: ongoing ? '4px 9px' : 0,
            border: ongoing ? '1px solid ' + color + '66' : 'none',
            borderRadius: ongoing ? 6 : 0,
            background: ongoing ? color + '12' : 'transparent',
          },
        },
          h('div', { style: { fontWeight: ongoing ? 600 : 400 } },
            String(item.title) + (item.accepted === false ? '（待确认）' : '')),
          detail
            ? h('div', {
                style: {
                  marginTop: 3,
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 4,
                  overflow: 'hidden',
                },
              }, detail)
            : null,
          h('div', { className: 'ab-note', style: { fontSize: 12, marginTop: 3 } },
            [
              withDate ? dayKey(item.start) : '',
              KIND_LABELS[item.kind] || '安排',
              spanText,
              item.presence ? '在场：' + item.presence : '',
            ].filter(Boolean).join(' · '),
            ' · ',
            h('span', {
              key: 'status',
              style: { color: STATUS_COLORS[status], fontWeight: ongoing ? 600 : 400 },
            }, STATUS_LABELS[status])),
        ),
        item.accepted === false
          ? h(ui.Btn, { onClick: () => confirmEvent(item), disabled: busy === 'save', style: { marginRight: 6 } }, '确认')
          : null,
        h(ui.Btn, { onClick: () => cancelEvent(item), disabled: busy === 'save' }, '取消'),
      )
    }))
  }

  // 今日三态计数：按钟点实时算，取代原来那个与时间无关的 stats.active。
  const todayCounts = { ongoing: 0, upcoming: 0, done: 0 }
  for (const item of today || []) todayCounts[statusOf(item, now)] += 1

  const weekGroups = () => {
    const groups = []
    const index = new Map()
    for (const item of week || []) {
      const key = dayKey(item.start)
      if (!index.has(key)) {
        index.set(key, { key, items: [] })
        groups.push(index.get(key))
      }
      index.get(key).items.push(item)
    }
    return groups
  }

  const planningCard = h(ui.Card, { title: '今天的日程生成' },
    h('p', NOTE, '状态：' + planningText(planning)),
    h('p', { className: 'ab-note', style: { margin: '2px 0', fontSize: 12 } },
      '生成时间：' + planningTimeText(planning) +
      ' · 每天 ' + String((planning && planning.time) || cfg.planningTime || '07:30') + ' 之后自动排一次' +
      (planning && planning.enabled === false ? ' · 自动生成现在是关的' : '')),
    h('div', { style: { marginTop: 6 } },
      h(ui.Btn, { onClick: runPlanning, disabled: planningBusy }, planningBusy ? '正在安排……' : '现在排一次'),
      h('span', { className: 'ab-note', style: { marginLeft: 10, fontSize: 12 } },
        '手动触发不受「今天已经排过」限制。角色自己排的日程会自动确认。')),
  )

  // 注入预览：/planning 顺带把这一轮两条通道真正会注入的文本发下来，这里只负责显示。
  // rule 进 system 规则块（宿主逐行加「- 」），now 进每轮 system-reminder 快照末尾的 runtime context（不经 bullet）。
  const preview = (planning && planning.preview) || null
  const previewRule = preview ? String((preview.rule && preview.rule.text) || preview.text || '') : ''
  const previewNow = preview ? String((preview.now && preview.now.text) || '') : ''
  const injectionCard = h('details', { style: { marginTop: 10 } },
    h('summary', { style: { cursor: 'pointer', fontSize: 13, fontWeight: 600 } }, '对话里注入了什么'),
    h('p', { className: 'ab-note', style: { margin: '6px 0 2px', fontSize: 12 } },
      !planning
        ? '正在读取注入内容……'
        : (preview
          ? '注入模式：' + (MODE_LABELS[preview.mode] || String(preview.mode || '未知')) +
            ' · 命中 ' + (Number(preview.itemCount) || 0) + ' 条'
          : '读取不到注入预览')),
    preview
      ? h('div', null,
          previewBlock('此刻状态（进入 runtime context）',
            '走 api.context，落在每轮 system-reminder 快照末尾的 runtime context，不并进规则块的条目列表。',
            previewNow, '当前没有可注入的此刻状态'),
          previewBlock('窗口列表（进入 system 规则块）',
            '走 api.rule，进 system 规则块，宿主会逐行加「- 」前缀。',
            previewRule, '当前窗口没有日程'))
      : null,
  )

  return h('div', null,
    planningCard,
    injectionCard,
    h(ui.Card, { title: '日程表' },
    h('p', NOTE,
      '重复日程按墙钟走：夏令时的折叠与跳变、月末夹取都由规则层统一处理，面板只负责看和改。'),
    stats
      ? h('p', NOTE,
          '总共 ' + (stats.events || 0) + ' 条 · 提醒 ' + (stats.reminders || 0) +
          ' 个 · 待发 ' + (stats.pendingDue || 0) + ' 条' +
          (today
            ? ' · 今天 进行中 ' + todayCounts.ongoing + ' 条 / 未开始 ' + todayCounts.upcoming +
              ' 条 / 已完成 ' + todayCounts.done + ' 条'
            : ''))
      : h('p', NOTE, '统计加载中……'),

    // ---- 今日时间轴 ----
    h('h4', { style: { margin: '14px 0 4px' } }, '今日时间轴'),
    renderList(today, false),

    // ---- 未来 7 天 ----
    h('h4', { style: { margin: '16px 0 4px' } }, '未来 7 天'),
    weekGroups().length === 0
      ? h('p', NOTE, '接下来 7 天没有安排。')
      : h('div', null, weekGroups().map((group) =>
          h('div', { key: group.key, style: { marginTop: 6 } },
            h('div', { className: 'ab-note', style: { fontSize: 12, fontWeight: 600 } },
              group.key + '（' + group.items.length + ' 条）' + (group.items.length > MAX_PER_DAY ? '，只显示前 ' + MAX_PER_DAY + ' 条' : '')),
            renderList(group.items.slice(0, MAX_PER_DAY), false),
          ))),

    // ---- 新建日程 ----
    h('h4', { style: { margin: '16px 0 4px' } }, '新建日程'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' } },
      h('div', { style: { ...FIELD, flex: 2, minWidth: 160 } },
        h('span', { style: LABEL }, '标题'),
        h('input', {
          className: 'ab-input',
          value: form.title,
          placeholder: '例如：周会 / 午睡 / 复诊',
          onChange: (e) => setField('title', e.target.value),
        })),
      h('div', { style: FIELD },
        h('span', { style: LABEL }, '日期'),
        h('input', { className: 'ab-input', type: 'date', value: form.date, onChange: (e) => setField('date', e.target.value) })),
      h('div', { style: FIELD },
        h('span', { style: LABEL }, '开始'),
        h('input', { className: 'ab-input', type: 'time', value: form.time, onChange: (e) => setField('time', e.target.value) })),
      h('div', { style: FIELD },
        h('span', { style: LABEL }, '时长（分钟）'),
        h('input', {
          className: 'ab-input',
          type: 'number',
          min: 1,
          max: 1440,
          value: form.duration,
          onChange: (e) => setField('duration', e.target.value),
        })),
      h('div', { style: FIELD },
        h('span', { style: LABEL }, '重复'),
        h('select', { className: 'ab-input', value: form.repeat, onChange: (e) => setField('repeat', e.target.value) },
          REPEAT_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)))),
      h('div', { style: FIELD },
        h('span', { style: LABEL }, '次数（可空）'),
        h('input', {
          className: 'ab-input',
          type: 'number',
          min: 1,
          value: form.count,
          placeholder: '不限',
          onChange: (e) => setField('count', e.target.value),
        })),
      h('div', { style: FIELD },
        h('span', { style: LABEL }, '提醒提前（分钟）'),
        h('input', {
          className: 'ab-input',
          type: 'number',
          min: 0,
          max: 1440,
          value: form.lead,
          onChange: (e) => setField('lead', e.target.value),
        })),
      h('div', { style: { ...FIELD, flex: 2, minWidth: 170 } },
        h('span', { style: LABEL }, '类型'),
        h('select', { className: 'ab-input', value: form.kind, onChange: (e) => setField('kind', e.target.value) },
          KIND_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)))),
      h('div', { style: { ...FIELD, flex: 1, minWidth: 120 } },
        h('span', { style: LABEL }, '在场'),
        h('input', {
          className: 'ab-input',
          value: form.presence,
          placeholder: '可空',
          onChange: (e) => setField('presence', e.target.value),
        })),
    ),
    h('div', { style: { marginTop: 8 } },
      h(ui.Btn, { onClick: createEvent, disabled: busy === 'save' }, busy === 'save' ? '提交中……' : '登记日程'),
      h(ui.Btn, { onClick: reload, style: { marginLeft: 8 } }, '刷新列表'),
      h('span', { className: 'ab-note', style: { marginLeft: 10, fontSize: 12 } },
        '提醒提前量默认用设置里的默认提前量，0 表示到点提醒；角色自己用工具登记的日程会显示「待确认」，确认由这里或主人自己说。')),

    // ---- 设置一览（表单在模块自己的设置页，这里只显示当前值）----
    h('h4', { style: { margin: '16px 0 4px' } }, '当前设置'),
    h('div', { className: 'ab-note', style: { display: 'flex', flexWrap: 'wrap', gap: '4px 18px', lineHeight: 1.9 } },
      Object.keys(SETTING_LABELS).map((key) => h('span', { key },
        h('span', { style: { opacity: 0.65 } }, SETTING_LABELS[key] + '：'),
        String(cfg[key] === undefined ? '（默认）' : cfg[key] === '' ? '（留空）' : cfg[key])),
      )),
    h('p', { ...NOTE, style: { margin: '4px 0', fontSize: 12 } },
      '要改这些值，用本页下方的模块设置表单；改完立刻生效，只有扫描间隔需要重新加载模块。'),
  ))
}
