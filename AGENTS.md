# Repository Guidelines

## 项目结构与模块组织

Agent Muster 是使用 TypeScript、Express、React 19 和 Vite 的本地 Agent 管理工具。

- `src/cli.ts`：命令行入口；`bin/agent-muster.js`：发布包启动入口。
- `src/server/`：HTTP 服务；`src/agents/`：Agent 注册、适配与安装管理。
- `src/projects/`、`src/sessions/`：项目及会话管理；`src/types.ts`：共享类型。
- `src/integrations/dingtalk/`、`src/integrations/feishu/`：平台配置与消息桥接。
- `web/src/`：React 页面、组件和样式；图标位于 `app-icon.tsx`，全局样式位于 `style.css`。
- `dist/`、`web/dist/`：构建产物，不提交。当前没有独立测试或静态资源目录。

## 构建与开发命令

使用 Node.js ≥22.19.0 和项目指定的 pnpm 10.33.4，在仓库根目录执行：

| 命令 | 用途 |
| --- | --- |
| `pnpm install` | 安装依赖，保持 `pnpm-lock.yaml` 一致 |
| `pnpm dev` | 启动源码开发服务，监听 CLI 变更，不自动打开浏览器 |
| `pnpm typecheck` | 检查服务端与前端的 TypeScript 类型 |
| `pnpm build` | 编译服务端并构建前端 |
| `pnpm start` | 启动已构建的本地 Web 服务，需先构建 |

## 编码风格与命名

遵循现有代码：两空格缩进、单引号、分号，启用 TypeScript 严格模式。组件、类和类型使用 PascalCase，函数与变量使用 camelCase，多词文件名采用 kebab-case，例如 `agent-panel.tsx`。服务端采用 NodeNext 模块解析，保持现有导入路径风格。仓库未配置 ESLint 或 Prettier，避免无关格式化。

实现应简洁、类型安全。只修改当前任务涉及的功能；修改函数前先理解原逻辑，并保留已有正确行为。不要过度设计或新增 fallback；环境变量不设置默认值；代码不使用 emoji。回复、代码注释和提交信息使用中文。

## 前端设计规范

涉及 `web/` 下的页面、组件、样式、布局或交互修改时：

- 开始修改前，必须读取并遵循 `web/DESIGN.md`。
- 完成修改后，按照该文档中的“设计检查”逐项自查。

## 验证要求

当前未配置测试框架、`test` 脚本、覆盖率门槛或测试命名规范。代码修改后执行 `pnpm typecheck` 和 `pnpm build`，并手动验证受影响流程，例如 CLI 参数、创建与继续会话、Agent 管理或 IM 消息收发。界面修改检查不同窗口布局。用户未明确要求时，不新增测试脚本或专门的项目说明文档。

## 提交与 Pull Request

近期功能提交使用 Conventional Commits，延续 `feat(模块): 描述`、`fix(模块): 描述`、`refactor(模块): 描述`，例如 `fix(cli): 修正端口参数校验`。新分支默认使用 `zsm/` 前缀。

PR 描述说明具体问题、修改后的行为和验证结果；有关联问题时附链接，界面变更附截图。提交范围保持聚焦，保留其他贡献者尚未提交的改动。

## 配置与凭证

本地数据保存在 `~/.agent-muster/`。其中 `dingtalk-apps.json`、`feishu-apps.json` 含应用凭证，不得提交或放入日志、截图及 PR。服务保持监听本机地址 `127.0.0.1`。
