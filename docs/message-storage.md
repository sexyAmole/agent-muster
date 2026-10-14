# 会话与消息存储规范

本文规定 Agent Muster 当前的消息记录格式、模块职责和读写行为，适用于所有 Agent 及 Web、钉钉、飞书入口。类型定义以 `src/types.ts` 为准；格式变更时应同步更新本文和迁移逻辑。

## 1. 基本原则

- 会话元信息、业务事件、Agent 原始日志分别处理，通过各自的存储入口写入。
- Agent 协议解析、噪声过滤、协议相关去重和流式内容整理归属 adapters；文件读写、分页和迁移归属 SessionStore。
- 正常运行时，持久历史采用追加写入。元信息变化追加完整快照，推送状态变化追加标记，不原地修改已有消息。
- 原始日志保留解析前的内容，标准事件供业务和界面使用。原始数据与派生事件允许同时保存，通过 `rawRecordId` 关联。
- IM 平台统一使用 `im` 字段，通过 `platform` 区分；不得继续新增平台专属的会话顶层字段或消息类型。
- 内存事件列表是缓存，不能代替持久历史。完整查询和 IM 推送读取必须通过存储接口。

## 2. 模块职责

| 模块 | 职责 | 不应承担的职责 |
| --- | --- | --- |
| `src/agents/adapters.ts` | Agent 适配器注册与统一导出 | 实现具体 Agent 协议 |
| `src/agents/adapters/<agent>.ts` | 启动参数、协议解析、去重及流式整理 | 文件读写、项目筛选、历史分页 |
| `src/agents/adapters/shared.ts` | 共享类型、解析工具、标准事件归一化与通道处理 | 实现具体 Agent 协议 |
| `src/sessions/manager.ts` | 会话生命周期、事件编号、原始记录关联、用量累计、缓存及广播 | 解析各 Agent 的原生消息结构 |
| `src/sessions/store.ts` | 文件定位、追加写入、历史读取、推送标记合并、快照恢复及迁移 | 执行 Agent、调用 IM SDK、决定界面布局 |
| `src/sessions/events.ts` | 按流标识合并事件及按展示顺序排序 | 解析协议或访问文件 |
| `src/integrations/*/bridge.ts` | 平台消息转换、会话路由、平台回复 | 直接写入会话 JSONL |
| 前端 | 消费共享类型、替换流式快照、按界面用途展示事件 | 自行解析 Agent 原生 stdout |

Adapter 对外返回 `AdapterResult`，消息内容统一位于 `events: AgentEvent[]`。`externalSessionId`、`settled`、`aborted`、`failed` 和 `clearStreamIds` 是执行控制信息，`skipRawLog` 控制当前原始行是否保存。Adapter 内部的 `ParsedResult` 不属于持久格式或前端接口。

所有协议适配器统一实现 `createReader()`，每次执行创建独立的逐行解析函数。可选的 `createRawReader()` 创建原始数据块解析函数，接收 UTF-8 解码后的文本块和 `stdout`/`stderr` 通道；在分行前调用，不等待 LF，不执行 `trim()`。数据块边界由进程输出决定，不保证是完整协议消息；适配器负责缓存、拼接和去重。

原始数据块解析结果同样经过标准事件归一化、存储和推送流程；可通过 `streamId` 输出流式快照，并由逐行解析返回同一标识的完成事件。此时原始行可能尚未形成，派生事件可以没有 `rawRecordId`，首次出现的事件编号用于展示排序。原始日志仍按行保存；新增入口不会将全部原始日志直接推送到 Web。

## 3. 目录与文件

默认数据目录为 `~/.agent-muster/`，SessionStore 支持通过构造参数指定隔离目录。

```text
~/.agent-muster/
├── projects/
│   └── <项目标识>/
│       ├── project.json
│       └── sessions/
│           ├── <会话标识>.jsonl
│           ├── <会话标识>.raw.jsonl
│           └── <会话标识>.jsonl.pending
└── images/
    └── <图片 UUID>.<扩展名>
```

| 文件 | 内容与格式 |
| --- | --- |
| `project.json` | JSON 对象，`path` 为项目路径 |
| `<会话标识>.jsonl` | 会话元信息快照、已持久化业务事件、IM 推送标记 |
| `<会话标识>.raw.jsonl` | 新写入的 `raw_stdout`、`raw_stderr` 事件；没有原始日志时可以不存在 |
| `<会话标识>.jsonl.pending` | 未完成流式事件的 JSON 数组，不是 JSONL；没有未完成内容时删除 |

项目标识为 `SHA-256(resolve(cwd))` 的十六进制字符串。新建本地会话 ID 为 `ses_<UUID>`，文件名使用 `encodeURIComponent(session.id)`。Agent 的 `externalSessionId` 仅用于续聊，不作为本地文件名。

JSONL 使用 UTF-8，每行一个 JSON 对象，并以 LF 结尾。文本中的换行由 JSON 序列化转义。不得直接向文件追加未经序列化的消息正文。

当前采用双文件历史存储，未采用单文件原始事件重放模型；旧数据导入后，主文件中仍可能存在原始事件，读取时须保留。

## 4. 主文件记录

### 4.1 会话元信息

记录类型为 `{ type: 'session' } & Omit<AgentSession, 'events'>`。其中 `id` 是字符串会话 ID，与事件的数字 ID 不同。

```json
{"type":"session","id":"ses_example","agent":"codex","cwd":"/workspace/demo","prompt":"查看项目结构","status":"running","createdAt":1791800000000,"updatedAt":1791800000100,"externalSessionId":"agent-session-example"}
```

元信息包含会话身份、项目路径、首次提示词、模型、状态、时间戳以及可选的 IM 绑定、用量、外部会话 ID 和进程 ID。不得嵌入 `events` 数组。

`saveMetadata()` 比较除 `updatedAt` 外的元信息；内容变化才追加快照。仅更新时间变化不产生新快照。加载时读取最后一份快照，并结合其后的主文件事件时间恢复 `updatedAt`；原始日志文件的时间不参与这一步。

### 4.2 业务事件

| 字段 | 约定 |
| --- | --- |
| `id` | 会话内数字事件编号，与原始日志共用编号空间；客户端不得假设连续 |
| `type` | 标准事件类型，见下表 |
| `text` | 必填字符串；具体含义由 `type` 决定 |
| `timestamp` | 服务端创建事件时的 Unix 毫秒时间戳 |
| `rawRecordId` | 可选，产生该事件的原始日志 ID；多个事件可以引用同一原始记录 |
| `detail` | 可选详情字符串，可以是正文、JSON 字符串或 diff，不能统一假设为 JSON |
| `streamId` | 可选，同一执行中同一流式内容块的稳定标识 |
| `order`、`contentIndex` | 可选，控制展示顺序及内容块位置 |
| `streaming` | `true` 表示未完成快照；`false` 表示已结束；普通事件可以省略 |
| `clearStreamIds` | 可选，需要清除的未完成内容块标识，由状态事件携带 |
| `kind`、`comparison` | 可选，文件变更类型及 diff 比较基准 |
| `im` | 可选，该事件的 IM 平台上下文 |
| `images` | 可选图片引用，只保存 `path` 和 `mimeType` |
| `pushedToIm` | 可选，读取历史或运行时更新得到的推送状态 |

| `type` | `text` 的含义 |
| --- | --- |
| `message` | 用户输入，也是历史分页的轮次边界；IM 用户输入同样使用此类型 |
| `system` | 系统信息 |
| `thinking` | 思考内容 |
| `output` | 助手回复 |
| `tool` | 工具名称或命令，参数和结果放在 `detail` |
| `file_change` | 文件路径；`detail` 可包含 diff |
| `usage` | 当前会话用量对象的 JSON 字符串，包含 `inputTokens`、`outputTokens` |
| `status` | `starting`、`running`、`waiting`、`completed`、`failed` 或 `stopped` |
| `error`、`warning` | 错误或警告信息；事件类型本身不等同于最终执行状态 |
| `im_message` | 应用侧记录的 IM 消息内容，平台由 `im.platform` 指定 |

新写入的普通 `text` 最长保留 50,000 个 JavaScript 字符串代码单元；`system` 和带 `streamId` 的内容不受此截断。`detail` 同样截断至 50,000，`system` 和 `tool` 详情除外。原始日志不执行这些截断。

### 4.3 IM 推送标记

```json
{"type":"im_pushed","eventId":3}
```

`eventId` 指向已存在的 `output` 事件。标记自身不分配事件 ID，也不作为独立消息返回。读取历史、单事件及增量记录时，将标记合并为目标事件的 `pushedToIm: true`。

手动推送应在平台发送成功后记录标记；更新时广播原事件 ID，不创建新的助手回复。当前标记是事件级布尔状态，**不区分目标平台或应用**，不能据此判断每个平台分别是否收到消息。自动 IM 回复目前不自动写入此标记，也不自动生成 `im_message`。

## 5. 原始日志与写入流程

原始日志使用 `SessionEvent` 结构，`type` 仅为 `raw_stdout` 或 `raw_stderr`。`text` 保存 UTF-8 解码、按 LF 分行后的原文，不包含分隔符 LF；CR 等其余字符按原样保留。输入结束时的最后一段非空内容即使没有 LF，也会形成一条记录。

适配器可通过 `skipRawLog` 指示跳过当前原始行的保存，业务事件仍正常解析和写入。Pi 的 user/system 消息仅保留 `message_start` 原始记录，不保存该消息的 `message_update` 和 `message_end`；system 业务事件仍从 `message_end` 提取，assistant 消息的原始记录保持完整。

```json
{"id":2,"type":"raw_stdout","text":"{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"项目包含服务端和前端。\"}}","timestamp":1791800000200}
```

对应的业务事件写入主文件：

```json
{"id":3,"type":"output","text":"项目包含服务端和前端。","rawRecordId":2,"timestamp":1791800000201}
```

处理顺序如下：

1. `recordRaw()` 为原始行分配 ID，保存必要的元信息，调用 `appendRaw()`，更新缓存并广播。
2. 将原始行交给当前执行实例的 adapter reader。stdout 解析前会 `trim()`，已保存的原始文本不受影响。
3. Adapter 输出标准事件与执行控制信息；被过滤的内容仍保留原始日志。
4. `recordResult()` 更新会话状态数据、累计用量，并为派生事件关联 `rawRecordId`。
5. 普通业务事件通过 `append()` 分配 ID，保存元信息，再调用 `appendEvent()`，最后更新缓存并广播。
6. 流式未完成事件只更新缓存及广播，按下一节规则保存快照。

`saveMetadata()` 必须先于该会话首次事件写入，以建立文件映射。`appendEvent()` 和 `appendRaw()` 的调用方负责传入正确类型；当前 Store 方法签名没有分别限制两类事件。

元信息、原始日志和业务事件的写入是独立操作，不构成跨文件事务。当前 Manager 会记录存储异常并继续处理，因此收到 SSE 不能视为持久化成功确认。

## 6. 流式事件与恢复

- 每次启动 Agent 都创建独立 reader 和执行 UUID；对外 `streamId` 为 `<执行 UUID>:<adapter 内容块标识>`，避免续聊时重用标识。
- 流式事件的 `text` 是当前完整快照。消费者按 `streamId` 替换旧快照，不再次拼接；每次实际发布仍分配新的数字 ID。
- Manager 跳过文本、详情和内容块下标均未变化的未完成快照。
- `orderKey` 是 adapter 内部的分组标识，不直接落盘；Manager 将其首次出现时的原始记录 ID 映射为 `order`。
- 最终事件使用同一个 `streamId` 和 `streaming: false`，追加到主文件并替换内存预览。
- `clearStreamIds` 只清除相应的未完成预览，不删除已经持久化的最终事件。

执行期间每秒检查未完成事件，内容变化时先写 `.jsonl.pending.tmp`，再通过重命名替换 `.jsonl.pending`。收到最终流式事件或清理指令时也更新快照；没有未完成事件时删除快照文件。

进程关闭时，剩余预览以 `streaming: false` 追加到主文件，随后清理快照。这里的“结束”表示停止更新，不表示任务成功；成功与否读取会话状态。

服务启动时恢复遗留快照：跳过已有非流式最终记录的 `streamId`，其余内容使用大于已有历史最大 ID 的新编号追加，并保留原快照时间戳，最后删除快照。会话元信息中的 `running`、`starting` 会转换为 `stopped`，清除 `pid`。

突然退出可能丢失最近一次快照之后的预览。当前实现不会通过重新解析 `.raw.jsonl` 自动重建这些预览。

## 7. 历史读取、排序和 SSE

| 接口 | 行为 |
| --- | --- |
| `history(id)` | 读取全部持久事件，合并推送标记与流式内容块，并按展示顺序排序 |
| `history(id, limit, before)` | 从主文件倒序按用户输入轮数读取；`before` 为排他性数字事件游标 |
| `history(id, 0)` | 不读取事件，返回空列表和 `hasMore: false` |
| `getEvent(id, eventId)` | 查询已持久化的单个业务事件或原始记录，并合并推送状态 |
| `eventsAfter(id, after)` | 从两个文件合并读取 ID 大于 `after` 的持久事件；Manager 额外补发当前未完成预览 |

Web 分别请求会话元信息、对话历史和原始日志：

- `GET /sessions/:id` 仅返回会话元信息；创建、发送消息、停止和 IM 推送的响应也不包含事件。
- `GET /sessions/:id/messages` 返回对话历史，不包含原始日志。`limit` 范围为 0–100，表示用户输入轮数；省略时读取全部对话事件。未指定 `before` 且 `limit` 非零时，Manager 会合并当前流式预览；查询更早历史不附带预览。
- `GET /sessions/:id/logs` 独立读取原始日志，`limit` 范围为 1–100，表示日志条数，`before` 为排他性事件 ID 游标。日志面板打开时读取最新记录，支持加载更早日志；不随实时事件更新。
- `GET /sessions/:id/events` 的历史补发和实时推送均排除 `raw_stdout`、`raw_stderr`，对话内容和状态继续实时更新。

Store 内部历史读取默认保留原始日志，以维持会话恢复及事件编号；Manager 的对话历史读取关闭原始日志。

展示事件的合并与排序规则：

1. 带 `streamId` 的事件按该字段合并，后提供的快照覆盖前一份；普通事件按 `id` 合并。
2. 先比较 `order ?? id`，再比较 `contentIndex ?? 0`，最后比较 `id`。
3. 展示顺序可能不同于数字 ID 顺序。客户端不能把数组最后一项直接视为最大的事件游标。

SSE 的 `data` 为单个 `SessionEvent`，`id` 为本连接已发送事件 ID 的最大值。重连游标取 `after` 与 `Last-Event-ID` 的较大值。补发的未完成预览可以不大于游标，必须先按 `streamId` 处理，不能仅因 ID 较小而丢弃。

推送状态更新会复用旧事件 ID，消费者必须允许更新既有事件。`im_pushed` 标记本身没有增量游标；如果断线期间目标事件已落在游标之前，仅重放新增事件不能补齐该标记，应重新查询相关历史或单事件。

运行时缓存保留最近 50 条事件以及更早的未完成预览；启动时预加载最近 10 轮历史。缓存大小不代表持久历史长度。

## 8. IM 上下文

会话的 `im` 为 `ImBinding[]`，当前每个平台最多保留一个绑定。同一平台再次绑定时更新应用及提供的会话信息；不同平台可以并存。

```json
[
  {"platform":"dingtalk","appId":"ding-example","conversation":{"type":"group","groupName":"示例群","senderName":"示例用户","senderStaffId":"staff-example"}},
  {"platform":"feishu","appId":"feishu-example","conversation":{"type":"single","senderId":"sender-example"}}
]
```

消息的 `im` 为单个 `ImContext`，描述该条消息的来源；会话绑定中的 conversation 则是该平台最近更新的上下文，不能替代历史消息来源。

| 平台 | `conversation` 字段 |
| --- | --- |
| `dingtalk` | `type: 'single' \| 'group'`、`senderName`、`senderStaffId`，以及可选 `groupName` |
| `feishu` | `type: 'single' \| 'group'`、`senderId` |

`conversation` 可以省略，例如启动时只恢复应用绑定。消息来源契约不要求 `appId`；当前创建和续聊路径传入完整 binding 时，序列化数据可能额外包含该字段，消费者不应依赖其必然存在。

应用凭证、Webhook 等不属于上述绑定格式，不得作为新增业务字段写入消息记录。原始日志和消息正文可能包含敏感内容，排查问题时不得直接公开完整文件。

## 9. 图片引用

消息只持久化图片的 `path` 与 `mimeType`，不保存运行时使用的 Base64 `data`。Store 管理的图片使用 UUID 文件名，支持 PNG、JPEG、GIF、WebP，并校验文件内容与 MIME 类型一致。

图片是独立文件。复制或迁移会话文件时，应同时处理所引用的图片路径；仅复制 JSONL 不能保证图片仍可读取。当前删除会话不会自动删除图片文件。

## 10. 迁移与删除

迁移在 Store 加载历史时执行，当前覆盖旧 SQLite、会话 JSON 文件、旧项目目录布局、旧 `{ session, event, pushedEventId }` 行格式及平台专属 IM 字段。

IM 字段转换规则：

| 旧字段或类型 | 新字段或类型 |
| --- | --- |
| `dingtalkAppId`、`dingtalkConversation` | 会话 `im` 中 `platform: 'dingtalk'` 的绑定 |
| `feishuAppId`、`feishuConversation` | 会话 `im` 中 `platform: 'feishu'` 的绑定 |
| 事件 `dingtalkConversation`、`feishuConversation` | 事件 `im` 上下文 |
| `dingtalk_message`、`feishu_message` | `im_message`，原平台写入 `im.platform` |

JSONL 行格式迁移先写临时文件，保存原文件为带时间戳的 `.bak`，再重命名替换。新格式无需重复重写；不得通过读取失败后清空历史来处理格式异常。

删除运行中的会话时先停止进程并等待关闭，再删除主文件、原始日志和 pending 快照。迁移备份及图片文件不在当前会话删除范围内。

## 11. 当前边界与变更要求

当前实现没有多进程文件锁、跨文件事务、`fsync` 持久性承诺或损坏尾行自动修复。JSONL 行解析失败会抛错；存储不是严格的“恰好一次”消息队列。不要让多个服务实例同时写入同一数据目录。

落盘格式尚无统一版本字段。新增格式版本、单文件存储、仅保存原始记录后重放、按平台记录送达状态，都属于独立格式变更，不能视为本文已实现的行为。

后续修改应满足：

- 保持本地会话 ID、事件 ID、原始记录关联与流式标识的语义；客户端不依赖编号连续。
- 保留完整历史、分页边界、展示顺序、续聊信息和 IM 来源；涉及格式不兼容时提供明确迁移。
- 区分“任务结束”“消息已展示”“已写入文件”“IM 已发送”，不得用一个状态替代全部含义。
- 新增 Agent 或 IM 平台时，优先扩展对应 adapter 或联合类型，避免在 Store 和前端增加原生协议分支。
- 修改实现后检查创建、续聊、停止、流式完成、中断恢复、分页、单事件读取、SSE 重连和推送标记，并执行 `pnpm typecheck`、`pnpm build`。

## 12. 实现索引

- [共享类型](../src/types.ts)
- [Agent 适配器](../src/agents/adapters.ts)
- [会话业务处理](../src/sessions/manager.ts)
- [文件存储与迁移](../src/sessions/store.ts)
- [事件合并与排序](../src/sessions/events.ts)
- [HTTP 与 SSE 路由](../src/server/routes/sessions.ts)
