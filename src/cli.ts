#!/usr/bin/env node
import { MacOSKeychainAdapter } from './core/keychain.js';
import { startGoogleOAuthLogin } from './core/oauth.js';
import { resolveAppPaths } from './core/paths.js';
import { isAntigravityDesktopRunning, restartAntigravityDesktop } from './core/process.js';
import {
  type AccountQuotaSummary,
  fetchAccountQuota,
  formatPercent,
  formatResetCountdown,
  refreshOAuthTokenIfNeeded,
} from './core/quota.js';
import { AccountManager, MissingKeychainBindingError } from './core/snapshot.js';
import type { AccountMeta } from './types.js';
import { askText, confirm, isInteractiveTty, selectOption, style, waitForEnter } from './ui/prompt.js';

function printHelp(): void {
  console.log(`${style.bold('agy-account (agys)')} -- Antigravity 客户端 & agy CLI 本地多账号切换器

${style.bold('用法:')}
  agys                         进入循环交互式操作菜单（终端下）
  agys add [alias] [--email]   发起 Google OAuth 浏览器授权并添加新账号
  agys save [alias] [--email]  将当前已登录账号加密保存为别名
  agys use [alias|-] [--restart | --no-restart]
                               切换到指定账号（不填则交互选择并显示 5h/周额度）
  agys ls [--no-quota]         列出所有已保存账号及实时 5 小时/周额度
  agys quota                   查看所有已绑定 OAuth 账号的 5 小时/周额度详情
  agys current                 显示当前激活账号
  agys inspect                 检查本机凭证存储位置与当前登录状态（不输出密钥）
  agys rm [alias] [-y|--yes]   删除指定账号快照
  agys help                    显示此帮助信息
`);
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

type QuotaLookupResult =
  | { status: 'ok'; summary: AccountQuotaSummary }
  | { status: 'no-oauth' }
  | { status: 'error'; message: string };

async function fetchQuotasForAccounts(
  manager: AccountManager,
  accounts: AccountMeta[],
): Promise<Map<string, QuotaLookupResult>> {
  const results = new Map<string, QuotaLookupResult>();

  await Promise.all(
    accounts.map(async (acc) => {
      const oauth = manager.getOAuthCredentials(acc.alias);
      if (!oauth) {
        results.set(acc.alias, { status: 'no-oauth' });
        return;
      }

      try {
        const { oauth: activeOAuth, refreshed } = await refreshOAuthTokenIfNeeded(oauth);
        if (refreshed) {
          manager.updateOAuthCredentials(acc.alias, activeOAuth);
        }
        const summary = await fetchAccountQuota(activeOAuth.accessToken);
        if (summary.error) {
          results.set(acc.alias, { status: 'error', message: summary.error });
        } else {
          results.set(acc.alias, { status: 'ok', summary });
        }
      } catch (err) {
        results.set(acc.alias, {
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  return results;
}

function colorizeFraction(fraction: number | null, text: string): string {
  if (fraction === null) return text;
  if (fraction >= 0.5) return style.green(text);
  if (fraction >= 0.2) return style.yellow(text);
  return style.red(text);
}

function formatQuotaInline(result: QuotaLookupResult | undefined, includeReset = false): string {
  if (!result || result.status === 'no-oauth') {
    return style.yellow('未绑定 OAuth');
  }
  if (result.status === 'error') {
    return style.red(`额度查询失败(${result.message})`);
  }

  const { fiveHourRemaining, fiveHourResetTime, weeklyRemaining, weeklyResetTime } = result.summary;
  const h5Pct = colorizeFraction(fiveHourRemaining, formatPercent(fiveHourRemaining));
  const wkPct = colorizeFraction(weeklyRemaining, formatPercent(weeklyRemaining));

  const h5Reset = includeReset ? formatResetCountdown(fiveHourResetTime) : null;
  const wkReset = includeReset ? formatResetCountdown(weeklyResetTime) : null;

  const h5Str = h5Reset ? `5h: ${h5Pct}(${h5Reset})` : `5h: ${h5Pct}`;
  const wkStr = wkReset ? `周: ${wkPct}(${wkReset})` : `周: ${wkPct}`;
  return `${h5Str} | ${wkStr}`;
}

function printInspect(manager: AccountManager): void {
  const info = manager.inspect();
  console.log(style.bold('\n=== 本机 Antigravity 凭证测绘 ==='));
  console.log(`当前激活别名:   ${info.activeAlias ? style.cyan(info.activeAlias) : '(未记录)'}`);
  console.log(
    `匹配已保存别名: ${info.matchedAlias ? style.green(info.matchedAlias) : style.yellow('(未匹配，建议先 save 保存)')}`,
  );
  console.log(`识别邮箱:       ${info.detectedEmail ?? '(未识别)'}`);
  console.log(`状态指纹:       ${info.fingerprint}`);

  console.log(style.bold('\n[macOS Keychain 命中条目]'));
  if (info.keychainEntries.length === 0) {
    console.log(style.yellow('  (未找到 gemini / antigravity.plugins 条目)'));
  } else {
    for (const item of info.keychainEntries) {
      console.log(`  ${style.cyan('•')} service=${style.bold(item.service)}  account=${item.account}`);
    }
  }

  console.log(style.bold('\n[本地状态文件]'));
  for (const file of info.stateFiles) {
    const status = file.exists ? style.green(`存在 (${file.sizeBytes} B)`) : '(不存在)';
    console.log(`  ${style.cyan('•')} [${file.key}] ${file.path} -> ${status}`);
  }

  const running = isAntigravityDesktopRunning();
  console.log(`\nAntigravity Desktop 运行中: ${running ? style.green('是') : '否'}\n`);
}

async function printList(manager: AccountManager, withQuota = true): Promise<void> {
  const { activeAlias, previousAlias, accounts } = manager.list();
  if (accounts.length === 0) {
    console.log(style.yellow('\n暂无已保存的账号。请选择「添加新账号 (OAuth)」或「保存当前账号」。'));
    return;
  }

  let quotas = new Map<string, QuotaLookupResult>();
  if (withQuota) {
    process.stdout.write(style.cyan('\n正在查询各账号 5 小时与周额度...\n'));
    quotas = await fetchQuotasForAccounts(manager, accounts);
  }

  const maxAliasLen = Math.max(...accounts.map((a) => a.alias.length), 6);
  console.log(style.bold('\n已保存的账号:'));
  for (const acc of accounts) {
    const isActive = acc.alias === activeAlias;
    const isPrev = acc.alias === previousAlias;
    const marker = isActive ? style.green('●') : isPrev ? style.yellow('○') : ' ';
    const aliasText = isActive
      ? style.cyan(style.bold(acc.alias.padEnd(maxAliasLen)))
      : acc.alias.padEnd(maxAliasLen);
    const emailText = (acc.email ?? '(未备注邮箱)').padEnd(24);
    const tag = isActive
      ? style.green('[当前]')
      : isPrev
        ? style.yellow('[上次]')
        : '      ';
    const quotaText = withQuota
      ? `  ${formatQuotaInline(quotas.get(acc.alias), true)}`
      : '';
    console.log(`  ${marker} ${aliasText}  ${emailText} ${tag}${quotaText}  [${formatShortTime(acc.updatedAt)}]`);
  }
  console.log('');
}

async function handleSave(manager: AccountManager, aliasArg?: string, emailArg?: string): Promise<boolean> {
  let alias = aliasArg;
  let email = emailArg;

  if (!alias) {
    if (!isInteractiveTty()) {
      throw new Error('请指定别名，例如: agys save pro1');
    }
    const info = manager.inspect();
    const suggested = info.matchedAlias ?? `pro${manager.list().accounts.length + 1}`;
    alias = await askText('请输入账号别名 (仅限字母/数字/_/-)', suggested);
    if (!email) {
      const detected = info.detectedEmail ?? undefined;
      const inputEmail = await askText('备注邮箱 (可选，直接回车跳过)', detected);
      if (inputEmail) email = inputEmail;
    }
  }

  const meta = manager.save(alias, email);
  console.log(
    `${style.green('✔')} 已加密保存账号 ${style.bold(meta.alias)}${meta.email ? ` (${meta.email})` : ''} [指纹: ${meta.fingerprint}]`,
  );
  return true;
}

function suggestAliasFromEmail(email: string | null, fallbackIndex: number): string {
  if (email) {
    const local = email.split('@')[0]?.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24);
    if (local) return local;
  }
  return `pro${fallbackIndex}`;
}

async function bindClientKeychainInteractively(
  manager: AccountManager,
  alias: string,
  email: string | null,
): Promise<boolean> {
  const info = manager.inspect();
  if (info.keychainEntries.length > 0 && !info.matchedAlias) {
    console.log(style.yellow('\n⚠ 检测到本机当前客户端登录态尚未保存进 Vault。'));
    const saveFirst = await confirm('是否先保存当前客户端账号，再继续绑定新账号？', true);
    if (saveFirst) {
      await handleSave(manager);
    }
  }

  const { autoBackedUp } = manager.clearLiveSession();
  if (autoBackedUp) {
    console.log(style.yellow('已自动将原客户端登录态备份为 "_auto_backup"。'));
  }

  console.log(style.cyan(`\n--- 绑定客户端登录态: ${alias}${email ? ` (${email})` : ''} ---`));
  console.log(`1. 请另开一个终端运行 ${style.bold('agy')}（或在 Antigravity 桌面端中）登录 ${style.bold(email ?? '该账号')}；`);
  console.log('2. 登录完成后回到这里按回车，即可自动捕获客户端登录态并与 OAuth 凭证合并。\n');

  if (isAntigravityDesktopRunning()) {
    const restartNow = await confirm('检测到 Antigravity Desktop 正在运行，是否重启它以弹出登录界面？', false);
    if (restartNow) {
      restartAntigravityDesktop();
    }
  }

  while (true) {
    await waitForEnter(`完成 ${alias} 的客户端/agy 登录后，按回车键捕获并合并（或 Ctrl+C 取消）...`);
    const afterInfo = manager.inspect();
    if (afterInfo.keychainEntries.length === 0) {
      console.log(style.yellow('⚠ 暂未检测到客户端 Keychain 登录态，请确认已完成 agy 或桌面端登录。'));
      const retry = await confirm('是否继续等待重试？', true);
      if (!retry) {
        console.log('已跳过绑定。你随时可通过「切换账号」或再次登录后执行 save 来完成绑定。');
        return false;
      }
      continue;
    }

    const merged = manager.save(alias, email ?? undefined);
    console.log(
      `${style.green('✔')} 已合并绑定客户端登录态到 ${style.cyan(style.bold(merged.alias))}${merged.email ? ` (${merged.email})` : ''}！`,
    );
    return true;
  }
}

async function handleAdd(manager: AccountManager, aliasArg?: string, emailArg?: string): Promise<boolean> {
  console.log(style.cyan('\n--- 启动 Google OAuth2 浏览器授权 ---'));
  console.log('正在启动本地回调服务并打开浏览器，请在浏览器中选择目标 Google AI Pro 账号并授权...\n');

  const oauth = await startGoogleOAuthLogin({
    onAuthUrl: (url) => {
      console.log('若浏览器未自动打开，请手动复制以下链接到浏览器完成授权:');
      console.log(style.cyan(url));
      console.log('');
    },
  });

  console.log(
    `${style.green('✔')} OAuth 授权成功！账号邮箱: ${style.bold(oauth.email ?? '(未返回邮箱)')}`,
  );

  let alias = aliasArg;
  if (!alias) {
    if (!isInteractiveTty()) {
      alias = suggestAliasFromEmail(oauth.email, manager.list().accounts.length + 1);
    } else {
      const suggested = suggestAliasFromEmail(oauth.email, manager.list().accounts.length + 1);
      alias = await askText('请输入该账号的保存别名 (仅限字母/数字/_/-)', suggested);
    }
  }

  const meta = manager.saveOAuthAccount(alias, oauth, {
    includeLiveKeychain: false,
    emailOverride: emailArg,
  });

  console.log(
    `${style.green('✔')} 已加密保存账号 ${style.cyan(style.bold(meta.alias))}${meta.email ? ` (${meta.email})` : ''} [OAuth + Keychain 已就绪]`,
  );

  if (isInteractiveTty()) {
    const switchNow = await confirm(`是否立即切换到新账号 "${meta.alias}"？`, false);
    if (switchNow) {
      await handleUse(manager, meta.alias);
    }
  }

  return true;
}

async function handleUse(
  manager: AccountManager,
  targetArg?: string,
  options: { restart?: boolean; noRestart?: boolean } = {},
): Promise<boolean> {
  let target = targetArg;

  if (!target) {
    if (!isInteractiveTty()) {
      throw new Error('请指定目标别名或 "-"，例如: agys use pro2');
    }
    const { activeAlias, previousAlias, accounts } = manager.list();
    if (accounts.length === 0) {
      console.log(style.yellow('\n暂无已保存的账号，请先选择「添加新账号 (OAuth)」或「保存当前账号」。'));
      return true;
    }

    process.stdout.write(style.cyan('\n正在查询各账号 5 小时与周额度...\n'));
    const quotas = await fetchQuotasForAccounts(manager, accounts);

    const defaultIndex = Math.max(
      0,
      accounts.findIndex((a) => a.alias === previousAlias),
    );
    const chosen = await selectOption(
      '选择要切换的 Google AI Pro 账号',
      accounts.map((acc) => {
        const badges: string[] = [];
        if (acc.alias === activeAlias) badges.push('当前');
        if (acc.alias === previousAlias) badges.push('上次');
        const badgeText = badges.length > 0 ? `[${badges.join('/')}] ` : '';
        const quotaInline = formatQuotaInline(quotas.get(acc.alias), false);
        return {
          label: acc.alias,
          hint: `${badgeText}${acc.email ?? '未备注邮箱'} | ${quotaInline}`,
          value: acc.alias,
        };
      }),
      defaultIndex,
      'Esc/q 返回上一级',
    );
    if (!chosen) {
      // Esc / q returns directly to the previous menu without extra prompt.
      return false;
    }
    target = chosen;
  }

  let switchedResult: ReturnType<AccountManager['use']>;
  try {
    switchedResult = manager.use(target);
  } catch (err) {
    if (err instanceof MissingKeychainBindingError && isInteractiveTty()) {
      console.log(style.yellow(`\n⚠ ${err.message}`));
      const bindNow = await confirm(
        `是否现在引导登录 "${err.alias}" 的客户端/agy 会话并完成切换？`,
        true,
      );
      if (!bindNow) {
        return true;
      }
      const bound = await bindClientKeychainInteractively(manager, err.alias, err.email);
      if (!bound) {
        return true;
      }
      switchedResult = manager.use(err.alias);
    } else {
      throw err;
    }
  }

  const { switchedTo, autoBackedUp } = switchedResult;
  if (autoBackedUp) {
    console.log(style.yellow('⚠ 检测到当前登录态尚未保存，已自动备份为 "_auto_backup"。'));
  }
  console.log(
    `${style.green('✔')} 已切换至账号 ${style.cyan(style.bold(switchedTo.alias))}${switchedTo.email ? ` (${switchedTo.email})` : ''}。`,
  );

  if (isAntigravityDesktopRunning()) {
    let shouldRestart = Boolean(options.restart);
    if (!options.restart && !options.noRestart && isInteractiveTty()) {
      shouldRestart = await confirm('检测到 Antigravity Desktop 正在运行，是否立即重启以加载新凭证？', true);
    }
    if (shouldRestart) {
      console.log('正在重启 Antigravity 桌面客户端...');
      restartAntigravityDesktop();
      console.log(`${style.green('✔')} Antigravity 桌面客户端已重新启动。`);
    } else {
      console.log(style.yellow('提示: 请手动重启 Antigravity 桌面端（或加 --restart）以加载新凭证。'));
    }
  }
  console.log('提示: 若当前已有运行中的 agy CLI 会话，请退出并重新启动 agy 以加载新凭证。');
  return true;
}

async function handleRemove(manager: AccountManager, aliasArg?: string, skipConfirm = false): Promise<boolean> {
  let alias = aliasArg;
  if (!alias) {
    if (!isInteractiveTty()) {
      throw new Error('请指定要删除的别名，例如: agys rm pro1');
    }
    const { accounts } = manager.list();
    if (accounts.length === 0) {
      console.log(style.yellow('\n暂无可删除的账号。'));
      return true;
    }
    const chosen = await selectOption(
      '选择要删除的账号快照',
      accounts.map((a) => ({
        label: a.alias,
        hint: a.email ?? '未备注邮箱',
        value: a.alias,
      })),
      0,
      'Esc/q 返回上一级',
    );
    if (!chosen) {
      return false;
    }
    alias = chosen;
  }

  if (!skipConfirm && isInteractiveTty()) {
    const ok = await confirm(`确认永久删除账号快照 ${style.bold(alias)}？`, false);
    if (!ok) {
      console.log('已取消删除。');
      return true;
    }
  }

  const removed = manager.remove(alias);
  if (!removed) {
    console.log(style.yellow(`未找到别名 "${alias}"。`));
    process.exitCode = 1;
    return true;
  }
  console.log(`${style.green('✔')} 已删除账号快照 "${alias}"。`);
  return true;
}

async function runInteractiveHome(manager: AccountManager): Promise<void> {
  while (true) {
    const { activeAlias, accounts } = manager.list();
    const activeMeta = accounts.find((a) => a.alias === activeAlias);
    const header = activeAlias
      ? `当前激活: ${style.cyan(style.bold(activeAlias))}${activeMeta?.email ? ` (${activeMeta.email})` : ''}`
      : style.yellow('当前未记录激活账号');

    console.log(`\n${style.bold('agy-account')} | ${header}`);

    const action = await selectOption<'use' | 'add' | 'save' | 'ls' | 'inspect' | 'rm' | 'exit'>(
      '请选择操作',
      [
        { label: '切换账号', hint: `已保存 ${accounts.length} 个账号，含实时 5h/周额度`, value: 'use' },
        { label: '添加新账号 (OAuth)', hint: '打开浏览器完成 Google OAuth 授权并保存', value: 'add' },
        { label: '保存当前账号', hint: '将当前已登录状态直接保存为别名', value: 'save' },
        { label: '查看账号与额度', hint: '列出所有账号及 5 小时/周剩余额度', value: 'ls' },
        { label: '本机凭证测绘', hint: '检查 Keychain 与本地状态文件', value: 'inspect' },
        { label: '删除账号快照', hint: '移除指定本地快照', value: 'rm' },
        { label: '退出', value: 'exit' },
      ],
      0,
      'Esc/q 退出',
    );

    if (!action || action === 'exit') {
      console.log(style.cyan('已退出 agy-account。'));
      return;
    }

    let shouldPause = true;
    try {
      switch (action) {
        case 'use':
          shouldPause = await handleUse(manager);
          break;
        case 'add':
          shouldPause = await handleAdd(manager);
          break;
        case 'save':
          shouldPause = await handleSave(manager);
          break;
        case 'ls':
          await printList(manager, true);
          break;
        case 'inspect':
          printInspect(manager);
          break;
        case 'rm':
          shouldPause = await handleRemove(manager);
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${style.red('错误:')} ${message}`);
    }

    if (shouldPause) {
      await waitForEnter();
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  const paths = resolveAppPaths();
  const keychain = new MacOSKeychainAdapter();
  const manager = new AccountManager(paths, keychain);

  if (!cmd) {
    if (isInteractiveTty()) {
      await runInteractiveHome(manager);
    } else {
      printHelp();
    }
    return;
  }

  switch (cmd) {
    case 'inspect':
      printInspect(manager);
      break;

    case 'add': {
      const alias = args[1] && !args[1].startsWith('-') ? args[1] : undefined;
      const email = parseFlagValue(args, '--email');
      await handleAdd(manager, alias, email);
      break;
    }

    case 'save': {
      const alias = args[1] && !args[1].startsWith('-') ? args[1] : undefined;
      const email = parseFlagValue(args, '--email');
      await handleSave(manager, alias, email);
      break;
    }

    case 'use': {
      const target = args[1] && (!args[1].startsWith('-') || args[1] === '-') ? args[1] : undefined;
      await handleUse(manager, target, {
        restart: args.includes('--restart'),
        noRestart: args.includes('--no-restart'),
      });
      break;
    }

    case 'ls':
    case 'list':
      await printList(manager, !args.includes('--no-quota'));
      break;

    case 'quota':
      await printList(manager, true);
      break;

    case 'current': {
      const { activeAlias, accounts } = manager.list();
      if (!activeAlias) {
        console.log(style.yellow('当前未记录激活账号。可运行 agys inspect 检查本机状态。'));
        return;
      }
      const acc = accounts.find((a) => a.alias === activeAlias);
      console.log(`${style.cyan(style.bold(activeAlias))}${acc?.email ? ` (${acc.email})` : ''}`);
      break;
    }

    case 'rm':
    case 'remove': {
      const alias = args[1] && !args[1].startsWith('-') ? args[1] : undefined;
      const skipConfirm = args.includes('--yes') || args.includes('-y');
      await handleRemove(manager, alias, skipConfirm);
      break;
    }

    default:
      console.error(`${style.red('未知命令:')} ${cmd}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${style.red('错误:')} ${message}`);
  process.exitCode = 1;
});
