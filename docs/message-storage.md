# 会话与消息存储规范

本文规定 Agent Muster 当前的消息记录格式、模块职责和读写行为，适用于所有 Agent 及 Web、钉钉、飞书入口。接口类型定义以 `src/types.ts` 为准，磁盘记录类型以 `src/sessions/records.ts` 为准；格式变更时应同步更新本文和迁移逻辑。

## 1. 基本原则

- 应用仅写入会话元信息、业务事件和未完成流式快照；运行日志直接读取 Agent 本地 JSONL 会话文件。
- Agent 协议解析、噪声过滤、协议相关去重和流式内容整理归属 adapters；文件读写、分页和迁移归属 SessionStore。
- 正常运行时，持久历史采用追加写入。初始会话信息写入一次，后续元信息仅追加差量；状态、用量从业务事件恢复，推送状态变化追加标记，不原地修改已有消息。
- stdout/stderr 仅用于协议解析，不再保存原始日志副本；标准事件供业务和界面使用。
- IM 平台统一使用 `im` 字段，通过 `platform` 区分；不得继续新增平台专属的会话顶层字段或消息类型。
- 内存事件列表是缓存，不能代替持久历史。完整查询和 IM 推送读取必须通过存储接口。

## 2. 模块职责

| 模块 | 职责 | 不应承担的职责 |
| --- | --- | --- |
| `src/agents/providers/index.ts` | Agent provider 注册与统一导出 | 实现具体 Agent 协议 |
| `src/agents/providers/<agent>.ts` | Agent 信息、安装规则、模型配置、日志定位、启动参数与协议解析 | 业务会话写入、项目筛选、历史分页 |
| `src/agents/providers/shared.ts` | 共享类型、解析工具、标准事件归一化与通道处理 | 实现具体 Agent 协议 |
| `src/agents/registry.ts` | 通用命令发现、版本检测与 provider 扫描 | 硬编码各 Agent 模型及配置规则 |
| `src/agents/management.ts` | 安装状态汇总、操作校验与 npm 安装执行 | 硬编码各 Agent 包名及专属安装流程 |
| `src/agents/session-logs.ts`、`src/agents/jsonl.ts` | JSONL 文件查找工具、只读访问与分页 | 硬编码各 Agent 会话目录 |
| `src/sessions/manager.ts` | 会话生命周期、事件编号、用量累计、缓存及广播 | 解析各 Agent 的原生消息结构 |
| `src/sessions/store.ts` | 文件定位、追加写入、历史读取、推送标记合并、快照恢复及迁移 | 执行 Agent、调用 IM SDK、决定界面布局 |
| `src/sessions/records.ts` | 磁盘记录类型、元信息差量、持久事件与接口事件转换 | 执行 Agent 或决定界面布局 |
| `src/sessions/events.ts` | 按流标识合并事件及按展示顺序排序 | 解析协议或访问文件 |
| `src/integrations/*/bridge.ts` | 平台消息转换、会话路由、平台回复 | 直接写入会话 JSONL |
| 前端 | 消费共享类型、替换流式快照、按界面用途展示事件 | 自行解析 Agent 原生 stdout |

Adapter 对外返回 `AdapterResult`，消息内容统一位于 `events: AgentEvent[]`。`externalSessionId`、`settled`、`aborted`、`failed` 和 `clearStreamIds` 是执行控制信息。可选的 `contextTokens` 表示 Agent 最近报告的上下文 Token 数，Manager 将其合入会话用量。Adapter 内部的 `ParsedResult` 不属于持久格式或前端接口。 Provider 标准事件仅包含 `output`、`thinking`、`tool`、`usage`、`error`、`warning`；原生 JSONL 日志按原文读取，不受业务事件类型限制。

所有协议适配器统一实现 `createReader()`，每次执行创建独立的逐行解析函数。可选的 `createRawReader()` 创建原始数据块解析函数，接收 UTF-8 解码后的文本块和 `stdout`/`stderr` 通道；在分行前调用，不等待 LF，不执行 `trim()`。数据块边界由进程输出决定，不保证是完整协议消息；适配器负责缓存、拼接和去重。

原始数据块解析结果同样经过标准事件归一化、存储和推送流程；可通过 `streamId` 输出流式快照，并由逐行解析返回同一标识的完成事件。首次出现的业务事件编号用于展示排序。新增入口不会保存或直接推送原始数据块。

## 3. 目录与文件

默认数据目录为 `~/.agent-muster/`，SessionStore 支持通过构造参数指定隔离目录。

```text
~/.agent-muster/
├── projects/
│   └── <项目标识>/
│       ├── project.json
│       └── sessions/
│           ├── <会话标识>.jsonl
│           └── <会话标识>.jsonl.pending
└── images/
    └── <图片 UUID>.<扩展名>
```

| 文件 | 内容与格式 |
| --- | --- |
| `project.json` | JSON 对象，`path` 为项目路径 |
| `<会话标识>.jsonl` | 单次会话初始信息、元信息差量、已持久化业务事件、IM 推送标记 |
| `<会话标识>.jsonl.pending` | 未完成流式事件的 JSON 数组，不是 JSONL；没有未完成内容时删除 |

项目标识为 `SHA-256(resolve(cwd))` 的十六进制字符串。新建本地会话 ID 为 `ses_<UUID>`，文件名使用 `encodeURIComponent(session.id)`。Agent 的 `externalSessionId` 用于续聊和定位 Agent 本地会话文件，不作为 Muster 业务文件名。

JSONL 使用 UTF-8，每行一个 JSON 对象，并以 LF 结尾。文本中的换行由 JSON 序列化转义。不得直接向文件追加未经序列化的消息正文。

原有 `.raw.jsonl` 文件不再写入或读取；主文件中的旧原始事件不进入对话历史。Agent 本地会话文件由 Agent 自身管理，应用只读访问。

## 4. 主文件记录

### 4.1 会话元信息

磁盘格式版本为 `2`。文件头是 `SessionHeader`，只写入一次：`{ type: 'session', formatVersion: 2 } & Omit<AgentSession, 'events' | 'pid'>`。其中 `id` 是字符串会话 ID，与事件的数字 ID 不同。

```jsonl
{"type":"session","formatVersion":2,"id":"ses_example","agent":"codex","cwd":"/workspace/demo","prompt":"查看项目结构","status":"starting","permissionMode":"full-auto","createdAt":1791800000000,"updatedAt":1791800000000}
{"type":"session_update","timestamp":1791800000100,"changes":{"externalSessionId":"agent-session-example"}}
{"type":"session_update","timestamp":1791800000200,"changes":{"model":"example-model","title":"查看项目结构"}}
{"type":"session_update","timestamp":1791800000300,"changes":{"model":null}}
```

文件头保存创建时的初始元信息，可以包含初始模型、IM 绑定及导入会话的初始状态和用量；不嵌入 `events`，不持久化运行时 `pid`。首次提示词仍保留在文件头中，以保持现有接口及导入行为；后续不会随元信息更新重复写入。

`session_update` 只包含 `timestamp` 与 `changes`，不分配业务事件 ID，也不进入历史消息或 SSE。`changes` 仅保存实际变化的字段，例如标题、模型、权限、外部会话 ID、IM 绑定。`null` 表示删除可选字段，`im: []` 表示清空绑定。嵌套字段变化时替换该字段的完整值，不进行深层合并。

`saveMetadata(session, event)` 比较前后元信息，忽略单独的 `updatedAt` 变化。如果紧接着写入的是 `status` 或 `usage` 事件，跳过该事件已经表达的状态或用量变化，避免相同数据再写一份差量。直接保存元信息时，这些字段的变化仍可记录在差量中。

加载时按文件顺序读取初始信息、应用元信息差量，并从状态、用量事件恢复对应字段。`updatedAt` 取初始值、差量及业务事件时间的最大值；原始日志文件的时间不参与计算。API 仍返回组装后的完整 `AgentSession`，不直接返回磁盘记录。

### 4.2 业务事件

磁盘 `StoredEvent` 与接口 `SessionEvent` 分开定义。下表说明接口事件；持久化时的区别是：

- `usage` 事件将 `text` 中的 JSON 转为 `usage` 对象，避免在磁盘中嵌套 JSON 字符串；读取历史、单事件或 SSE 补发时再转换回接口的 `text`。
- 已完成事件不保存 `streaming`；带 `streamId` 的记录读取时补充 `streaming: false`。未完成预览仍使用 `.pending`。
- 不保存事件上的 `pushedToIm`，由独立 `im_pushed` 标记恢复。
- 保留 `id`、`timestamp`、`streamId`、`order`、`contentIndex` 等不能重新推导的关联和排序信息。

| 字段 | 约定 |
| --- | --- |
| `id` | 会话内数字事件编号，客户端不得假设连续 |
| `type` | 标准事件类型，见下表 |
| `text` | 必填字符串；具体含义由 `type` 决定 |
| `timestamp` | 服务端创建事件时的 Unix 毫秒时间戳 |
| `rawRecordId` | 旧业务事件可能保留的原始日志引用；新事件不再填写 |
| `detail` | 可选详情字符串，可以是正文或 JSON 字符串，不能统一假设为 JSON |
| `streamId` | 可选，同一执行中同一流式内容块的稳定标识 |
| `order`、`contentIndex` | 可选，控制展示顺序及内容块位置 |
| `streaming` | `true` 表示未完成快照；`false` 表示已结束；普通事件可以省略 |
| `clearStreamIds` | 可选，需要清除的未完成内容块标识，由状态事件携带 |
| `im` | 可选，该事件的 IM 平台上下文 |
| `images` | 可选图片引用，只保存 `path` 和 `mimeType` |
| `pushedToIm` | 可选，读取历史或运行时更新得到的推送状态 |

| `type` | `text` 的含义 |
| --- | --- |
| `message` | 用户输入，也是历史分页的轮次边界；IM 用户输入同样使用此类型 |
| `thinking` | 思考内容 |
| `output` | 助手回复 |
| `tool` | 工具名称或命令，参数和结果放在 `detail` |
| `usage` | 完整 `SessionUsage` 的 JSON 字符串，包含累计消耗及可选的最新上下文 Token |
| `status` | `starting`、`running`、`waiting`、`completed`、`failed` 或 `stopped` |
| `error`、`warning` | 错误或警告信息；事件类型本身不等同于最终执行状态 |
| `im_message` | 应用侧记录的 IM 消息内容，平台由 `im.platform` 指定 |

新写入的普通 `text` 最长保留 50,000 个 JavaScript 字符串代码单元；带 `streamId` 的内容不受此截断。`detail` 同样截断至 50,000，`tool` 详情除外。Agent 本地 JSONL 日志只读展示原文。

### 4.3 用量与上下文

```ts
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface SessionUsage extends TokenUsage {
  contextTokens?: number;
}
```

磁盘记录：

```json
{"type":"usage","id":7,"timestamp":1791800000400,"usage":{"inputTokens":18387,"outputTokens":14,"cacheReadTokens":13184,"cacheWriteTokens":0,"contextTokens":18401}}
```

对应历史接口和 SSE 事件：

```json
{"type":"usage","id":7,"timestamp":1791800000400,"text":"{\"inputTokens\":18387,\"outputTokens\":14,\"cacheReadTokens\":13184,\"cacheWriteTokens\":0,\"contextTokens\":18401}"}
```

- Provider 的 `TokenUsage` 可以是累计值或增量值，Manager 按 `usageIsTotal` 更新累计消耗。磁盘 `usage` 始终保存合并后的完整会话用量，恢复时替换，不再次累加。
- 输入包含缓存 Token，缓存明细不额外计入输入与输出的累计总数。
- `contextTokens` 是最近一次 Agent 报告的上下文数量，每次覆盖，允许下降和零值；未提供时保留已有值。它不加入累计消耗，也不是模型窗口容量。
- Codex 从 `thread/tokenUsage/updated.params.tokenUsage.last.totalTokens` 获取上下文，`total` 继续用于累计消耗。Pi 从助手 `message_end.message.usage.totalTokens` 获取上下文，单条消息的消耗仍按增量累计。Claude Code 从主会话最近一条助手消息的 `message.usage` 获取单次输入与输出之和；输入包含缓存读取与写入，子 Agent 消息不替换主会话上下文。累计消耗仍从 `result.modelUsage` 获取。OpenCode 从 `step_finish.part.tokens` 取得单次调用用量，输入包含缓存读取与写入，输出包含 reasoning Token，两者之和覆盖上下文。Cursor 和 Gemini 当前输出未提供可确认的单次调用上下文，不使用执行累计值推算，界面保持 `—`。
- 只有上下文更新、没有累计用量更新时，也生成完整 `usage` 事件，更新持久记录和 SSE。此前没有累计值时输入、输出从零开始。
- 顶层 `session.contextTokens` 已移除，接口统一读取 `session.usage.contextTokens`。前端沿用现有 `usage` 消费逻辑，在对话输入区底部以同一行、垂直居中的“累计、输入、缓存、输出、当前”展示统计，保留累计用量与当前上下文的分组和提示，窄栏允许自然换行；未提供显示 `—`，零值显示 `0`，数值沿用 Token 缩写格式。

### 4.4 IM 推送标记

```json
{"type":"im_pushed","eventId":3}
```

`eventId` 指向已存在的 `output` 事件。标记自身不分配事件 ID，也不作为独立消息返回。读取历史、单事件及增量记录时，将标记合并为目标事件的 `pushedToIm: true`。

手动推送应在平台发送成功后记录标记；更新时广播原事件 ID，不创建新的助手回复。当前标记是事件级布尔状态，**不区分目标平台或应用**，不能据此判断每个平台分别是否收到消息。自动 IM 回复目前不自动写入此标记，也不自动生成 `im_message`。

## 5. Agent 本地会话日志与写入流程

应用停止保存 stdout/stderr 原始日志，也不再对原始日志执行 user/system 过滤或 delta 合并。日志面板读取 Agent 自身保存的 JSONL 文件，保留每条记录原文。当前支持 Pi、Codex、Claude、Gemini、Cursor 和 Kimi 的已知 JSONL 文件布局；没有 JSONL 读取入口的 Agent 返回 `supported: false`。会话 ID 尚未生成或本地文件尚未找到时返回空列表。

`src/agents/session-logs.ts` 负责按 `externalSessionId` 定位文件和分页，文件路径由服务端计算，不接收客户端指定的文件路径。读取仅包含快照范围内已换行完成的记录，未写完整的末尾行留待下一次读取。日志 ID 为原生文件行号，独立于业务事件编号；原生记录没有时间戳时不补造时间。

业务事件的处理顺序：

1. 将 stdout/stderr 行交给当前执行实例的 adapter reader；stdout 解析前执行 `trim()`。
2. Adapter 返回标准事件和执行控制信息。
3. `recordResult()` 根据标准事件更新会话状态、累计用量和流式展示顺序。Providers 和 Manager 均不再生成或处理 `system`、`file_change` 业务事件，文件编辑调用仍作为 `tool` 保留名称、参数和结果；不额外生成文件差异。
4. 普通业务事件通过 `append()` 分配 ID，将待写事件交给 `saveMetadata()` 以排除重复状态/用量，再由 `appendEvent()` 转为磁盘格式追加，最后更新缓存并广播。
5. 流式未完成事件只更新缓存及广播，按下一节规则保存快照。

Agent 报告任务完成后，进程退出时只在最终状态变化时追加状态事件，避免连续写入两个 `completed`。如果进程随后异常退出，仍追加 `failed` 更正状态。

`saveMetadata()` 必须先于该会话首次事件写入，以建立文件映射。元信息和业务事件的写入是独立操作；当前 Manager 会记录存储异常并继续处理，因此收到 SSE 不能视为持久化成功确认。

## 6. 流式事件与恢复

- 每次启动 Agent 都创建独立 reader 和执行 UUID；对外 `streamId` 为 `<执行 UUID>:<adapter 内容块标识>`，避免续聊时重用标识。
- 流式事件的 `text` 是当前完整快照。消费者按 `streamId` 替换旧快照，不再次拼接；每次实际发布仍分配新的数字 ID。
- Manager 跳过文本、详情和内容块下标均未变化的未完成快照。
- `orderKey` 是 adapter 内部的分组标识，不直接落盘；Manager 将其首次出现时的原始记录 ID 映射为 `order`。
- 最终事件使用同一个 `streamId` 和 `streaming: false`，追加到主文件并替换内存预览。
- `clearStreamIds` 只清除相应的未完成预览，不删除已经持久化的最终事件。

执行期间每秒检查未完成事件，内容变化时先写 `.jsonl.pending.tmp`，再通过重命名替换 `.jsonl.pending`。收到最终流式事件或清理指令时也更新快照；没有未完成事件时删除快照文件。

进程关闭时，剩余预览以 `streaming: false` 追加到主文件，随后清理快照。这里的“结束”表示停止更新，不表示任务成功；成功与否读取会话状态。

服务启动时恢复遗留快照：跳过已有非流式最终记录的 `streamId`，其余内容使用大于已有历史最大 ID 的新编号追加，并保留原快照时间戳，最后删除快照。会话元信息中的 `running`、`starting` 会转换为 `stopped`，清除 `pid`，并追加 `stopped` 状态事件。

突然退出可能丢失最近一次快照之后的预览。当前实现不会通过重放 Agent 本地会话文件自动重建这些预览。

## 7. 历史读取、排序和 SSE

| 接口 | 行为 |
| --- | --- |
| `history(id)` | 读取全部持久事件，合并推送标记与流式内容块，并按展示顺序排序 |
| `history(id, limit, before)` | 从主文件倒序按用户输入轮数读取；`before` 为排他性数字事件游标 |
| `history(id, 0)` | 不读取事件，返回空列表和 `hasMore: false` |
| `getEvent(id, eventId)` | 查询已持久化的单个业务事件，并合并推送状态 |
| `eventsAfter(id, after)` | 从主文件读取 ID 大于 `after` 的持久业务事件；Manager 额外补发当前未完成预览 |

Web 分别请求会话元信息、对话历史和原始日志：

- `GET /sessions/:id` 仅返回会话元信息；创建、发送消息、停止和 IM 推送的响应也不包含事件。
- `GET /sessions/:id/messages` 返回对话历史，不包含原始日志。`limit` 范围为 0–100，表示用户输入轮数；省略时读取全部对话事件。未指定 `before` 且 `limit` 非零时，Manager 会合并当前流式预览；查询更早历史不附带预览。
- `GET /sessions/:id/logs` 只读访问 Agent 本地 JSONL 会话记录，返回 `supported`、`events` 和 `hasMore`；`limit` 范围为 1–100，表示记录条数，`before` 为排他性文件行号游标。日志面板打开时读取最新记录，支持加载更早日志；不随实时事件更新。
- `GET /sessions/:id/events` 的历史补发和实时推送均排除 `raw_stdout`、`raw_stderr`，对话内容和状态继续实时更新。

`session` 和 `session_update` 不进入消息分页、单事件查询或 SSE。Store 与 Manager 的历史接口仅返回业务事件；Agent 本地日志不参与会话恢复、事件编号和实时广播。

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

迁移在 Store 加载历史时执行，当前覆盖旧 SQLite、会话 JSON 文件、旧项目目录布局、旧 `{ session, event, pushedEventId }` 行格式、平台专属 IM 字段及重复完整 `session` 快照格式。

IM 字段转换规则：

| 旧字段或类型 | 新字段或类型 |
| --- | --- |
| `dingtalkAppId`、`dingtalkConversation` | 会话 `im` 中 `platform: 'dingtalk'` 的绑定 |
| `feishuAppId`、`feishuConversation` | 会话 `im` 中 `platform: 'feishu'` 的绑定 |
| 事件 `dingtalkConversation`、`feishuConversation` | 事件 `im` 上下文 |
| `dingtalk_message`、`feishu_message` | `im_message`，原平台写入 `im.platform` |

格式版本 2 将旧完整快照转换为单次文件头和元信息差量，将用量字符串转换为对象，并把旧顶层 `contextTokens` 合入 `usage`。保留旧格式最后一份元信息快照的恢复语义、业务事件 ID、流式关联、展示顺序和推送标记。旧 JSON、SQLite 导入也经过相同的格式转换。

JSONL 行格式迁移先写临时文件，保存原文件为带时间戳的 `.bak`，再重命名替换。纯新格式无需重复重写；扫描不只检查文件头，也识别新格式文件中被旧执行追加的完整快照和字符串用量，并统一迁移。已有新格式差量、对象用量及后续旧记录均保留相应恢复顺序。不得通过读取失败后清空历史来处理格式异常。

删除运行中的会话时先停止进程并等待关闭，再删除主文件、应用旧原始日志副本和 pending 快照；不会删除 Agent 自身保存的会话文件。迁移备份及图片文件不在当前会话删除范围内。

## 11. 当前边界与变更要求

当前实现没有多进程文件锁、跨文件事务、`fsync` 持久性承诺或损坏尾行自动修复。JSONL 行解析失败会抛错；存储不是严格的“恰好一次”消息队列。不要让多个服务实例同时写入同一数据目录。

落盘格式由文件头 `formatVersion: 2` 标识。元信息恢复需要顺序回放文件，目前没有独立元信息索引；降低重复写入并不等于所有读取都更快。仅保存原始记录后重放、按平台记录送达状态仍属于独立变更，不能视为本文已实现的行为。

后续修改应满足：

- 保持本地会话 ID、事件 ID、原始记录关联与流式标识的语义；客户端不依赖编号连续。
- 保留完整历史、分页边界、展示顺序、续聊信息和 IM 来源；涉及格式不兼容时提供明确迁移。
- 区分“任务结束”“消息已展示”“已写入文件”“IM 已发送”，不得用一个状态替代全部含义。
- 新增 Agent 或 IM 平台时，优先扩展对应 adapter 或联合类型，避免在 Store 和前端增加原生协议分支。
- 修改实现后检查创建、续聊、停止、流式完成、中断恢复、分页、单事件读取、SSE 重连和推送标记，并执行 `pnpm typecheck`、`pnpm build`。

## 12. 实现索引

- [共享类型](../src/types.ts)
- [Agent provider](../src/agents/providers/index.ts)
- [会话业务处理](../src/sessions/manager.ts)
- [文件存储与迁移](../src/sessions/store.ts)
- [持久记录类型与接口转换](../src/sessions/records.ts)
- [事件合并与排序](../src/sessions/events.ts)
- [HTTP 与 SSE 路由](../src/server/routes/sessions.ts)

## 13. 本次修改与验收

本次将“反复追加完整会话快照”改为“初始信息加元信息差量”，新增磁盘/接口记录转换层，并将当前上下文数量统一纳入 `SessionUsage`。文件头保留初始完整元信息，不要求前端从磁盘结构直接拼装会话。

验收使用隔离临时目录和本机历史文件副本，未新增项目测试脚本：

- 创建及多次更新只保留一条 `session`；模型、标题清空和 IM 绑定清空可恢复；状态、用量不重复写差量。
- 历史分页、事件游标、单事件查询、IM 推送标记、排序字段与 `.pending` 去重恢复通过。
- Codex 累计用量覆盖、上下文下降与零值、缺失时保留，以及仅上下文更新的持久化与广播通过。
- 真实 HTTP 列表、详情、历史及 SSE 实时事件均可读取 `usage.contextTokens`；重启中的运行会话可恢复为 `stopped`。
- Codex、Claude Code、Pi 旧记录副本迁移后保留消息事件编号，完整元信息头均缩减为一条；旧格式权威状态、迁移备份与重复加载通过。
- 首行已为新格式、后续混入旧完整快照和字符串用量的真实 Pi 副本可加载并统一迁移。
- `pnpm typecheck`、`pnpm build` 与 `git diff --check` 通过；构建仍有既有的大文件分包提示。
