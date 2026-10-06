# Agent Muster

English | [简体中文](./README.zh-CN.md)

Manage local AI coding agents, projects, and conversations in your browser. Send tasks and receive replies through DingTalk or Feishu bots.

## Features

- Detect installed Codex, Claude Code, Pi, and Kimi CLI agents.
- Organize conversations by project and work across one, two, or four conversation panes.
- Select agents and models, and view live replies, tool calls, execution status, and available token usage.
- Save projects and conversation history, resume conversations, and stop running tasks.
- Connect DingTalk and Feishu applications to local agents through the dedicated IM integration page.

## Requirements

- Node.js **22.19.0 or later**.
- Install and configure at least one supported agent CLI, with its command available in `PATH`.
- Authentication, model access, and charges are managed by each agent's provider.

| Agent | Detected command |
| --- | --- |
| Codex | `codex` |
| Claude Code | `claude` |
| Pi | `pi` |
| Kimi CLI | `kimi` |

## Quick Start

Run without a global installation:

```bash
npx agent-muster
```

The browser opens automatically at the default address:

```text
http://127.0.0.1:17321
```

Or install globally:

```bash
npm install -g agent-muster
agent-muster
```

Keep the terminal running. Press `Ctrl+C` to stop the service. The current web interface uses Chinese labels; their names are included below so you can find the relevant controls.

## Commands

| Command | Description |
| --- | --- |
| `agent-muster` | Start the web interface and open the browser |
| `agent-muster web` | Explicitly start the web interface |
| `agent-muster web --no-open` | Start without opening the browser |
| `agent-muster web --port 18000` | Use a custom listening port |
| `agent-muster agents` | List agents and their installation status |
| `agent-muster sessions` | List saved conversations |
| `agent-muster update` | Check for updates and update the global installation |

Combine port and browser options:

```bash
npx agent-muster web --port 18000 --no-open
```

The service listens only on `127.0.0.1`. With the custom port above, visit `http://127.0.0.1:18000`.

## Create Your First Task

1. Start Agent Muster and add a local project directory using **添加项目** (Add project).
2. Create a conversation in that project using **创建对话** (Create conversation), then select an installed agent and a model.
3. Enter a task, such as: `Inspect this project's startup flow and explain how to run it.`
4. Follow replies, tool calls, and execution status in the conversation pane. Send further messages to continue the task.

The agent runs in the selected project directory. Model availability depends on the corresponding CLI configuration and access permissions. Continuing a conversation requires a resumable session created by the agent.

## IM Integration

Open **IM 集成** (IM integration) in the sidebar and choose **钉钉** (DingTalk) or **飞书** (Feishu). Each application has its own project and agent binding.

| Capability | DingTalk | Feishu |
| --- | --- | --- |
| Application creation | Scan a QR code with DingTalk | Scan a QR code with Feishu |
| Message listener | DingTalk Stream SDK | Feishu SDK WebSocket connection |
| Incoming messages | Text, images, and rich text with images | Text |
| Conversations | Direct messages and group mentions of the bot | Direct messages and group mentions of the bot |
| Replies | Automatic agent replies and messages sent from the web interface | Automatic agent replies and messages sent from the web interface |
| Application management | Project/agent binding, name/icon sync, and local removal | Project/agent binding, name/icon sync, connection status, and local removal |

### Create and Connect an Application

1. Add a project in Agent Muster and confirm the target agent is installed and configured.
2. Open **IM 集成**, choose a platform, and click **扫码创建应用** (Create application by scanning).
3. Scan the QR code with the selected platform's mobile app. Follow the authorization page to create and authorize the application. If the QR code expires, request a new one.
4. Select a project and an agent for the new application. Click **一键同步** (Sync) to refresh its name and icon from the platform.
5. Send the bot a direct message, or add it to a group and mention it with a task. For Feishu, check that the application shows **消息监听已连接** (Message listener connected).

Keep Agent Muster running and connected to the selected platform. Messages are received through SDK connections established by the local service, so a public webhook address is not required.

### Receive Tasks and Reply

An incoming message starts a task using the bound agent in the bound project. When execution finishes, Agent Muster sends the result back to the original IM conversation.

Messages in the same IM conversation reuse its local agent session and are processed in order. Changing an application's project or agent binding clears its IM conversation mappings; the next incoming message starts a new local conversation.

DingTalk image input is supported by the Codex, Claude Code, and Pi integrations. The Kimi CLI integration does not support image input. The Feishu integration currently processes text messages only.

### Send Messages from the Web Interface

Open a conversation created through IM, then use the send-mode selector beside the message input:

- **发送到钉钉** / **发送到飞书** (Send to DingTalk / Feishu): send the entered text directly to the linked IM conversation as the application, without running the agent. The sent message is recorded in the local conversation.
- **交给 Agent** (Send to agent): continue the local agent task. This mode does not automatically send the resulting reply to IM.

Direct sending requires an existing IM conversation mapping. The Feishu sender splits long replies into multiple text messages.

### Remove an Integration

Click **删除** (Delete) on the application entry to remove its local integration and stop receiving its messages. Existing conversation history is retained. The application on DingTalk or Feishu is not deleted.

## Local Data

Projects, conversations, and IM configuration are stored in `.agent-muster` under your home directory and loaded again on startup. DingTalk and Feishu application credentials are stored in `dingtalk-apps.json` and `feishu-apps.json`, respectively. Keep these files private.

## FAQ

### An Agent Appears Uninstalled

Run its command in the terminal used to start Agent Muster. Confirm that the CLI is installed and works. Restart Agent Muster after installation or changes to `PATH`.

### The Default Port Is in Use

Choose another port:

```bash
npx agent-muster web --port 18000
```

### An IM Bot Does Not Reply

Confirm that Agent Muster is running, platform authorization is complete, and the application is bound to a project and an available agent. In groups, mention the bot. For Feishu, check its connection status and use a text message. Inspect the web conversation log and startup terminal for task status and errors.

### A Message Cannot Be Sent from the Web Interface

Send a message to the bot from IM first, then open the resulting local conversation. Confirm that the integration still exists and its project/agent binding has not changed. Select **发送到钉钉** or **发送到飞书** before sending.

## Updates

On web startup, Agent Muster checks for a newer version in the background and prints an update notice in the terminal.

For a global installation:

```bash
agent-muster update
```

This command checks the latest version and uses npm to update the global installation when an update is available. Restart the service afterward. You can also update manually:

```bash
npm install -g agent-muster@latest
```

When using `npx`, explicitly select the latest published version:

```bash
npx agent-muster@latest
```
