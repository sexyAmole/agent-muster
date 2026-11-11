# 源码模块

## 模块约定

- 本目录继承根目录规范；进入子模块修改前，读取对应目录的 `AGENTS.md`。
- `runtime.ts` 是 CLI 与桌面端共用的组装入口：先加载注册表和历史，再恢复 IM 绑定、创建 Bridge、启动 HTTP 服务及平台订阅。
- 新增需要常驻的资源时，同时接入运行时关闭流程，保证订阅、终端、Agent 子进程和 HTTP 连接能够结束。
- 跨模块及前后端共享契约放在 `types.ts`；磁盘记录类型留在会话模块，平台原生消息类型留在各平台模块。
- 源码使用 NodeNext 的 `.js` 导入路径；业务模块通过注册表、Manager 或明确接口协作。

## Structure

- `cli.ts`、[cli/](./cli/AGENTS.md)：命令行入口与命令分发。
- [desktop/](./desktop/AGENTS.md)：Electron 主进程、预加载和桌面更新。
- [agents/](./agents/AGENTS.md)：Agent 发现、安装管理、协议与用户扩展配置。
- [projects/](./projects/AGENTS.md)：项目注册、文件访问和 Git 操作。
- [sessions/](./sessions/AGENTS.md)：会话执行、消息队列和持久化。
- [integrations/](./integrations/AGENTS.md)：IM 指令、回复与各平台接入。
- [server/](./server/AGENTS.md)：HTTP 路由、静态页面和终端挂载。
- [terminals/](./terminals/AGENTS.md)：项目终端与 WebSocket 协议。
- `runtime.ts`：模块组装与关闭；`types.ts`：共享类型；`debug.ts`：调试开关。

## Dependencies

- CLI、桌面入口依赖 `runtime.ts`；运行时组装 Agent、项目、会话、IM 和服务端模块。
- `types.ts` 由服务端与 `web/src/` 共同消费，保持为无运行时平台依赖的契约层。
- 第三方包及构建入口以根目录 `package.json`、`scripts/build.mjs` 为准；可执行入口和桌面预加载的打包方式需与它们一致。
