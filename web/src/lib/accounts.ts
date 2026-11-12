// Общие помощники для аккаунтов Claude: подписи, короткие лимиты. Используют сводка на главном
// экране (AccountSummary) и раздел «Аккаунт» в настройках (AccountsBlock).
import type { AccountItem, Accounts, AccountWindow } from './protocol';
import { resetIn, toMs, usageLevel, type UsageLevel } from './format';

export function isActiveAccount(a: AccountItem, acc: Accounts | null): boolean {
  return a.active || (a.number !== null && a.number === acc?.activeNumber);
}

const fallbackName = (a: AccountItem) => (a.number !== null ? `Аккаунт ${a.number}` : 'Аккаунт');

export function accountName(a: AccountItem): string {
  return a.name || a.alias || (a.org && a.org !== a.email ? a.org : '') || a.email || fallbackName(a);
}

/** Email мелким серым текстом, если показанное имя на него не похоже. */
export function accountSecondary(a: AccountItem): string {
  return a.email && accountName(a) !== a.email ? a.email : '';
}

export function accountHeadline(a: AccountItem): string {
  const name = accountName(a);
  const parts = [name];
  if (accountSecondary(a)) parts.push(a.email);
  if (a.org && a.org !== a.email && a.org !== name) parts.push(a.org);
  return parts.join(' · ');
}

export const hasUsage = (a: AccountItem): boolean => a.usageStatus === 'ok' && a.windows.length > 0;

export function usageNote(a: AccountItem): string {
  return a.usageStatus === 'unavailable' || !a.usageStatus ? 'Лимиты недоступны' : `Лимиты недоступны: ${a.usageStatus}`;
}

export function loginNote(a: AccountItem, now: number): string {
  const ms = toMs(a.loginExpiresAt);
  if (!ms) return '';
  if (ms <= now) return 'Вход истёк';
  if (ms - now < 3 * 86_400_000) return `Вход истекает ${resetIn(a.loginExpiresAt, now)}`;
  return '';
}

export interface MiniWindow {
  short: string;
  pct: number;
  level: UsageLevel;
  /** «94%» или «исчерпан» — без обрезанных слов. */
  text: string;
}

export function miniWindow(w: AccountWindow): MiniWindow {
  const raw = Math.round(w.pct);
  const level = usageLevel(raw);
  const short = w.id === 'fiveHour' ? '5ч' : w.id === 'sevenDay' ? '7д' : w.label;
  const pct = Math.max(0, Math.min(100, raw));
  return { short, pct, level, text: level === 'exhausted' ? 'исчерпан' : `${pct}%` };
}
