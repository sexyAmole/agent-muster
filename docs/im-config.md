# IM 配置文件字段说明

本文说明当前版本写入磁盘的 IM 应用配置，包括钉钉、飞书、企业微信和微信。接入步骤见 [10 分钟接入 IM](./tutorials/connect-im.md)，会话历史格式见 [会话与消息存储规范](./message-storage.md)。

## 文件位置与格式

| 平台 | 配置文件 |
| --- | --- |
| 钉钉 | `~/.agent-muster/im/dingtalk/apps.json` |
| 飞书 | `~/.agent-muster/im/feishu/apps.json` |
| 企业微信 | `~/.agent-muster/im/wecom/apps.json` |
| 微信 | `~/.agent-muster/im/weixin/apps.json` |

`~` 表示运行 Agent Muster 的用户主目录。每个文件都是 UTF-8 JSON 数组，一个数组元素代表一个应用或 Bot；没有接入时文件可能不存在。程序写入时采用紧凑 JSON，先写临时文件，再重命名替换。

这些文件同时包含凭证、用户设置和程序维护的状态，不能作为可公开分享的配置模板。以下示例中的标识与凭证均为占位值。

## 各平台通用字段

“可配置”表示通过 IM 集成界面或聊天指令修改；“自动维护”表示由扫码、平台同步或会话执行流程生成。

| 字段 | 类型 | 初始值或缺省行为 | 含义与维护方式 |
| --- | --- | --- | --- |
| `id` | `string` | 创建接入时生成 UUID | Agent Muster 内部应用标识，自动维护。不是平台的应用 ID；用于接口、会话绑定等本地关联。 |
| `clientId` | `string` | 平台返回 | 钉钉为应用 Client ID，飞书为应用 ID，企业微信为机器人 `botid`，微信为 `ilink_bot_id`。自动维护。 |
| `name` | `string \| null` | 钉钉、企业微信、微信为 `null`；飞书新应用为 `Agent Muster` | 应用展示名。钉钉、飞书可通过“一键同步”更新。 |
| `project` | `string \| null` | `null` | 应用默认项目的完整路径，必须是已添加的项目。可配置。 |
| `agent` | `string \| null` | `null` | 应用绑定的 Agent ID，必须是当前可用的 Agent。可配置。 |
| `model` | `string`，可省略 | 创建接入时省略 | 应用默认模型 ID。空字符串表示使用 Agent 默认模型；未指定时，新会话使用 Agent 默认模型。可配置。 |
| `permissionMode` | `string`，可省略 | 创建接入时省略 | Agent 权限模式 ID，必须由所选 Agent 支持。界面会在选择 Agent 后补选权限模式；创建会话时仍未指定则使用 `full-auto`。可配置。 |
| `systemPrompt` | `string`，可省略 | 省略 | IM 新会话的系统提示词，仅支持此能力的 Agent 可设置。保存时去除首尾空白，最多 8000 个 JavaScript 字符串代码单元，不允许 NUL 字符；提交空白文本会清除该字段。可配置，仅新建会话生效。 |
| `createdAt` | `number` | 创建接入时生成 | 创建时间，Unix 毫秒时间戳。钉钉、飞书、企业微信加载缺失该字段的旧记录时会补为当前时间。自动维护。 |
| `conversations` | `Record<string, string>` | `{}` | 聊天路由键到本地会话 ID 的映射，值通常为 `ses_<UUID>`。只保存关联，不保存消息正文。自动维护。 |
| `conversationSettings` | `Record<string, ConversationSettings>`，可省略 | 省略；配置聊天后创建 | 每个聊天路由的项目、模型覆盖设置。单聊按聊天隔离，群聊按群成员隔离。通过聊天指令修改。 |

新接入的 `project`、`agent` 初始为空；界面在存在可选项目和 Agent 时会自动选择。实际执行任务前仍会检查绑定项目存在、Agent 可用。

### 聊天级设置 `conversationSettings`

每个键对应一个对象，只支持以下两个字段：

| 字段 | 类型 | 缺省行为 | 修改方式 |
| --- | --- | --- | --- |
| `project` | `string`，可省略 | 使用应用的 `project` | `/project 编号或完整路径`。切换后解除该路由的会话绑定，下一条任务创建新会话。 |
| `model` | `string`，可省略 | 使用应用的 `model` | `/model 编号或模型ID`。下一条任务生效；`/model default` 写入空字符串，使用 Agent 默认模型。 |

聊天级字段按字段覆盖应用默认值。`agent`、`permissionMode`、`systemPrompt` 和钉钉的 `autoReply` 都是应用级设置，不能通过 `conversationSettings` 为单个成员单独设置。

## 会话路由键

`conversations` 和 `conversationSettings` 使用相同的路由键。钉钉的 `conversationTargets` 也使用该键。

| 场景 | 路由键格式 |
| --- | --- |
| 钉钉单聊 | `1:<conversationId>` |
| 飞书单聊 | 消息的 `chat_id` |
| 企业微信单聊 | 发送人的 `from.userid` |
| 微信单聊 | 发送人的 `from_user_id`；当前只接收登录绑定用户的单聊消息 |
| 钉钉、飞书、企业微信群聊 | `group:` 加上 `JSON.stringify([群ID, 发送人ID])` |

群聊发送人 ID：钉钉使用 `senderStaffId`，飞书使用 `sender_id.open_id`，企业微信使用 `from.userid`。钉钉群 ID 使用原始 `conversationId`，不加 `2:` 前缀；飞书使用 `chat_id`，企业微信使用 `chatid`。

例如群 `group-example` 中成员 `user-a` 的路由键为：

```text
group:["group-example","user-a"]
```

写入 JSON 对象键时，其中的引号需要转义：

```json
{
  "conversations": {
    "group:[\"group-example\",\"user-a\"]": "ses_example-a",
    "group:[\"group-example\",\"user-b\"]": "ses_example-b"
  },
  "conversationSettings": {
    "group:[\"group-example\",\"user-a\"]": {
      "project": "/path/to/project",
      "model": ""
    }
  }
}
```

同一应用、同一群、同一成员续用自己的会话；换群、换成员或换应用会分别建立会话。`/new`、`/project`、`/model` 都只作用于发指令者在该群中的路由。同群消息及指令仍按顺序处理；独立会话的成员如果选择同一项目，仍使用同一项目目录。

旧版本的群共享键（钉钉为 `2:<conversationId>`，飞书和企业微信为原始群 ID）可能继续保留在文件中，用于旧会话关联。新群消息不会继承这些共享会话或共享设置，成员首次发消息时使用应用默认配置创建独立会话。

## 钉钉专有字段

| 字段 | 类型 | 初始值或缺省行为 | 含义 |
| --- | --- | --- | --- |
| `clientSecret` | `string` | 扫码接入时平台返回 | 应用密钥，敏感信息，自动维护。 |
| `iconMime` | `string \| null` | `null` | 缓存图标的 MIME 类型，通过“一键同步”更新。图标文件保存在 `im/dingtalk/icons/<id>`，配置中不保存图标 URL。 |
| `autoReply` | `boolean` | `true`；旧记录省略时也视为开启 | 是否自动向钉钉发送回复。应用级开关，影响该应用所有单聊与群聊，可在界面配置。 |
| `conversationTargets` | `Record<string, ConversationTarget>`，可省略 | 收到任务消息后创建或更新 | 保存各路由对应的钉钉真实发送目标，用于从本地会话手动推送结果。自动维护。 |

### 自动回复开关

- `true`：自动发送处理卡片、流式内容和最终结果；也会发送聊天指令反馈及错误提示。
- `false`：收到的任务消息仍执行、会话结果仍保存在本地；不自动发送上述钉钉消息，聊天指令仍执行但不发送反馈。
- 手动“发送到钉钉”仍然可用，不受开关控制。
- 执行中关闭开关会阻止后续自动发送，已经发送的消息不会撤回。

其他三个平台当前没有自动回复开关，不要向其配置添加 `autoReply` 来控制回复。

### 发送目标 `ConversationTarget`

| 字段 | 类型 | 适用场景 | 含义 |
| --- | --- | --- | --- |
| `type` | `"1" \| "2"` | 全部 | `"1"` 表示单聊，`"2"` 表示群聊。 |
| `robotCode` | `string` | 全部 | 收到消息中的机器人编码。 |
| `userId` | `string` | 仅单聊 | 收到消息中的 `senderStaffId`，用于发送单聊消息。 |
| `openConversationId` | `string` | 仅群聊 | 原始群会话 ID，用于发送群消息。 |

群成员的会话路由键虽然不同，发送目标中的 `openConversationId` 仍然是原群 ID。字段值由收到的消息生成，不能用内部路由键替代。

### 钉钉完整示例

```json
[
  {
    "id": "example-app-id",
    "clientId": "example-client-id",
    "clientSecret": "<REDACTED>",
    "name": null,
    "iconMime": null,
    "project": "/path/to/project",
    "agent": "codex",
    "model": "",
    "permissionMode": "full-auto",
    "systemPrompt": "请用中文回复。",
    "autoReply": true,
    "createdAt": 1794326400000,
    "conversations": {
      "group:[\"group-example\",\"user-a\"]": "ses_example-a"
    },
    "conversationSettings": {
      "group:[\"group-example\",\"user-a\"]": {
        "model": ""
      }
    },
    "conversationTargets": {
      "group:[\"group-example\",\"user-a\"]": {
        "type": "2",
        "robotCode": "example-robot-code",
        "openConversationId": "group-example"
      }
    }
  }
]
```

## 飞书和企业微信专有字段

| 字段 | 类型 | 初始值 | 含义 |
| --- | --- | --- | --- |
| `clientSecret` | `string` | 扫码接入时平台返回 | 飞书应用密钥或企业微信机器人 `secret`，敏感信息，自动维护。 |
| `icon` | `string \| null` | `null` | 应用图标地址。飞书“一键同步”会更新为平台返回的头像 URL；企业微信当前没有同步入口。 |

这两个平台没有 `conversationTargets` 字段。手动推送时，程序从会话路由键取出真实聊天 ID，再向对应聊天发送消息。

## 微信专有字段

| 字段 | 类型 | 初始值或来源 | 含义 |
| --- | --- | --- | --- |
| `botToken` | `string` | 扫码确认返回的 `bot_token` | Bot 登录令牌，敏感信息，自动维护。微信不使用 `clientSecret`。 |
| `baseUrl` | `string` | 扫码确认返回的 `baseurl` | 此 Bot 的 iLink API 地址，经过 `validateApiBase()` 校验。自动维护，不应随意修改。 |
| `userId` | `string` | 扫码确认返回的 `ilink_user_id` | 登录绑定用户 ID；当前只接收该用户的单聊消息。自动维护。 |
| `icon` | `string \| null` | `null` | 图标字段，当前没有同步入口。 |
| `contextTokens` | `Record<string, string>` | `{}` | 用户 ID 到最近收到的 `context_token` 的映射，发送回复时使用。敏感状态，收到消息后自动更新。 |
| `updatesCursor` | `string` | `""` | `getupdates` 长轮询游标，保存平台返回的 `get_updates_buf`，用于后续继续拉取消息。自动维护。 |

微信不支持群聊。重新扫码登录同一个 Bot 时，会更新登录信息并清空 `contextTokens` 和 `updatesCursor`，原有会话绑定及应用设置保留。

## 配置变更与历史记录

| 操作 | 当前行为 |
| --- | --- |
| 修改应用的项目或 Agent | 清空该应用全部 `conversations`、`conversationSettings`，钉钉还清空 `conversationTargets`。已有会话历史保留，下一条任务重新建会话。 |
| 更换 Agent | 除上述清理外，移除旧 `model`、`permissionMode`；同次保存中明确提交的新模型、权限模式会重新写入。 |
| 修改应用模型或权限模式 | 不清空会话绑定；没有聊天级模型覆盖的后续任务使用更新后的应用模型。 |
| 修改系统提示词 | 不清空会话绑定，只对之后新建的会话生效。 |
| 切换钉钉自动回复 | 不清空会话绑定或聊天级配置。 |
| `/new` | 删除当前路由的 `conversations` 条目，保留项目、模型覆盖及历史记录，下一条任务新建会话。 |
| `/project` | 更新当前路由的项目覆盖并解除其会话绑定，其他成员不受影响。 |
| `/model` | 更新当前路由的模型覆盖，不解除其会话绑定，下一条任务生效。 |
| 删除本地 IM 接入 | 移除该应用配置并停止收消息，保留本地会话历史；不会删除平台侧应用。 |

## 磁盘字段与接口字段的区别

界面使用的应用列表不是 `apps.json` 的原样返回：

- `clientSecret`、`botToken` 等凭证不会返回给应用列表界面。
- `connectionStatus`、`connectionError` 是运行时连接状态，不是需要写入文件的配置项。
- 钉钉列表中的 `icon` 是本地图标接口 URL，磁盘中保存的是 `iconMime`。
- 钉钉访问令牌缓存、扫码状态、临时回复 Webhook 和流式卡片 ID 不属于本文的应用配置。

## 修改与保管建议

优先通过界面和聊天指令修改配置。手动编辑时应先停止服务并备份文件，编辑完成后重启；程序不会实时监听文件变更，运行期间的自动保存还可能覆盖手动修改。

不要提交、记录或分享含真实凭证的文件、日志和截图。分享排查样例时，替换 `clientSecret`、`botToken`、`contextTokens` 以及涉及隐私的用户、群聊标识。程序创建配置目录时使用 `0700` 权限，创建配置文件时使用 `0600` 权限。

字段实现以各平台 Registry 为准：[钉钉](../src/integrations/dingtalk/registry.ts)、[飞书](../src/integrations/feishu/registry.ts)、[企业微信](../src/integrations/wecom/registry.ts)、[微信](../src/integrations/weixin/registry.ts)。聊天级字段见 [commands.ts](../src/integrations/commands.ts)，群成员路由编码见 [conversation.ts](../src/integrations/conversation.ts)。
