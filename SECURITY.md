# Security Policy / 安全策略

## 安全设计原则

- **本地加密存储**：账号快照使用 `AES-256-GCM` 加密存储于 `~/.config/agy-account/`（`0700` / `0600`），主密钥由 macOS Keychain 托管。
- **零第三方传输**：不会向 Google 官方 OAuth / Cloud Code 接口之外的任何域名发送凭证或账号信息。
- **防误覆盖保护**：执行 `agys use` 前自动检测当前本机登录态，未保存的新账号会自动备份为 `_auto_backup`。
- **插件登录态隔离**：切换主账号时按服务粒度处理 `gemini` 与 `antigravity.plugins`，避免误删 Google Drive / Docs 等插件登录态。

## 报告安全漏洞

如果您发现潜在的安全问题（例如凭证泄露风险、权限校验缺陷或加密实现问题），请**不要**直接在公开 Issue 中披露细节。

请通过 GitHub Security Advisory（`Security -> Advisories -> Report a vulnerability`）私下提交，我们会在确认后尽快评估并发布修复版本。
