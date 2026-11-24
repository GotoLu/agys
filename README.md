# agy-account

面向 macOS 的 Google Antigravity 桌面客户端与 `agy` CLI 本地多账号切换工具（TypeScript 实现）。

## 特性

- **纯本地、零遥测**：只读写本地加密快照与 macOS Keychain，不联网上传任何凭证。
- **AES-256-GCM 加密存储**：账号快照加密保存在本地 `~/.config/agy-account/`（权限 `0600`），加密主密钥由 macOS Keychain 托管。
- **双端联动**：覆盖 Keychain 中的 Antigravity / `agy` OAuth 凭证及本地 scope 状态。
- **防误覆盖保护**：切换前自动检查并备份当前激活状态。

## 全局安装与使用

在项目目录执行一次构建与全局链接即可在任意路径使用 `agy-account` 或短命令 `agys`：

```bash
npm run build
npm link
```

链接后即可全局调用：

```bash
# 直接运行进入循环交互式操作菜单（支持 ↑/↓ 或 j/k 方向键选择，操作后按回车返回菜单）
agys
# 或 agy-account

# 发起 Google OAuth2 浏览器授权并添加新账号（自动识别邮箱并加密保存凭证）
agys add
agys add pro2 --email your2@gmail.com

# 交互式选择要切换的账号（也支持直接指定别名或 "-" 切回上一个）
agys use
agys use pro2 --restart
agys use -

# 保存当前已登录账号（不填别名则交互引导输入）
agys save
agys save pro1 --email your@gmail.com

# 查看本机当前 Antigravity 凭证位置与状态摘要（不输出明文密钥）
agys inspect

# 列出已保存的账号（默认同时展示 5 小时与周额度，加 --no-quota 跳过查询）
agys ls
agys quota
agys current

# 删除指定账号快照（交互确认，或加 -y 跳过确认）
agys rm pro1
```

如需全局直接使用 `agy-account` 命令，可在项目目录执行 `npm link`。

## 系统要求与安全说明

- **运行环境**：仅支持 **macOS**，需要 **Node.js >= 22.0.0**。
- **隐私与安全**：所有账号凭证均通过 AES-256-GCM 加密保存在本机 `~/.config/agy-account/`（密钥由 macOS Keychain 托管），无任何遥测或第三方数据上报。
- **使用边界**：仅用于个人多账号人工显式切换，请勿用于自动化高频轮询或并发代理。

## 开发与验证

```bash
npm install
npm run typecheck
npm run build
npm test
```
