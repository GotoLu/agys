# Changelog

All notable changes to `agys` (`agy-account`) are documented in this file.

## [0.1.0] - 2026-11-24

### Added

- **Google OAuth2 + PKCE 一键添加账号**：`agys add` 直接拉起浏览器完成授权，自动识别邮箱并写入兼容官方 `go-keyring-base64:` 格式的 macOS Keychain 凭证，无需二次登录即可直接切换。
- **实时 5 小时 / 周额度查看**：`agys quota`、`agys ls` 与 `agys use` 按需查询 Google Cloud Code 5 小时与周剩余额度及重置倒计时，支持 OAuth Token 自动刷新。
- **循环交互式终端菜单**：运行 `agys` 进入零外部依赖的原生 TTY 交互菜单，支持方向键 `↑`/`↓`（或 `j`/`k`）选择与 `Esc`/`q` 返回。
- **双端联动与插件登录态隔离**：同步切换 `agy` CLI 与 Antigravity Desktop 登录态，支持 `--restart` 等待旧进程完全退出后再安全重启，并按服务粒度保护 `antigravity.plugins`（如 Google Drive / Docs）不被误删。
- **本地 AES-256-GCM 加密 Vault 与防误覆盖保护**：凭证快照加密存于 `~/.config/agy-account/`（`0700` / `0600`），主密钥由 macOS Keychain 托管；切换前自动备份未保存的新账号登录态为 `_auto_backup`。
