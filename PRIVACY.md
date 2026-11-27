# Privacy Policy / 隐私说明

`agys` (`agy-account`) 是一个纯本地运行的 macOS 命令行工具，设计原则是 **零遥测、零第三方上报、凭证仅存于本机**。

## 本地存储的数据

- 账号元数据（别名、邮箱、创建时间等）与加密后的登录态快照保存在本机 `~/.config/agy-account/` 目录（目录权限 `0700`，文件权限 `0600`）。
- 快照使用 `AES-256-GCM` 加密，加密主密钥托管于本机 macOS Keychain，不以明文落盘。

## 网络请求边界

本工具不包含任何分析统计、崩溃上报或第三方后端。仅在用户主动执行相关命令时，直接与 Google 官方接口通信：

- `agys add`：通过本地回调端口向 Google OAuth2 官方端点完成授权与令牌换取。
- `agys quota` / `agys ls` / `agys use`（未传 `--no-quota` 时）：使用已授权账号的 OAuth Token 直接查询 Google 官方 Cloud Code 额度接口，并在 Token 过期时自动刷新。

## 不收集的数据

- 不收集、上传或记录用户的代码、对话内容、终端输出或使用行为。
- 终端日志、报错输出与 `agys inspect` 均不会打印明文 OAuth Token 或完整 Keychain 密钥。
