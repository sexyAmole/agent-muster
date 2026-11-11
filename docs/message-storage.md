# 会话与消息存储规范

本文维护磁盘格式、事件流和恢复契约。修改相关实现时同步更新；模块职责见 [会话模块约定](../src/sessions/AGENTS.md)，接口类型以 [types.ts](../src/types.ts) 为准，磁盘类型以 [records.ts](../src/sessions/records.ts) 为准。

## 存储边界

- Muster 保存会话元信息、业务事件、IM 推送标记和未完成流式快照，正常历史采用追加写入。
- stdout/stderr 只交给 Provider 解析，不保存原始日志副本。日志接口只读访问 Agent 自己管理的 JSONL 文件，不参与业务恢复、编号或广播。
- 内存事件是缓存，完整历史与 IM 最终结果通过存储接口读取。收到 SSE 表示事件已发布，不代表落盘成功；Manager 当前会记录存储错误并继续处理。
- 会话绑定统一为 `ImBinding[]`，消息来源为 `ImContext`，以 `platform` 区分钉钉、飞书、企业微信和微信；凭证、Webhook 和平台 token 不属于业务记录。

## 目录与标识

默认数据目录为 `~/.agent-muster/`，SessionStore 可通过构造参数指定隔离目录。

```text
~/.agent-muster/
├── projects/<项目标识>/
│   ├── project.json
│   └── sessions/
│       ├── <会话标识>.jsonl
│       └── <会话标识>.jsonl.pending
└── images/<图片 UUID>.<扩展名>
```

- 项目标识为 `SHA-256(resolve(cwd))`；`project.json` 保存项目路径及可选名称、排序。
- 本地会话 ID 为 `ses_<UUID>`，文件名使用 `encodeURIComponent(session.id)`；`externalSessionId` 仅用于 Agent 续聊和原生日志定位。
- 主文件是 UTF-8 JSONL，每行一个序列化对象并以 LF 结尾；`.pending` 是 JSON 数组，不是 JSONL。

## 主文件记录

| 记录 | 持久化含义 |
| --- | --- |
| `session` | 唯一文件头，`formatVersion: 2`，包含初始会话元信息，排除 `events`、`pid` |
| `session_update` | `timestamp` 与 `changes`，仅追加变化的元信息 |
| 业务事件 | 用户输入、助手输出、思考、工具、用量、状态、错误、警告或 `im_message` |
| `im_pushed` | `eventId` 指向已发送到 IM 的输出事件，不分配新业务事件编号 |

文件头保留首次提示词及初始状态、用量和绑定。`session_update.changes` 中，`null` 删除可选字段，`im: []` 清空绑定，嵌套值整体替换；不为单独的 `updatedAt` 变化追加差量。

写入事件前，`saveMetadata(session, event)` 跳过同一 `status` 或 `usage` 事件已经表达的字段变化。恢复按文件顺序应用文件头、差量、状态和用量；`updatedAt` 取初始值、差量和业务事件时间的最大值。元信息记录不进入消息历史、单事件查询或 SSE。

磁盘事件与接口事件的区别：

- 磁盘 `usage` 保存完整 `SessionUsage` 对象；历史和 SSE 转回接口中的 `text` JSON 字符串。
- 完成事件省略 `streaming`，读取带 `streamId` 的完成记录时恢复 `streaming: false`。
- `pushedToIm` 从独立标记合并，不直接写在新事件上。
- 保留 `id`、`timestamp`、`streamId`、`order`、`contentIndex`、图片引用和生成状态等关联信息。

普通事件文本及非工具详情最多保留 50,000 个 JavaScript 字符串代码单元；带 `streamId` 的文本与工具详情不受该截断。`detail` 可能是正文或 JSON，消费者不能统一按 JSON 解析。旧 `rawRecordId` 可保留，新事件不再填写。

手动 IM 推送成功后才追加 `im_pushed`，并广播原事件 ID 的更新。标记是事件级布尔值，不区分平台或应用；自动回复当前不写此标记，也不自动生成 `im_message`。

## 流式事件与恢复

- 每次执行创建独立 reader 与 UUID，对外 `streamId` 为 `<执行 UUID>:<Provider 内容块标识>`。
- 流式文本是完整快照，按 `streamId` 替换；内容未变化时跳过重复预览。最终事件沿用该标识，写入主文件并替换预览。
- `orderKey` 仅用于执行内分组，Manager 在首次出现时分配 `order`；展示按 `order ?? id`、`contentIndex ?? 0`、`id` 排序。
- `clearStreamIds` 只清理未完成预览，不删除已持久化的最终内容。
- 每秒检查快照，变化时先写临时文件再重命名替换 `.pending`；最终事件和清理指令也触发更新，没有预览时删除文件。

进程关闭时将剩余预览作为完成更新的事件写入主文件并清除快照；这不表示任务成功，任务结果读取会话状态。生成中的图片在执行结束或恢复时转为中断失败状态。

启动恢复时跳过已有最终记录的 `streamId`，其余 pending 内容分配大于历史最大 ID 的新编号，保留快照时间戳后追加，最后删除快照。Manager 将原 `starting`、`running` 状态转为 `stopped` 并清除 `pid`。突然退出可能丢失最后一次快照后的内容，当前不会重放 Agent 原生日志补建。

## 用量与排队消息

- Provider 用量通过累计/增量标志由 Manager 合并；磁盘 `usage` 始终是完整会话用量，恢复时替换，不再次累加。
- 输入包含缓存 Token，缓存明细不再额外加入输入与输出总数。
- 当前上下文统一为 `session.usage.contextTokens`，每次报告覆盖更新，允许下降及零值；未报告保留原值，不用执行累计量推算。
- 仅上下文变化也生成完整 `usage` 事件；此前无累计值时输入、输出从零开始。各 Agent 的取数规则留在对应 Provider。
- 排队消息作为元信息保存正文、模型、权限、沙箱和图片路径/MIME，执行时才生成用户消息事件；停止或重启后队列暂停，由用户明确继续。

## 历史、日志与 SSE

| 接口 | 读取规则 |
| --- | --- |
| `history(id)` | 全部业务历史，合并推送标记和流式块并按展示顺序排序 |
| `history(id, limit, before)` | 按用户输入轮数倒序分页，`before` 是排他性事件 ID |
| `history(id, 0)` | 空事件列表，`hasMore: false` |
| `getEvent(id, eventId)` | 已持久化的单个业务事件，合并推送状态 |
| `eventsAfter(id, after)` | ID 大于游标的持久事件，Manager 额外补发当前流式预览 |

HTTP 路由统一带 `/api` 前缀：

- `GET /sessions/:id` 只返回元信息，排除 `events` 和内部系统提示词；创建、续聊、停止及推送响应沿用该规则。
- `GET /sessions/:id/messages` 的 `limit` 为 0–100 轮，省略时读取全部历史；未指定 `before` 且 `limit` 非零时合并实时预览。
- `GET /sessions/:id/logs` 的 `limit` 为 1–100 条，`before` 是排他性原文件行号，返回 `supported`、`events`、`hasMore`。只读取快照范围内已经换行的记录，保留原文，不补造时间戳。
- 日志路径由 Provider 根据 `externalSessionId` 定位；不支持时返回 `supported: false`，ID 或文件尚未生成时返回空列表。
- `GET /sessions/:id/events` 补发和实时推送均排除 `raw_stdout`、`raw_stderr`。

展示按 `streamId` 合并内容块，普通事件按 `id` 合并，后来的内容覆盖旧值；展示顺序可能不同于 ID 顺序，不能将数组末项当作最大游标。

SSE 的 `data` 为单个 `SessionEvent`，`id` 为本连接已发送 ID 的最大值；重连从 `after` 和 `Last-Event-ID` 的较大值补发。未完成预览和推送状态可更新旧 ID，消费者必须允许替换已有内容，不能只按 ID 递增过滤。

`im_pushed` 自身没有增量游标；断线期间旧事件的推送标记无法仅靠新增事件补齐，应重新读取相关历史。运行时缓存保留最近 50 条事件及更早的未完成预览，启动预加载最近 10 轮，均不代表完整历史长度。

## IM 与图片

会话每个平台最多保留一个绑定，同平台重新绑定时更新应用及提供的聊天上下文，不同平台可并存。消息上的 `im` 保存该条消息来源，不能用会话最近的聊天上下文替代；消息消费者不依赖额外 `appId` 必然存在。

图片记录保留 `id`、`path`、`mimeType`，不持久化运行时 Base64；支持 PNG、JPEG、GIF、WebP，并核对文件内容与 MIME。Provider 生成的图片也复制到 Store 管理的图片目录，事件另保存生成状态。迁移会话需同时处理图片引用，单独复制 JSONL 不保证图片可读取。

## 迁移、删除与边界

Store 加载时处理旧 SQLite、JSON、项目目录布局、旧行结构、平台专属 IM 字段、重复完整会话快照和字符串用量。迁移保留会话与事件 ID、排序、流式关联、续聊信息和推送标记；旧顶层 `contextTokens` 合入 `usage`。

行格式迁移先写临时文件，保存时间戳备份后替换。检测范围包括新格式文件中混入的旧记录；保留新旧记录的恢复顺序，不能仅检查文件头，也不能以清空历史处理解析失败。

删除运行中会话先停止并等待进程关闭，再删除主文件、旧原始日志副本和 pending；Agent 自身的会话文件、迁移备份和图片不在会话删除范围。

当前没有多进程文件锁、跨文件事务、`fsync` 持久性承诺或损坏尾行自动修复；JSONL 解析失败抛错，同一数据目录只由一个服务实例写入。区分任务结束、内容展示、文件写入与 IM 发送，不用单一状态代表全部完成。
