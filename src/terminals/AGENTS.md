# 项目终端模块

## 模块约定

- 每个项目路径共享一个 PTY 与屏幕状态，多个客户端连接同一终端；客户端断开仅解除连接，项目关闭和服务退出才销毁终端。
- WebSocket 升级校验 Host、Origin、桌面 token 及已知项目路径，保持与 HTTP 服务的本机访问边界一致。
- 消息严格校验类型、文本和终端尺寸范围；限制请求负载与客户端待发送缓冲，心跳及时清理失联连接。
- PTY 输出完成 headless 屏幕解析后再广播；重连先发送屏幕快照，再接收后续输出，保证顺序一致。
- 调整尺寸同步 PTY、headless 屏幕和所有客户端；退出时释放进程、屏幕、连接及心跳。
- Unix 使用已配置的 `SHELL` 启动登录 Shell，环境缺失直接报告错误。

## Structure

- `protocol.ts`：客户端输入/尺寸消息与服务端快照/输出/退出消息类型。
- `server.ts`：WebSocket 升级、PTY、屏幕缓存、广播和资源释放。

## Dependencies

- 依赖 `node-pty`、`ws`、`@xterm/headless`、`@xterm/addon-serialize` 和 Node.js HTTP 类型。
- 上级 HTTP 服务注入项目路径校验函数，项目路由使用 `closeProject()`，运行时使用 `shutdown()`。
- 协议由前端终端组件共同消费，修改消息结构时同步核对调用方。
