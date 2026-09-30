# Agent Muster

在本地浏览器中管理多个 AI 编码 Agent、项目和对话，也可以通过钉钉机器人向 Agent 发送任务并接收回复。

## 功能

- 自动检测本机已安装的 Codex、Claude Code、Pi 和 Kimi CLI。
- 按项目管理对话，在多个窗口中查看和继续不同任务。
- 选择 Agent 和模型，实时查看回复、工具调用、执行状态及可用的 Token 用量。
- 保存项目和对话记录，支持停止正在运行的任务。
- 扫码创建钉钉应用，绑定项目和 Agent，将钉钉消息接入本地对话。

## 环境要求

- Node.js **22.19.0 或更高版本**。
- 要执行任务，需要先安装并配置至少一个支持的 Agent CLI，并确保其命令在 `PATH` 中可用。
- Agent 的登录、模型权限和费用由对应服务管理。

| Agent | 检测的命令 |
| --- | --- |
| Codex | `codex` |
| Claude Code | `claude` |
| Pi | `pi` |
| Kimi CLI | `kimi` |

## 快速开始

无需全局安装，直接启动：

```bash
npx agent-muster
```

启动后会自动打开浏览器，默认地址为：

```text
http://127.0.0.1:17321
```

也可以全局安装：

```bash
npm install -g agent-muster
agent-muster
```

保持启动终端运行，按 `Ctrl+C` 停止服务。

## 命令

| 命令 | 说明 |
| --- | --- |
| `agent-muster` | 启动 Web 界面并打开浏览器 |
| `agent-muster web` | 显式启动 Web 界面 |
| `agent-muster web --no-open` | 启动服务，不自动打开浏览器 |
| `agent-muster web --port 18000` | 指定监听端口 |
| `agent-muster agents` | 列出 Agent 及安装状态 |
| `agent-muster sessions` | 列出已保存的对话 |

端口和浏览器选项可以组合使用：

```bash
npx agent-muster web --port 18000 --no-open
```

服务仅监听本机地址 `127.0.0.1`，使用自定义端口时，请访问 `http://127.0.0.1:18000`。

## 创建第一个任务

1. 启动 Agent Muster，在 Web 界面添加一个本地项目目录。
2. 在该项目下新建对话，选择已安装的 Agent 和模型。
3. 输入任务并发送，例如：`检查这个项目的启动流程，说明如何运行。`
4. 在对话窗口查看回复、工具调用和执行状态，继续发送消息完成任务。

Agent 在选中的项目目录中执行任务。模型列表取决于对应 CLI 的配置与可用权限。

## 钉钉接入

1. 先在 Agent Muster 中添加项目，确认目标 Agent 可用。
2. 打开「钉钉接入」，点击「扫码创建应用」。
3. 使用钉钉扫描二维码，按授权页面提示完成应用创建和授权。
4. 为创建的应用选择项目和 Agent，可点击「一键同步」更新名称和图标。
5. 在钉钉中向该机器人发送消息，群聊中可通过提及机器人发送任务。

收到消息后，Agent Muster 会在绑定项目中调用选定的 Agent，任务结束后将回复发送回钉钉。同一钉钉会话会继续使用已有的本地对话；同一会话中的任务按顺序处理。

接入期间需要保持 Agent Muster 运行，并能连接钉钉服务。支持文本、图片和图文消息；当前 Kimi CLI 接入不支持图片输入。

删除 Web 界面中的 IM 接入会停止接收该应用的消息，已有对话记录会保留，钉钉中的应用不会被删除。

## 本地数据

项目、对话和钉钉接入配置保存在用户主目录下的 `.agent-muster` 中，重新启动后会读取已有记录。钉钉接入配置包含应用凭证。

## 常见问题

### Agent 显示未安装

在启动 Agent Muster 的终端中运行对应命令，确认 CLI 已安装且可以正常执行。安装或调整 `PATH` 后重新启动 Agent Muster。

### 默认端口被占用

通过 `--port` 指定其他端口：

```bash
npx agent-muster web --port 18000
```

### 钉钉机器人没有回复

确认本地服务仍在运行，应用已绑定项目和可用的 Agent，并已完成钉钉授权。可以在 Web 对话记录和启动终端中查看任务状态与错误信息。

## 更新

全局安装的用户可以运行：

```bash
npm install -g agent-muster@latest
```

使用 `npx` 时，可以明确指定最新版本：

```bash
npx agent-muster@latest
```
