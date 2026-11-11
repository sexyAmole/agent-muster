# 会话模块

## 模块约定

- 修改磁盘记录、恢复、历史分页或流式事件时，先阅读 [会话与消息存储规范](../../docs/message-storage.md)，实现与契约同步更新。
- Manager 管理执行、状态、队列、事件编号、用量和广播；Store 管理文件、迁移和历史读取；原生协议解析留在 Provider。
- 每个会话同时只运行一个 Agent 进程。排队消息保存发送时的模型、权限、沙箱和图片引用；停止或重启后暂停队列，由用户继续。
- 追加持久事件前先保存元信息，再写事件、更新缓存并广播；运行时缓存仅供实时展示，完整历史和 IM 结果通过存储接口读取。
- 每次执行使用独立 reader 与执行 UUID，避免续聊复用流式标识；快照、完成事件和清理事件保持相同内容块的关联。
- 累计用量按 Provider 的累计/增量标志合并，当前上下文覆盖更新且允许下降与零值；两者通过完整 `usage` 事件持久化。
- 停止、删除和关闭等待进程结束并清理监听、定时器及未完成快照；任务状态与子进程是否仍存在分别判断。
- Agent 原生日志只读访问；图片持久化保存文件引用，运行时 Base64 不进入业务记录。

## Structure

- `manager.ts`：会话生命周期、消息队列、子进程和事件发布。
- `store.ts`：JSONL 存储、图片、pending 快照、历史与迁移。
- `records.ts`：磁盘类型、元信息差量和接口事件转换。
- `events.ts`：按 `streamId` 合并及展示排序。
- `line-reader.ts`：UTF-8 数据块解码、分行和末尾内容处理。

## Dependencies

- 依赖 `../types.ts`、Agent Provider/Adapter、权限校验及原生日志读取工具。
- Store 复用 `../projects/storage.ts` 的目录规则，使用 Node.js 文件系统；旧 SQLite 导入按需加载 `node:sqlite`。
- HTTP 路由和 IM Bridge 通过 SessionManager 协作；本模块不依赖 Express 或平台 SDK。
