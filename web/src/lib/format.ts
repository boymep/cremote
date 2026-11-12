import type { SessionSource, SessionStatus } from './protocol';

export function toMs(t: number | string | undefined | null): number {
  if (t == null) return 0;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Number(t);
  if (!Number.isNaN(n) && t.trim() !== '') return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(t);
  return Number.isNaN(d) ? 0 : d;
}

const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto', style: 'short' });
const dateFmt = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });

export function relativeTime(t: number | string, now: number): string {
  const ms = toMs(t);
  if (!ms) return '';
  const diff = Math.round((ms - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return 'только что';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return dateFmt.format(ms);
}

export function clockTime(t: number | string): string {
  const ms = toMs(t);
  return ms ? timeFmt.format(ms) : '';
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  live: 'активна',
  working: 'работает',
  idle: 'ожидает',
  awaiting_input: 'ждёт ввода',
  ended: 'завершена',
  history: 'история',
};

export const SOURCE_LABEL: Record<SessionSource, string> = {
  vscode: 'VS Code',
  cli: 'CLI',
  sdk: 'SDK',
  unknown: '—',
};

/** Путь относительно cwd сессии, если он внутри неё. */
/** «открыта в VS Code», «открыта в CLI» или просто «открыта». */
export function openLabel(source: SessionSource): string {
  return source === 'vscode' ? 'открыта в VS Code' : source === 'cli' ? 'открыта в CLI' : 'открыта';
}

export const OPEN_GUESS_HINT = 'Определено по времени изменения';

export function shortPath(p: string, cwd?: string): string {
  if (!p) return '';
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  const home = /^\/(Users|home)\/[^/]+/.exec(p);
  if (home) return '~' + p.slice(home[0].length);
  return p;
}

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** «через 2 ч 10 мин», «через 3 дн 4 ч», «через 5 мин», «сейчас». */
export function resetIn(t: string | null | undefined, now: number): string {
  const ms = toMs(t ?? undefined);
  if (!ms) return '';
  const mins = Math.round((ms - now) / 60_000);
  if (mins <= 0) return 'сейчас';
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `через ${d} дн${h ? ` ${h} ч` : ''}`;
  if (h > 0) return `через ${h} ч${m ? ` ${m} мин` : ''}`;
  return `через ${m} мин`;
}

const weekdayFmt = new Intl.DateTimeFormat('ru', { weekday: 'short' });

/** Местное время сброса: «14:30», «завтра 09:00», «пт 18:00», «12 нояб., 10:00». */
export function resetClock(t: string | null | undefined, now: number): string {
  const ms = toMs(t ?? undefined);
  if (!ms) return '';
  const day = (x: number) => {
    const d = new Date(x);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diffDays = Math.round((day(ms) - day(now)) / 86_400_000);
  const time = timeFmt.format(ms);
  if (diffDays === 0) return time;
  if (diffDays === 1) return `завтра ${time}`;
  if (diffDays > 1 && diffDays < 7) return `${weekdayFmt.format(ms)} ${time}`;
  return `${dateFmt.format(ms)}, ${time}`;
}

export type UsageLevel = 'normal' | 'warning' | 'danger' | 'exhausted';

/** ≥100 — исчерпан, 90–99 — почти, 70–89 — предупреждение (только цвет), иначе норма. */
export function usageLevel(pct: number): UsageLevel {
  return pct >= 100 ? 'exhausted' : pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'normal';
}

/** Слово уровня рядом с процентом: цвет не единственный сигнал. */
export const LEVEL_WORD: Record<UsageLevel, string> = {
  normal: '',
  warning: '',
  danger: 'почти',
  exhausted: 'исчерпан',
};

/** Короткая подпись окна: «5 ч», «7 дн». */
export function windowShort(id: string, label: string): string {
  return id === 'fiveHour' ? '5 ч' : id === 'sevenDay' ? '7 дн' : label;
}

/** Короткое время сброса: «через 2 ч» / «через 25 мин» в пределах суток, иначе «сб 22:00» или «12 нояб.». */
export function resetShort(t: string | null | undefined, now: number): string {
  const ms = toMs(t ?? undefined);
  if (!ms) return '';
  const mins = Math.round((ms - now) / 60_000);
  if (mins <= 0) return 'сейчас';
  if (mins < 60) return `через ${mins} мин`;
  if (mins < 24 * 60) return `через ${Math.round(mins / 60)} ч`;
  if (mins < 7 * 24 * 60) return `${weekdayFmt.format(ms)} ${timeFmt.format(ms)}`;
  return dateFmt.format(ms);
}
