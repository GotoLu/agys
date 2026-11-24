# AGENTS.md

## 项目定位

`agy-account` 是一个面向 macOS 的本地多账号凭证快照与切换工具（TypeScript / Node.js），用于在多个独立订阅的 Google AI Pro 账号之间安全、快速地切换 Antigravity 桌面客户端与 `agy` CLI 的登录态。

## 核心目录及职责

- `src/cli.ts` -- CLI 入口与命令分发（交互式菜单、`save`、`use`、`ls`、`current`、`inspect`、`rm`）
- `src/ui/` -- 终端交互与 ANSI 样式组件
  - `prompt.ts` -- 原生 TTY 方向键选择器、文本输入与二次确认（零外部依赖）
- `src/core/` -- 核心业务模块
  - `keychain.ts` -- macOS Keychain 读写与元数据枚举（基于系统 `security` CLI）
  - `oauth.ts` -- Google OAuth2 + PKCE 本地回调认证与令牌换取
  - `quota.ts` -- 按需查询 Google Cloud Code 5 小时与周额度及 OAuth Token 自动刷新
  - `snapshot.ts` -- 账号快照的采集、加密存储（AES-256-GCM）与安全恢复
  - `paths.ts` -- Antigravity 客户端、CLI 与本地 Vault 路径管理
  - `process.ts` -- Antigravity 桌面端进程检测与安全重启提示
- `src/types.ts` -- 账号元数据与快照数据结构定义
- `test/` -- 单元测试（使用 Node 原生 `node:test`，Mock Keychain 与文件系统）

## 文档指针

- 使用说明与命令示例：[README.md](./README.md)
- 当前进度、决策与验证记录：[ROADMAP.md](./ROADMAP.md)

## 工程边界与安全红线

1. **零遥测、零外部上报**：本工具仅在本地操作 macOS Keychain、Antigravity 本地状态文件与本地加密 Vault，严禁向任何第三方域名发送 Token 或账号信息。
2. **禁止自动轮询/并发代理**：仅实现人工显式触发的切换操作，不实现自动 round-robin 代理或后台高频刷额度轮询。
3. **保护敏感凭证**：
   - 本地 Vault 默认权限为 `0700`（目录）/ `0600`（文件），并对凭证内容使用 AES-256-GCM 加密（密钥托管于 macOS Keychain）。
   - 任何日志、测试输出、报错信息与文档中严禁打印真实 OAuth Token 或完整凭证内容。
4. **安全切换保护**：执行 `use` 覆盖当前凭证前，必须自动保存或校验当前状态备份，避免未保存的新账号登录态意外丢失。

## 验证入口

- 类型检查：`npm run typecheck`
- 编译构建：`npm run build`
- 单元测试：`npm test`
