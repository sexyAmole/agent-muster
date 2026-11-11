# 命令行模块

## 模块约定

- `index.ts` 负责命令分发；参数解析、展示、Web 启动和包更新分别放在对应文件。
- 帮助、版本和全局更新在加载运行时前处理，避免为这些命令扫描 Agent 或加载本地历史。
- 参数在 `options.ts` 集中校验，未知命令、未知参数和非法端口给出明确错误；帮助文本随参数变化同步更新。
- Web 启动复用公共运行时，收到退出信号时调用其关闭接口；CLI 全局 npm 更新与 Electron 安装包更新分别维护。

## Structure

- `index.ts`：主流程；上级 `cli.ts` 是源码启动入口。
- `options.ts`：参数类型、解析与校验。
- `commands.ts`：帮助、版本、Agent 和会话列表输出。
- `web.ts`：Web 启动、浏览器打开和退出信号处理。
- `updates.ts`：npm 版本查询及全局更新。

## Dependencies

- 通过 `../runtime.ts` 加载并启动服务，使用 `../debug.ts` 设置调试状态。
- 列表输出依赖 AgentRegistry、SessionManager 的公开接口。
- 使用 Node.js 文件系统和子进程 API；更新依赖 npm CLI 与 `semver`，版本信息读取根目录 `package.json`。
