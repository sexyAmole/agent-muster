# 桌面模块

## 模块约定

- 主进程负责单实例、窗口和公共运行时；先恢复登录 Shell 的 PATH，再扫描 Agent；退出前等待运行时关闭。
- 桌面 HTTP 服务使用随机端口和独立 token，预加载仅向指定本地页面暴露运行时配置。
- 保持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`；IPC 校验窗口及主 frame 身份，对外只暴露明确方法和可取消的监听。
- 外部 HTTP/HTTPS 链接交给系统浏览器，内部页面导航和子窗口沿用内容隔离规则。
- 当前应用内更新面向 macOS DMG：核对版本、架构、下载地址与大小，下载完成后由用户替换安装包；CLI 的 npm 更新留在 CLI 模块。
- 修改预加载入口或共享接口时，同步核对构建脚本及 `web/src/` 的调用方；界面调整另行遵循 `web/DESIGN.md`。

## Structure

- `main.ts`：Electron 主入口、窗口、IPC 和服务生命周期。
- `preload.ts`：contextBridge 暴露运行时、窗口及更新接口。
- `window-controls.ts`：窗口控制与运行时配置契约。
- `update-api.ts`：更新 IPC 契约；`updates.ts`：版本查询与下载。

## Dependencies

- 依赖 `electron`、`semver` 和 Node.js 系统 API，通过 `../runtime.ts` 复用业务服务。
- 页面及加载页来自 `web/dist/`、`resources/desktop/`，打包由 `scripts/build.mjs` 与根目录 `package.json` 协调。
- `window-controls.ts`、`update-api.ts` 的类型供前端消费，保持与 Electron 运行时代码分离。
