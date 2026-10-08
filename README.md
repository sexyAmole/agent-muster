# Agent Muster
<img width="100%" height="auto" alt="Image" src="https://github.com/user-attachments/assets/ab4dc1cb-b7ae-4186-a006-13f321ca6f5b" />
English | [简体中文](./README.zh-CN.md)

Manage local AI coding agents, projects, and conversations in your browser. Send tasks and receive replies through DingTalk or Feishu bots.

## Features

- Detect installed Codex, Claude Code, Pi, Kimi CLI, Gemini CLI, OpenCode, and Cursor agents.
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
| Gemini CLI | `gemini` |
| OpenCode | `opencode` |
| Cursor | `cursor-agent` |

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
| `agent-muster help` | Show help; also available as `--help` or `-h` |
| `agent-muster --version` | Print the current version and exit; also available as `-v` |

The `web` command is optional. Combine port and browser options:

```bash
npx agent-muster web --port 18000 --no-open
npx agent-muster -p 18000 --no-open
```

| Web option | Description |
| --- | --- |
| `-p, --port <port>` | Set the listening port to an integer from 1 to 65535; defaults to 17321 |
| `--no-open` | Start without opening the browser |
| `--dev` | Enable development mode; requires the source checkout and development dependencies |

Use `agent-muster web --help` to show help. Unknown commands, unsupported options, and invalid ports produce an error before the service starts.

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
| Incoming messages | Text, images, and rich text with images | Text, images, and rich text with images |
| Conversations | Direct messages and group mentions of the bot | Direct messages and group mentions of the bot |
| Replies | Automatic agent replies and messages sent from the web interface | Automatic agent replies and messages sent from the web interface |
| Chat commands | New conversations, project/model switching, and current configuration | New conversations, project/model switching, and current configuration |
| Application management | Project/agent binding, name/icon sync, and local removal | Project/agent binding, name/icon sync, connection status, and local removal |

### Create and Connect an Application

1. Add a project in Agent Muster and confirm the target agent is installed and configured.
2. Open **IM 集成**, choose a platform, and click **扫码创建应用** (Create application by scanning).
3. Scan the QR code with the selected platform's mobile app. Follow the authorization page to create and authorize the application. If the QR code expires, request a new one.
4. Select a project and an agent for the new application. Click **一键同步** (Sync) to refresh its name and icon from the platform.
5. Send the bot a direct message, or add it to a group and mention it with a task. For Feishu, check that the application shows **消息监听已连接** (Message listener connected).

Keep Agent Muster running and connected to the selected platform. Messages are received through SDK connections established by the local service, so a public webhook address is not required.

### Receive Tasks and Reply

An incoming task message starts a task using the application's bound agent in the project selected for that chat. A new chat initially uses the application's bound project, which can then be changed with a command. When execution finishes, Agent Muster sends the result back to the original IM conversation.

Messages in the same IM conversation reuse its local agent session and are processed in order. Changing an application's project or agent binding in the Web interface clears the session mappings and project/model settings for all of that application's chats; the next task message starts a new local conversation.

Both DingTalk and Feishu support standalone images and multiple images within rich-text messages. Images are passed to the agent as attachments. Image-only messages use “请查看这张图片。” as the task prompt. In groups, mention the bot; a Feishu rich-text message can include a mention, text, and images together.

Image input is supported by the Codex, Claude Code, Pi, Gemini CLI, and OpenCode integrations, provided the selected model supports images. The Kimi CLI and Cursor integrations currently reject image attachments with an explanation. Supported formats are PNG, JPEG, GIF, and WebP.

Feishu downloads user images through the message resource API. Newly created applications request the `im:message:readonly` permission. For existing applications, enable this permission in the Feishu developer console and publish a new application version. The bot returns an explanation if an image download fails.

### IM Chat Commands

DingTalk and Feishu support the same commands. Send a text command directly in a private chat, or mention the bot when sending a command in a group. Send each command as a separate message. Agent Muster handles commands directly without submitting them as agent tasks.

| Command | Behavior |
| --- | --- |
| `/new` | Clear the current chat's session mapping so the next task starts a new conversation; keep history and the selected project/model |
| `/projects` | List registered projects with their numbers, names, and full paths |
| `/project <number or full path>` | Switch the current chat's project; the next task starts a new conversation |
| `/models` | List the bound agent's available models with their numbers, names, and IDs |
| `/model <number or model ID>` | Switch the current chat's model for the next task while continuing the current conversation |
| `/model default` | Use the agent's default model for the next task |
| `/status` | Show the current project, agent, model, and local conversation ID |
| `/help` | Show command help |

For example, send `/projects`, then `/project 2` to select the second project. Send `/models`, then `/model 1` to select the first model. Next, send your task message. To start a separate task in the current project, send `/new` before sending the new task.

Projects must already be registered in Agent Muster, and models must appear in the current agent's available model list. Numbers refer to the corresponding list; full project paths and model IDs are also accepted. Invalid commands, projects, or models return an explanation without changing the configuration.

Command changes affect only the current private or group chat. Group members share its configuration and conversation; other chats are unaffected. Project and model settings persist across service restarts. Commands and tasks are processed in order, so a command waits for earlier tasks to finish.

### Send Messages from the Web Interface

Open a conversation created through IM, then use the send-mode selector beside the message input:

- **发送到钉钉** / **发送到飞书** (Send to DingTalk / Feishu): send the entered text directly to the linked IM conversation as the application, without running the agent. The sent message is recorded in the local conversation.
- **交给 Agent** (Send to agent): continue the local agent task. This mode does not automatically send the resulting reply to IM.

Direct sending requires an existing IM conversation mapping. The Feishu sender splits long replies into multiple text messages.

### Remove an Integration

Click **删除** (Delete) on the application entry to remove its local integration and stop receiving its messages. Existing conversation history is retained. The application on DingTalk or Feishu is not deleted.

## Local Data

Projects, conversations, and IM configuration are stored in `.agent-muster` under your home directory and loaded again on startup. DingTalk and Feishu application credentials are stored in `im/dingtalk/apps.json` and `im/feishu/apps.json`, respectively. Keep these files private.

## FAQ

### An Agent Appears Uninstalled

Run its command in the terminal used to start Agent Muster. Confirm that the CLI is installed and works. Restart Agent Muster after installation or changes to `PATH`.

### The Default Port Is in Use

Choose another port:

```bash
npx agent-muster web --port 18000
```

### An IM Bot Does Not Reply

Confirm that Agent Muster is running, platform authorization is complete, and the application is bound to a project and an available agent. In groups, mention the bot. For Feishu, check its connection status; if image downloads fail, confirm that `im:message:readonly` is enabled and the application version has been published. Inspect the web conversation log and startup terminal for task status and errors.

### A Message Cannot Be Sent from the Web Interface

Send a message to the bot from IM first, then open the resulting local conversation. Confirm that the integration still exists and its project/agent binding has not changed. Select **发送到钉钉** or **发送到飞书** before sending.

## Updates

Check the version of the CLI you are running:

```bash
agent-muster --version
agent-muster -v
```

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
