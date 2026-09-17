import TelegramBot from 'node-telegram-bot-api';
import { config, secrets } from './config.js';
import type { Notification } from './types.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function usd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(2)}`;
}

function age(hours: number | null): string {
  if (hours === null) return 'inconnu';
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} j`;
}

export function formatNotification(n: Notification): string {
  const d = n.detection;
  const critical = d.level === 'critical';
  const header =
    n.kind === 'new'
      ? critical ? '🔴 <b>Critique</b>' : '🟡 <b>Alerte</b>'
      : '🔴 <b>Passe en critique</b>';

  const lines: string[] = [
    `${header} ${escapeHtml(d.symbol)}`,
    `${escapeHtml(d.name)}, score ${d.score}/100`,
    '',
    `Market cap ${usd(d.marketCap)}, liquidité ${usd(d.liquidity)}, âge ${age(d.ageHours)}`,
  ];

  if (d.reasons.length > 0) {
    lines.push('', '<b>Pourquoi</b>');
    for (const reason of d.reasons.slice(0, 5)) lines.push(`• ${escapeHtml(reason)}`);
  }

  if (d.warnings.length > 0) {
    lines.push('', '<b>Points d’attention</b>');
    for (const warning of d.warnings.slice(0, 3)) lines.push(`⚠️ ${escapeHtml(warning)}`);
  }

  const security =
    d.securityOk === true
      ? '🛡️ Contrôles de sécurité passés'
      : '🛡️ Sécurité non confirmée';
  lines.push('', security);

  const address = encodeURIComponent(d.address);
  lines.push(
    '',
    `<a href="https://dexscreener.com/solana/${address}">Dexscreener</a> | <a href="https://birdeye.so/token/${address}?chain=solana">Birdeye</a>`,
    `<code>${escapeHtml(d.address)}</code>`
  );

  return lines.join('\n');
}

export class TelegramNotifier {
  private bot: TelegramBot | null;

  constructor() {
    this.bot = config.dryRun ? null : new TelegramBot(secrets.telegramToken, { polling: false });
  }

  async send(notifications: Notification[]): Promise<number> {
    let sent = 0;
    for (const n of notifications) {
      if (config.telegramMinLevel === 'critical' && n.detection.level !== 'critical') continue;

      const text = formatNotification(n);
      if (!this.bot) {
        console.log(`📨 [test] ${text.split('\n')[0]}`);
        continue;
      }
      try {
        await this.bot.sendMessage(secrets.telegramChatId, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        sent++;
      } catch (error: any) {
        console.error(`❌ Telegram (${n.detection.symbol}) :`, error?.message ?? error);
      }
    }
    return sent;
  }
}
