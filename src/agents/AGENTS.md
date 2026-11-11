# Agent 管理模块

## 模块约定

- Agent 专属命令、模型、权限能力、安装信息和协议规则集中在 Provider；注册表与安装管理保持通用。
- 扫描只发现可执行文件和能力；模型、默认模型与版本按需查询，保持缓存刷新与重新扫描的语义。
- 安装、更新、卸载通过 `AgentManagement` 串行执行，操作前确认安装归属，操作后重新扫描并核对结果。
- 权限、沙箱和 IM 系统提示词校验复用 `settings.ts`，能力声明与实际启动参数保持一致。
- Agent 原生会话日志只读访问；文件由 Provider 根据会话定位，不能由客户端任意指定。
- Provider 通过 `providers/index.ts` 注册，每次执行创建独立 reader；原生协议转为标准事件，流式文本使用完整快照，同一内容块沿用稳定 `streamId`。
- 用量明确区分累计值、增量值与当前上下文，缺失时不编造数值；协议解析不承担会话落盘或 IM 推送。
- 扩展仅管理用户级 Skills/MCP，目录与能力集中维护。MCP 修改核对来源、revision 和文件变化，保留写入互斥及临时文件替换；Codex 通过 app-server 配置接口写入。
- Skills 导入校验绝对路径及 `SKILL.md`，先暂存复制再安装，拒绝同名覆盖和特殊文件；删除对象必须来自当前扫描结果。

## Structure

- `registry.ts`、`executable.ts`：Agent 注册、命令发现和按需信息查询。
- `management.ts`：安装归属、版本比较与安装器操作。
- `settings.ts`：权限、沙箱、系统提示词校验。
- `session-logs.ts`、`jsonl.ts`：原生 JSONL 日志读取、定位辅助和分页。
- `providers/index.ts`、`providers/shared.ts`、`providers/<agent>.ts`：注册、接口及各 Agent 的启动、协议与能力声明。
- `extensions/directories.ts`、`extensions/types.ts`：用户扩展目录和能力；`skills.ts`：技能管理；`mcp.ts`、`mcp-store.ts`、`codex-config.ts`：MCP 校验及配置读写。

## Dependencies

- 使用 Node.js 文件系统、路径和子进程 API；版本比较使用 `semver`，安装操作调用对应 CLI 或 npm。
- 扩展配置使用 `jsonc-parser`、`yaml` 保留 JSONC/YAML 结构，Codex、OpenCode 的部分配置操作依赖已安装 CLI。
- 对外契约依赖 `../types.ts`；Provider 接口定义在 `providers/shared.ts`。
- 由会话模块、HTTP 路由和 IM 模块调用；本模块不负责业务会话落盘或平台消息发送。
