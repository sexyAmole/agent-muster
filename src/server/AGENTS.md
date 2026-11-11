# HTTP 服务模块

## 模块约定

- `startServer()` 接收已加载的业务实例并挂载路由，模块组装与 IM 订阅启动由 `../runtime.ts` 负责。
- 服务只监听 `127.0.0.1`；Host、Origin 校验需使用实际监听端口，兼容桌面端随机端口启动。
- 桌面请求校验独立 token 和来源，保持与预加载、前端请求及终端 WebSocket 的认证规则一致。
- 图片路由在 JSON 中间件前挂载，保留二进制请求体；其他 API 使用受大小限制的 JSON 请求体。
- 开发模式使用 Vite 中间件并随 HTTP 服务关闭；生产模式提供 `web/dist/` 和页面路由入口。
- 终端只接受已注册项目或已有会话目录；关闭入口向运行时暴露，项目移除时调用项目终端清理接口。
- 路由工厂接收业务实例，负责参数校验和响应组装；会话元信息、消息历史、原生日志与 SSE 分开提供，分页和补发遵循 [存储契约](../../docs/message-storage.md)。
- SSE 补发与实时监听交接保持同一同步流程，游标取查询参数与 `Last-Event-ID` 的较大值，推送 ID 保持已发送最大值；断开时释放监听和心跳。
- 项目删除先解除 IM 项目及会话绑定，再停止并移除关联会话、移除项目数据，最后关闭终端；文件监听随请求关闭释放。
- Agent 安装操作与会话执行保留互斥检查，手动 IM 推送成功后再标记原输出事件，平台配置响应使用 Registry 的脱敏列表。

## Structure

- `index.ts`：HTTP 创建、安全中间件、路由、页面与终端挂载。
- `routes/agents.ts`、`routes/extensions.ts`：Agent 安装、Skills 与 MCP。
- `routes/projects.ts`：项目、文件、Git 和变更监听；`routes/sessions.ts`、`routes/images.ts`：会话、队列、历史、SSE、推送和图片。
- `routes/dingtalk.ts`、`routes/feishu.ts`、`routes/wecom.ts`、`routes/weixin.ts`：平台接入与应用配置。

## Dependencies

- 依赖 `express`、Node.js HTTP/路径 API；开发模式按需加载 `vite`。
- 使用 AgentRegistry、AgentManagement、ProjectRegistry、SessionManager 及各平台 Registry。
- WebSocket 终端由 `../terminals/server.ts` 提供，页面来自 `web/dist/`，CLI 与桌面端通过公共运行时调用本模块。
