# Agent Muster <版本号>

## 解决的问题

- <用户在什么场景遇到什么问题；升级后行为如何变化。>
- <关联 Issue / PR 链接。>

## 演示动图

<!-- 发布前替换为本版本实际演示动图，检查无凭证、个人目录或聊天内容。 -->
![本版本功能演示](<本版本动图地址>)

[功能操作实录（无声字幕）](https://sexyamole.github.io/agent-muster/#demo)

## 安装方式

在本 Release 的 Assets 选择系统与芯片对应的安装包：macOS Apple 芯片使用 arm64.dmg，Intel 使用 x64.dmg，Windows 64 位使用 x64-Setup.exe；Linux 使用 AppImage。

安装前确认至少一个 Agent CLI 已安装并完成登录。模型权限和费用由对应服务管理。

命令行方式需要 Node.js 22.19.0 或更高版本：

```bash
npx agent-muster@latest
```

[5 分钟完成第一个任务](https://github.com/sexyAmole/agent-muster/blob/main/docs/tutorials/first-task.md) · [10 分钟接入 IM](https://github.com/sexyAmole/agent-muster/blob/main/docs/tutorials/connect-im.md)

## 升级方式

桌面端：退出旧应用，从本 Release 下载对应安装包并安装，重新打开。升级前备份本地 `.agent-muster` 数据目录，勿将含凭证的备份公开。

全局命令行安装：运行 `agent-muster update`，完成后重启；临时运行使用 `npx agent-muster@latest`。

<!-- 如本版本涉及数据迁移、不兼容变更或特殊升级步骤，在此写明。 -->

## 已知限制

- Agent 登录、模型配置与费用由对应服务管理。
- IM 接收任务需要电脑、应用持续运行并联网。
- macOS 构建当前未公证；遇到系统拦截时，按组织安全要求处理。
- <本版本特有限制、受影响平台与后续处理链接；无新增限制时明确写明。>
