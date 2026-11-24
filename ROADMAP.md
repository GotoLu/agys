# ROADMAP.md

## 项目状态概览

- **当前阶段**：MVP 已实现并通过构建与单元测试验证，待本地双账号切号实测
- **目标平台**：macOS（Antigravity Desktop + `agy` CLI）

## 进行中

- [ ] 本机双账号实测闭环（`save pro1` -> 换号登录 -> `save pro2` -> `use pro1 --restart` 验证）

## 待确认

- `agy` CLI 与 Antigravity Desktop 切换时是否需要同步替换更多 `AppStorage` 字段，待东哥双账号实测后确认。

## 后续规划（Phase 2）

- [x] 按需查询单账号/全账号当前额度（`quota` / `ls` / `use` 界面实时展示 5 小时与周额度，仅手动触发，不做后台轮询）
- [ ] 可选支持多组模型额度明细展开查看

## 最近完成

- 2026-11-24 16:51 按服务粒度隔离 `gemini` 与 `antigravity.plugins` 切换策略：目标快照不含插件条目时保留本机现有 Google Drive 等插件登录态；目标快照含插件条目时同步切换。
- 2026-11-24 16:45 解析并兼容官方 `go-keyring-base64:` Keychain 凭证格式（`encodeGoKeyringSecret` / `decodeGoKeyringOAuth`），`agys add` 一次 OAuth 授权即可直接 `agys use` 切换，无需二次登录；同时修复 `restartAntigravityDesktop` 轮询等待旧进程彻底退出后再拉起桌面端。
- 2026-11-24 16:36 新增 `MissingKeychainBindingError` 与 `bindClientKeychainInteractively` 一体化引导向导，`agys add` 授权后可直接引导完成客户端登录态合并绑定；`agys use` 遇到未绑定 Keychain 的账号时可当场引导补绑并完成切换。
- 2026-11-24 16:31 实现按需 5 小时与周额度查询模块（`src/core/quota.ts`，含 OAuth Token 自动刷新与重置倒计时），并在 `ls`、`use`、`quota` 界面实时展示；修复子菜单按 `Esc`/`q` 取消返回上一级时多余的回车停顿。
- 2026-11-24 16:19 实现 Google OAuth2 + PKCE 本地认证流程（`src/core/oauth.ts`），`agys add` 支持直接拉起浏览器完成 Google 授权并加密保存 OAuth 凭证与邮箱。
- 2026-11-24 16:12 将交互式主菜单升级为驻留循环模式（操作完成或取消后按回车返回主菜单，不退出进程），新增 `add` 添加新账号引导流程及 `clearLiveSession()` 安全清理机制，并优化菜单文字对比度。
- 2026-11-24 16:07 完成全局使用适配（`build` 自动赋予 `dist/cli.js` 可执行权限，新增短命令别名 `agys`，并更新 [README.md](./README.md) 全局使用指南）。
- 2026-11-24 16:05 完成 CLI 交互体验升级（新增 `src/ui/prompt.ts`，支持无参数进入交互式主菜单、`use` / `save` / `rm` 方向键选择与引导输入、切换后交互询问重启桌面端、ANSI 彩色列表展示）。
- 2026-11-24 16:02 完成 MVP 核心模块（`src/core/keychain.ts`、`src/core/snapshot.ts`、`src/core/paths.ts`、`src/core/process.ts`）与 CLI 命令（`inspect`、`save`、`use`、`ls`、`current`、`rm`），更新 [README.md](./README.md) 与 [ROADMAP.md](./ROADMAP.md)。
- 2026-11-24 16:00 完成本地环境测绘与技术选型（Node v24.18.0 + TypeScript），初始化项目骨架与文档。

## 最近验证

- 2026-11-24 16:51 执行 `npm run typecheck && npm run build && npm test`，5 个测试套件共 11 条测试用例全部通过。
- 2026-11-24 16:45 执行 `npm run typecheck && npm run build && npm test`，5 个测试套件共 10 条测试用例全部通过。
- 2026-11-24 16:36 执行 `npm run typecheck && npm run build && npm test`，5 个测试套件共 9 条测试用例全部通过。
- 2026-11-24 16:31 执行 `npm run typecheck && npm run build && npm test`，5 个测试套件共 9 条测试用例全部通过。
- 2026-11-24 16:19 执行 `npm run typecheck && npm run build && npm test`，4 个测试套件共 8 条测试用例全部通过。
- 2026-11-24 16:12 执行 `npm run typecheck && npm run build && npm test`，3 个测试套件共 6 条测试用例全部通过。
- 2026-11-24 16:02 执行 `node dist/cli.js inspect` 实机只读测绘，命中 macOS Keychain（`gemini` / `antigravity.plugins`）及 3 个本地状态文件（`credential-user-scope`、`antigravity_state.pbtxt`、`jetski_state.pbtxt`）。
