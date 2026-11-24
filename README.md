# agys (agy-account)

面向 **macOS** 的 Google Antigravity 桌面客户端与 `agy` CLI 本地多账号切换工具（TypeScript / Node.js 零运行时依赖实现）。

## 特性

- **OAuth 一键添加**：内置 Google OAuth2 + PKCE 浏览器授权，授权后自动识别邮箱并生成官方 Keychain 登录态，无需二次登录即可直接切换。
- **实时额度查看**：支持按需查询并展示每个账号的 **5 小时（5h）** 与 **周（Weekly）** 剩余额度及重置倒计时，切号前一目了然。
- **循环交互式终端菜单**：直接运行 `agys` 进入驻留菜单，支持方向键 `↑`/`↓`（或 `j`/`k`）选择、`Esc`/`q` 返回上一级。
- **双端联动与插件保护**：切换时同步更新 `agy` CLI 与 Antigravity Desktop（支持 `--restart` 自动重启），并保护 Google Drive / Docs 等 `antigravity.plugins` 登录态不被误删。
- **纯本地 AES-256-GCM 加密**：账号快照加密保存在本机 `~/.config/agy-account/`（权限 `0600`），加密主密钥由 macOS Keychain 托管，零遥测上报。
- **防误覆盖保护**：切换前自动校验当前登录态，未保存的新账号会自动备份为 `_auto_backup`。

## 快速安装

> **系统要求**：仅支持 **macOS**，需要 **Node.js >= 22.0.0**。

```bash
git clone https://github.com/GotoLu/agys.git
cd agys
npm install
npm run build
npm link
```

安装完成后，在任意终端目录均可直接使用 `agys`（或 `agy-account`）。

## 常用命令

```bash
# 直接运行进入循环交互式操作菜单（支持 ↑/↓ 或 j/k 移动，Esc/q 返回或退出）
agys
# 或 agy-account

# 发起 Google OAuth2 浏览器授权并添加新账号（自动识别邮箱并生成 Keychain 登录态）
agys add
agys add pro2 --email your2@example.com

# 交互式选择要切换的账号（展示实时 5h/周额度；支持指定别名或 "-" 切回上一个）
agys use
agys use pro2 --restart
agys use -

# 保存当前本机已登录账号（不填别名则交互引导输入）
agys save
agys save pro1 --email your@example.com

# 列出所有已保存账号及 5 小时/周额度（加 --no-quota 跳过查询）
agys ls
agys quota
agys current

# 查看本机 Antigravity 凭证位置与状态摘要（不输出明文密钥）
agys inspect

# 删除指定账号快照（交互确认，或加 -y 跳过确认）
agys rm pro1
```

## 安全与使用边界

- **纯本地运行**：除向 Google 官方 OAuth 与 Cloud Code 额度接口发起用户主动触发的请求外，不向任何第三方服务器发送数据。
- **人工按需切换**：仅用于个人独立订阅账号的人工显式切换与额度查看，请勿用于自动化高频轮询或并发代理。

## 开发与验证

```bash
npm install
npm run typecheck
npm run build
npm test
```
