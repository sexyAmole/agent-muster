# Pi 会话记录与返回格式

## 记录与展示

Pi 使用 `pi --mode json` 启动。服务端先将流式输出整理为完整消息、工具结果与状态记录，再通过服务端适配器生成页面展示事件。实时 SSE、历史查询、单事件查询及 IM 推送读取使用同一套转换规则，前端不解析 Pi 原生协议。不逐条保存或还原 Token 增量。

每个会话保存在 `~/.agent-muster/projects/<项目路径的 SHA-256>/sessions/<本地会话 ID>.jsonl`。文件中包含会话元数据、用户输入、整理后的 stdout、原始 stderr、应用状态和 IM 推送标记。stdout 派生的系统消息、思考、回复、工具结果和用量展示事件不重复落盘。

## 整理后的 stdout 记录

```json
{"id":30,"type":"raw_stdout","format":"pi-compact-v1","text":"{\"type\":\"session\",\"id\":\"pi-session-id\"}","timestamp":1791500000000}
```

| 字段 | 规定 |
| --- | --- |
| `id` | 本地会话内递增的整数，客户端不得假设连续 |
| `type` | 固定为 `raw_stdout` |
| `format` | 新记录固定为 `pi-compact-v1`；旧记录的 `pi-json-v1` 继续支持读取 |
| `text` | 整理后的 Pi 事件 JSON 字符串，正文和工具结果不截断；不包含行分隔符 LF |
| `timestamp` | 服务端保存该事件时的 Unix 毫秒时间戳 |

### 保存规则

| Pi 事件 | 保存方式 |
| --- | --- |
| `message_update` | 在内存中合并文本、思考和工具参数，不逐条追加 JSONL |
| `message_start` | 只保留事件字段及消息的 role、timestamp、toolCallId 引用，不携带正文快照 |
| `message_end` | 保存完整最终消息；同一次执行中按 role + timestamp 去重；toolResult 消息只保存引用，结果保存在工具结束记录中 |
| `tool_execution_start` | 保存工具 ID、工具名、启动参数和其他状态字段，用于立即显示执行占位 |
| `tool_execution_update` | 保留最新部分结果到内存，不逐条追加 JSONL |
| `tool_execution_end` | 保存完整结果和启动时的参数，按 toolCallId 去重 |
| `turn_end` | 消息和工具结果替换为 role、timestamp、toolCallId 引用，保留其他字段 |
| `agent_end` | messages 替换为消息引用数组，保留 willRetry 等其他字段 |
| 其他事件 | 保留事件字段；非 JSON stdout 行保留原文；空行不保存 |

stderr 使用 `raw_stderr` 保存完整行，不带 `format`；它可能是普通文本，不保证为 JSON。正常运行时，最终消息中的 usage 用于统计用量，不保存每条增量事件携带的 usage 快照。

### 未完成内容与恢复

执行期间每秒检查内存中的未完成消息和工具结果，内容变化时原子覆盖 `<会话文件>.pi-pending`，不追加到主 JSONL。快照不包含增量用量，消息内容已合并；尚未完成的工具参数保存在内容块的 partialArguments 字符串中。

正常收到结束事件后，最终消息和工具结果保存到主文件；没有未完成内容时删除临时快照。进程退出或被停止时，内存中的未完成内容以 `partial: true` 的 message_end/tool_execution_end 保存到主文件。服务重启时读取遗留快照，排除当前执行中已经完成的消息和工具后，将剩余部分写入主文件，再删除快照。

突然崩溃时，最近一次快照之后尚未保存的增量可能丢失；不完整消息不计入最终 Token 用量。

运行日志展示整理后的 stdout 和原始 stderr；复制操作按顺序拼接已加载的记录。日志随会话历史按轮次分页，查看完整会话日志需要加载更早记录。旧 Pi 会话已有记录继续正常读取，不自动重写历史文件。

## 服务端返回的展示事件

历史查询 `GET /api/sessions/:id` 返回会话信息、`events` 和 `hasMore`。`limit` 表示用户输入的轮数，`before` 表示读取 ID 小于该值的历史。省略 `limit` 返回全部事件。

实时接口 `GET /api/sessions/:id/events` 使用 SSE，每个 `data` 是一个展示事件 JSON；SSE 的 `id` 是事件游标。重连使用 `after` 或 `Last-Event-ID`，服务端会重新转换原始记录，只发送游标之后的事件。

```ts
interface SessionEvent {
  id: number;
  type: 'system' | 'thinking' | 'output' | 'tool' | 'usage'
    | 'message' | 'status' | 'error' | 'warning'
    | 'raw_stdout' | 'raw_stderr' | 'file_change'
    | 'dingtalk_message' | 'feishu_message';
  text: string;
  timestamp: number;
  detail?: string;
  format?: 'pi-json-v1' | 'pi-compact-v1';
  pushedToIm?: boolean;
  streamId?: string;
  order?: number;
  contentIndex?: number;
  streaming?: boolean;
  clearStreamIds?: string[];
  // 图片、IM 来源和文件变更等可选字段以 src/types.ts 为准。
}
```

Pi 保存的事件会作为 `raw_stdout` 返回，供运行日志使用；同一记录还可能生成多个展示事件。派生事件沿用该记录的时间戳，保留完整正文和工具详情，不带 `format`。

### 实时文本更新

Pi 的文本和思考增量在服务端合并后，通过 SSE 发送当前完整内容，不写入主 JSONL。预览事件使用 `output` 或 `thinking` 类型，`streaming: true`，`streamId` 为 `<message_start 记录 ID>:<展示类型>:<contentIndex>`。每个内容块独立更新，不跨块合并；text 每次包含该块的当前完整文本，客户端按 streamId 替换，不能再次拼接。预览的 id 使用 message_start 记录 ID，仅作为 SSE 游标参与比较，不能用于内容块去重。

最终 message_end 生成 `streaming: false` 的事件，使用正常的持久记录派生 ID，沿用同一 streamId，替换预览。历史重放也根据 message_start 还原 streamId，防止首次查询与 SSE 建立连接之间恰好完成消息时产生重复。旧原始格式 pi-json-v1 的返回方式保持原样。

如果最终消息缺少已预览的内容块，其 raw_stdout 返回事件通过 clearStreamIds 指定需要删除的预览，客户端只清理 streaming 为 true 的对应项，防止错误结束后留下未确认的正文。

最新历史查询会附带内存中的正在生成的预览；SSE 重连也补发当前预览，即使预览 ID 不大于 after。SSE 游标仍取已发送 ID 的最大值，不能把预览 ID 当作连续增长的 Token 序号。带 before 的历史分页与 limit=0 查询不附带预览。

展示顺序按 `order`（消息开始或工具启动记录 ID）、`contentIndex`（原生内容块下标）、`id` 排序。历史查询按 streamId 合并工具占位与结果，实时更新、刷新和重连使用同一排序规则。工具开始事件生成 `streaming: true` 的占位，结束事件沿用 `tool:<toolCallId>` 更新为完整结果；工具的顺序取助手消息中的 toolCall 位置，未关联消息时取启动记录的位置。

页面保持每个正文块的 DOM 位置，执行过程折叠只隐藏思考和工具记录。增量文本通过动画帧逐步显示，积压较多时加快追赶，历史正文直接显示。文本变化时只在用户处于底部时跟随滚动。预览不提供最终回复的复制和 IM 推送操作，完整消息到达后恢复操作。

### Pi 事件转换规则

| Pi 原生事件 | 服务端行为 |
| --- | --- |
| `session` | 将 `id` 保存为会话的 `externalSessionId`；续聊传入 `pi --session <ID>` |
| `message_end`，`message.role = system` | 生成 `system`；`detail` 为包含 sections、工具变化、replace 和 timestamp 的 JSON 字符串 |
| `message_end`，`message.role = assistant` | 从内容块生成 `thinking` 和 `output`；存在用量时生成 `usage`，存在 `errorMessage` 时生成 `error` |
| `tool_execution_start` | 整理格式立即生成工具占位；旧格式按 `toolCallId` 暂存 `args`，用于关联工具结束事件 |
| `tool_execution_end` | 生成 `tool`；新格式直接读取事件中的 args，旧格式读取启动参数；`text` 为工具名，`detail` 是包含 args、result、isError、durationMs 的 JSON 字符串 |
| `agent_settled` | 确认任务结束，结合 aborted、助手错误和进程退出结果更新会话状态 |
| 其他已保存事件 | 显示在运行日志中，不生成额外展示事件 |

同一次执行中，助手与系统消息按 `role + timestamp` 去重，工具结果按 `toolCallId` 去重。新用户输入开始新的执行，重置去重与工具参数关联状态，累计用量继续保留。

`usage.text` 是累计用量的 JSON 字符串：

```json
{"inputTokens":1200,"outputTokens":300}
```

输入用量累加 Pi 的 `input + cacheRead + cacheWrite`，输出用量累加 `output`。会话信息中的 `usage` 与该结构一致。

### 稳定 ID 与引用

Pi 每条落盘事件的 ID 在当前缓存事件的最大 ID 基础上增加 10，为 stdout 的派生事件预留空间。`pi-json-v1` 的派生 ID，以及 `pi-compact-v1` 中首个思考块、首个正文块和其他类型的派生 ID，保留以下偏移：

| 类型 | ID |
| --- | --- |
| 原始 stdout | 原始记录 ID |
| `system` | 原始记录 ID + 1 |
| `thinking` | 原始记录 ID + 2 |
| `output` | 原始记录 ID + 3 |
| `usage` | 原始记录 ID + 4 |
| `tool` | 原始记录 ID + 5 |
| `error` | 原始记录 ID + 6 |

`pi-compact-v1` 中同一消息的第二个及后续同类型内容块，按原生内容顺序使用原始记录 ID + 7 起的连续 ID。展示顺序独立于这些引用 ID。

例如原始记录 ID 为 100，首个回复块 ID 为 103。实时输出、重启后的历史读取、SSE 重连及 IM 推送都引用这个相同的 ID。IM 推送成功后追加 `{"type":"im_pushed","eventId":103}`，读取时将对应回复标记为 `pushedToIm: true`。

不要修改 `pi-json-v1` 的 ID 偏移或去重键语义；未来需要改变这些规则时应定义新的格式版本，保留旧版本读取规则。

## 范围与读取成本

整理格式仅用于新产生的 Pi stdout。其他 Agent 保持原有存储与转换行为，旧 Pi 记录不重写。

Pi 历史读取按顺序重放原始事件，以还原工具参数、去重状态和累计用量。分页只保留所需轮次的展示数据，但转换仍需扫描之前的记录；当前没有增加持久化展示缓存或索引。
