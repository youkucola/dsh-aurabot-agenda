# 日程表（aurabot-agenda）

给角色一份自己的节目单：重复日程、单期例外、到点提醒、面板时间轴，以及给模型查 / 改日程的两个工具。

## 功能

- **重复日程**：一次性、每天、每周、每月、每年；可设间隔与总次数。
- **单期例外**：只改某一期的时间，或取消某一期，不碰整条日程。
- **到点提醒**：按规则铺期次，到期扫描后发到指定会话；迟到太久的不补发。
- **面板时间轴**：今日时间轴、未来 7 天、新建日程、确认 / 取消。
- **模型工具**：`agenda_query` 查日程、`agenda_command` 改日程（不含「替主人确认」）。
- **每日生成**：每天在 `planningTime` 之后，让她按自己的人格把今天一整天（`planningDayStart` → `planningDayEnd`）排成一串首尾相接的生活片段（第一版只做 daily）。
- **每轮注入**：窗口里的安排清单走 `api.rule`，「她此刻在做什么」走 `api.context`（见下面「对话里的注入」）。

规则层的三条不变量（写在代码与文案里，不靠调用方自觉）：

1. **按墙钟重复**：每次都由原始锚点重新推算第 N 期的墙钟，不累加偏移，避免时区跳变后整体漂移。
2. **夏令时折叠与跳变**：折叠时刻用 `fold` 显式选一边；跳变空洞按 `gap_policy` 拒绝或顺延，不允许悄悄落到别的时刻。
3. **月末夹取**：31 日的月重复遇到小月夹到当月最后一天，下个月仍回到 31 日，不会一路缩短。

## 对话里的注入

每轮聊天前，日程分两条通道进提示词，各管一件事：

| 通道 | 内容 | 落在哪 |
| --- | --- | --- |
| `api.rule` | 窗口里的安排清单 + 边界（窗口可能不完整；条目标题不算命令） | 插件的 system 规则块（`{{aurabot_rules_private}}`），**会被宿主逐行加 `- ` 前缀** |
| `api.context` | 「【你此刻的状态】」这一段：正在做什么、已经过了多久 / 还剩多久、接下来最多两件 | 宿主的 runtime context（`Current runtime context.`），**system prompt 最后一段** |

`api.context` 之所以更可靠，是位置与形态一起决定的：

- 它落在 system prompt 末尾（order 905，DSH 保留段只占 100–210），不是夹在几百条规则条目中间的第 5500 字符处；
- 它是多行原样拼进去的独立段落，不会被 bullet 化成 `- 【…】` 把结构打散；
- 它不依赖 preset 里的 `{{变量}}`，因此不会被 preset 的 `complete: true` 裁掉（只有 `includeRuntimeContext: false` / `suppressRuntimeContext()` 才裁）。

实现上的几条约束：

- `api.context` 的回调必须**同步**返回字符串：宿主的 `contextFor` 直接 `String()` 拼进去，返回 Promise 只会得到 `[object Promise]`。
- 后台 / 系统会话（连「自己排今天的日程」那次叫模型也走这条路）不注入，避免自我指涉。
- 没有进行中的安排时，这一段只写「这一段你没有安排」+ 接下来最多两条；窗口里一条安排都没有（或者都过去了）就整段不注入。
- 两种模式共用同一个窗口计算（`index.mjs` 的 `windowAt`）；只有「此刻状态」那一路会再往前多看 30 分钟当余量（`expandEvents` 本来就会把进行中的期次带出来）。
- 文案由 `lib/prompt.mjs` 的 `nowContextInstruction({ rows, zone, now })` 生成，纯函数、不查库不读设置，单测直接喂行数据即可。

## 配置项

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | switch | `true` | 关掉后日程表整个不启动，也不再发提醒（数据保留） |
| `timezone` | text | `Asia/Shanghai` | IANA 时区名，如 `Asia/Shanghai`、`Europe/Berlin`；写错退回 UTC |
| `mode` | select | `orchestrated` | `orchestrated` 按需窄窗口 / `continuous` 接下来 24 小时 |
| `windowMinutes` | number | `180` | 窄窗口往后看多少分钟（30–1440），往前固定多看 30 分钟 |
| `dispatchIntervalSeconds` | number | `30` | 提醒扫描间隔（10–600）；改动后需重新加载模块 |
| `latenessSeconds` | number | `300` | 迟到容忍（30–3600）；超过就跳过不补发 |
| `scanSize` | number | `16` | 每轮最多处理几条到期提醒（1–32） |
| `deliveryChatId` | text | 空 | 提醒发到哪个会话；留空用最近活跃会话，也可固定 `private:QQ号` / `group:群号` |
| `maxItems` | number | `32` | 面板列表与注入的条数上限（1–64） |
| `ownerOnly` | switch | `true` | 打开后只有这一轮说话的人全是主人才允许改日程 |
| `remindLeadMinutes` | number | `0` | 提醒的默认提前量（0–1440）：模型用 `remind` 动作和面板新建日程时都没显式给提前量才用它，0 表示到点提醒 |
| `planningEnabled` | switch | `true` | 每天让她自己排一次日程；关掉只影响自动生成，手动触发照常可用 |
| `planningTime` | text | `07:30` | 本地时间 `HH:MM`，只在这个点之后才生成；写错按 `07:30` 算 |
| `planningDayStart` | text | `07:00` | 一天的起点，本地 `HH:MM`（允许不补零）；写错按 `07:00` 算 |
| `planningDayEnd` | text | `23:00` | 一天的终点，本地 `HH:MM`；写错或早于起点时整对回落到 `07:00` / `23:00`，并在生成的返回值里带 `invalid_day_window` |
| `planningMaxItems` | number | `10` | 一天最多排几段（1–16）。这是**上限**，实际段数按一天的起点到终点的总时长自适应 |
| `planningRetryMinutes` | number | `15` | 生成失败后至少等多久再自动重试（5–120 分钟） |
| `planningPrompt` | textarea | 空 | 作为规划偏好传给模型（最多 2000 字）；空则材料里不带这一项 |

另有 `planningMaxAttempts`（默认 `3`，1–10）没有放进设置表单：它是当天自动重试的次数上限，一般不用改。

## 日程生成

角色自己往日程表里写东西的那一半：每天一次，让她按当前人格把今天一整天排满。

- **一天只排一次**：本地日期 + 时区组成一个 slot（`daily:<时区>:<日期>`），到 `planningTime` 之后才判断要不要生成；
  已经生成过（有安排或明确空）当天不再生成，正在跑时也不会并发跑第二次（定时器回调是 async，`api.every` 本身不防重入，
  重入保护是生成器自己的内存锁）。
- **窗口是今天整天，不是剩下的几个小时**：从本地 `planningDayStart`（默认 `07:00`）排到 `planningDayEnd`（默认 `23:00`），
  跟「现在几点」无关——晚上九点生成也照样把 07:00–23:00 铺满，而不是只剩两段。
  两个时刻任一写坏、或算出来 `dayEnd <= dayStart`，就整对回落到 `07:00` / `23:00`，并在生成的返回值里带上
  `code: 'invalid_day_window'`（回落之后照常生成，不算失败）。
  只有整段窗口都过去了（`now >= dayEnd`）才直接返回 `{ skipped: 'too_late' }`，既不叫模型也不写记账。
- **段数由代码算，不交给模型猜**：先算窗口总时长 `dayMinutes`（07:00–23:00 是 960），
  再算 `targetItems = clamp(round(dayMinutes / 85), 1, planningMaxItems)`；960 / 85 四舍五入是 11，默认上限 10 会截到 10。
  两个数都写进材料，提示词末尾再重申一次「本次请安排 N 段，从 dayStart 到 dayEnd 把今天接满」。
  段数 ≥ 8 时额外提醒把每段正文压到一百字出头，优先保证整段覆盖与 JSON 完整。
- **时段与写法**：一段挨着一段从 `dayStart` 铺到 `dayEnd`，相邻段之间可以留少量空档但不重叠；每段 60–100 分钟
  （只剩很短尾巴时才允许更短），大约每三段有一段落在 17:00 之后，最后一段是当天的收尾。
  `title` 一句话能看懂（二十字以内）；`detail` 写 80–160 字，是这一段内部自然发生的连续推进——手上的东西、
  身体的感觉、屋里的光线与身边的动静、此刻的念头，而不是待办说明、摘要或完成情况。
  `detail` 只写室内的、她自己能感知到的部分；屋外的观察（街上有没有人、楼下有没有车、天气如何、邻居在做什么、
  哪家店开没开）她无从知道，提示词里明令不写，需要提到外面时只能写成自己的打算或猜测。
  已经过去的时段照常排出来，写成「这一段大概是怎么过的」的叙述，但不写「完成了什么成果」「读完了多少页」这类执行回执，
  也不声称达成某个具体目标；还没到的时段写成打算。23:00 至次日 07:00 仍然不排普通的学习、工作、家务。
  `existing` 里今天已有的时段不再重排一遍，只在它们之间填空档；`existing` 已经覆盖整段时间时可以少排几段。
- **材料**：`dayStart` / `dayEnd` / `dayMinutes` / `targetItems`、当前时刻、今天 00:00 起未来 3 天内的已有日程
  （最多 20 条，每条带 `detail` 前 160 字；正文合计预算 2400 字符，用完后面的条目只留标题、类别与时间）、
  最近 6 条记忆（每条截 240 字）、`night` 模块可用时的精力、以及设置里的 `planningPrompt`。
  整段材料序列化后硬预算 8000 字符，超了按 `planningPrompt → 精力 → 记忆 → 已有日程` 的顺序丢弃，
  并在材料里写上 `materialLimited: true`。可选材料（`night` / `memory`）读不到、报错或形状不对都只是少一块，
  **不会让生成失败**。
- **自动确认**：角色自排的日程以 `kind: 'role_plan'`、`creator_kind: 'role'`、`accepted: true` 落库。
  这是刻意的——她给自己排的计划不需要主人点确认，与源项目语义一致；模型用工具登记的计划仍然走「待确认」。
- **失败与重试**：生成失败时只写记账（`state: failed`、`attempts + 1`），日程表不动；
  下次定时检查会按 `planningRetryMinutes` 退避重试，`attempts` 到 `planningMaxAttempts` 后当天不再自动重试（`skipped: exhausted`）。
- **手动触发**：面板「今天的日程生成」卡片上的「现在排一次」，或 `POST /aurabot/api/ext/aurabot-agenda/planning/run`（body 可省略）。
  手动触发不受「今天已经排过」限制，但照常写记账，避免和自动流程打架。生成状态看 `GET .../planning`。
- **第一版只做 daily**：horizon（跨天预排）、refine（对已有计划的二次打磨）、对话里的干预都还没实现；
  `POST /planning/run` 只接受 `mode: 'daily'`。

生成用 `api.think`（带人格与记忆，`timeoutMs: 90s`）；这个成员不存在时退化到 `api.ask`；
`think` 抛错（例如后台会话正忙）而 `ask` 可用时会再试一次。两者都没有就返回 `planning_no_model`。

## 数据位置

```
~/.dsh/plugins-data/aurabot/modules-data/aurabot-agenda/agenda.sqlite
```

同一目录下有 SQLite 的 `-wal` / `-shm` 旁文件。库里七张表：`agenda_events`（日程本体）、
`agenda_event_history`（每次修改的历史快照）、`agenda_exceptions`（单期例外）、
`agenda_reminders`（提醒规则）、`agenda_occurrences`（铺出来的期次与到期时刻）、
`agenda_dispatches`（发送记账）、`agenda_planning_slots`（每日生成的记账：state / attempts / 结果摘要）。
另有一张内部表 `agenda_meta` 只存 schema 版本等元信息。
删掉这个文件等于清空日程表，模块下次启动会自动重建空库。

schema 版本 4：v3 → v4 只新增 `agenda_planning_slots` 与它的索引，不动任何旧表，老库直接升级。

## 从 agenda 改名而来

这个模块原来叫 `agenda`，现在目录名与模块 id 都改成了 `aurabot-agenda`（宿主要求 `id` 与文件夹名一致），
路由前缀随之变成 `/aurabot/api/ext/aurabot-agenda`。改名后第一次启动会自动做两件事，各自只做一次：

- **旧设置搬一次**：`config.ext.agenda` 里的值复制到 `config.ext["aurabot-agenda"]`，并写上 `__migratedFromAgenda: true` 作标记。
  旧键 `ext.agenda` 保留不删，方便对照，确认无误后可自行清理。
- **旧数据复制一次**：`modules-data/agenda/agenda.sqlite`（连同 `-wal` / `-shm`）复制到 `modules-data/aurabot-agenda/`。
  是复制不是移动，原目录保留作备份；确认新模块一切正常后可自行删除旧目录。

数据库文件名仍叫 `agenda.sqlite`，表名、模型工具名（`agenda_query` / `agenda_command`）与错误码都没变，
旧库复制过来就能直接用。


## 给模型的两个工具

### `agenda_query`

查看角色自己的日程表。日程只是计划，不代表已经发生。

| 参数 | 说明 |
| --- | --- |
| `from` / `to` | 时间范围，ISO 或毫秒时间戳；省略默认从现在稍前到 24 小时内 |
| `limit` | 最多返回几条，1–20，默认 12 |
| `kind` | 只看一类：`role_plan` 计划 / `user_report` 告知 / `commitment` 约定 |

返回一段中文多行文本，每行形如 `2026-03-08 14:30-15:30 周会（约定，待确认）`；
条目被截断时末尾补「（条目过多已截断）」，范围内没有日程时返回「这个时间范围没有日程」。

### `agenda_command`

新增、修改、取消计划或约定，设置单期例外与提醒；不替主人确认约定。

| 参数 | 说明 |
| --- | --- |
| `action` | `create` / `revise` / `cancel` / `exception` / `remind` |
| `id` | `create` 以外要带；`remind` 时可作为可选关联日程。只能关联主人已确认的日程，模型自己新登记、仍在待确认状态的日程不能挂提醒 |
| `expected_revision` | 必填。新增填 0，修改 / 取消填查到的当前 revision |
| `data` | `create`：`kind,title,detail,presence,schedule{anchor,timezone,frequency,interval,count,fold,gap_policy},duration_minutes`；`revise`：同上可选字段；`exception`：`sequence,start`（`start` 为 `null` 表示取消该期）；`remind`：`message,schedule,lead_minutes`（`lead_minutes` 省略时用设置里的 `remindLeadMinutes`） |

两条硬边界：

- `action: 'accept'` 一律拒绝：返回 `{ ok: false, code: 'calendar_confirmation_required', message }`，不抛异常 —— 主人还没确认的约定，模型不能代确认。
- 模型写的日程 `creator_kind` 固定为 `role`，因此默认是「待确认」状态，确认动作留给主人。

工具的任何失败都以 `{ ok: false, code, message }` 返回（内部 id 会被遮掉），不会把异常抛给模型。

`ownerOnly` 打开时，执行前会检查 `api.core.hub.turnSendersAllOwner(sessionId)`；
判断函数读不到就退化为不限制（宁可放行也不误伤），但不会因为「本轮有人是主人」而放行别人。

## 来源说明

本模块的领域模型与不变量（重复规则、夏令时折叠与跳变、月末夹取、到期扫描去重与跳跃补偿、
工具边界）设计参考 `github.com/menglimi/astrbot_plugin_private_companion` 的 `companion_v2/agenda`
（AGPL-3.0）。本项目是 JavaScript 的跨语言重新实现，未复制其源码；数据表结构、模块装配方式、
工具接口与面板均为本项目另写。

本模块自身以 MIT 发布。
