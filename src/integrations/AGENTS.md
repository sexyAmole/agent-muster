# IM 集成模块

## 模块约定

- 各平台 Registry 管理应用凭证、扫码接入、会话绑定、连接与收发；Bridge 负责平台消息转换、任务路由和回复，业务历史通过 SessionManager 写入。
- 同一应用和聊天的消息及指令串行处理，按平台消息 ID 去重；新任务先确认项目与 Agent 有效。
- 公共聊天指令统一经过 `handleCommand()`；应用级绑定与聊天级项目/模型设置分别维护，更换应用项目或 Agent 时清理旧聊天绑定。
- 会话使用统一 `ImBinding`，消息来源使用 `ImContext`；新增平台同步扩展共享联合类型和运行时恢复、启动、关闭流程。
- Agent 任务完成需同时检查终态和进程空闲；最终结果从存储接口读取，流式输出监听在结束后释放。
- 流式平台使用 `StreamReply` 合并更新并在完成时发送最终内容；原生 SDK 及消息格式留在各平台目录。
- 凭证只留在本地平台配置，列表响应脱敏；迁移通过明确的旧路径迁移流程完成，不能覆盖已存在的目标文件。
- 群聊保留发送人来源，图片下载及解密留在平台 Registry，业务记录使用标准图片引用；富文本转换保留正文、链接和图片。
- 微信接入使用 iLink 长轮询及单聊上下文 token，接口地址必须经过 `validateApiBase()` 校验；关闭时取消轮询，认证过期需重新扫码。

## Structure

- `commands.ts`：项目、模型、会话及状态聊天指令。
- `stream-reply.ts`：流式回复节流、监听与按字节分段工具。
- `storage.ts`：旧平台配置路径迁移。
- `dingtalk/`、`feishu/`、`wecom/`：钉钉、飞书、企业微信，各自的 `registry.ts` 管理平台连接与收发，`bridge.ts` 路由任务。
- `weixin/`：微信 Registry、Bridge，以及 `api.ts` 中的请求、协议类型和地址校验。

## Dependencies

- 公共逻辑依赖 AgentRegistry、ProjectRegistry、SessionManager 和 `../types.ts`。
- 钉钉依赖 `dingtalk-stream`、`undici`；飞书依赖 `@larksuiteoapi/node-sdk`；企业微信依赖 `@wecom/aibot-node-sdk`；微信使用 Node.js fetch 与加解密 API；扫码共用 `qrcode`。
- `../runtime.ts` 创建 Bridge、恢复绑定并启停订阅；HTTP 路由调用 Registry 管理接入。
