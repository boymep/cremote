import { marked, Renderer, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/** Контекст для локальных ссылок: сервер резолвит относительные пути от cwd сессии. */
export interface MdContext {
  cwd?: string;
  sessionId?: string;
  /** Абсолютный каталог открытого файла: относительные ссылки внутри него считаются от этого каталога. */
  baseDir?: string;
}

export const FILE_API = '/api/file';

/** Склеивает каталог и относительный путь, схлопывая `.` и `..`. */
export function joinPath(base: string, rel: string): string {
  const out: string[] = [];
  for (const seg of `${base}/${rel}`.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** URL эндпоинта `GET /api/file` для пути (абсолютного, `~/…` или относительного). */
export function fileUrl(path: string, ctx?: MdContext): string {
  if (ctx?.baseDir && !path.startsWith('/') && !path.startsWith('~') && !/^file:/i.test(path)) {
    path = joinPath(ctx.baseDir, path);
  }
  const session = ctx?.sessionId ? `session=${encodeURIComponent(ctx.sessionId)}&` : '';
  return `${FILE_API}?${session}path=${encodeURIComponent(path)}`;
}

/** Ссылка ведёт на локальный файл, а не в сеть, якорь или data:. */
export function isLocalHref(href: string): boolean {
  const h = href.trim();
  if (!h || h.startsWith('#') || h.startsWith('//') || h.startsWith(FILE_API)) return false;
  if (/^file:/i.test(h)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(h);
}

/** Текст `code` похож на путь к файлу: `/a/b`, `~/x`, `src/a.ts`, допускается `:12` и `#L3`. */
export function looksLikePath(text: string): boolean {
  if (!text || text.length > 300 || /\s/.test(text) || text.includes('://')) return false;
  if (/[<>|*?"`$]/.test(text)) return false;
  const t = text.replace(/(?::\d+){1,2}$/, '').replace(/#L\d+(?:-L?\d+)?$/, '');
  if (t.startsWith('/') || t.startsWith('~/')) {
    return t.length > 1 && (t.slice(1).includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t));
  }
  return t.includes('/') && /\.[A-Za-z0-9]{1,8}$/.test(t) && !t.endsWith('/');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

let hooked = false;
function ensureHook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      if ((node.getAttribute('href') ?? '').startsWith(`${FILE_API}?`)) {
        // Локальный файл открывается во встроенном просмотрщике (Markdown.svelte), не в новой вкладке.
        node.setAttribute('data-file', '1');
        node.removeAttribute('target');
        return;
      }
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Markdown → безопасный HTML. Единственный источник строк для {@html}. */
export function renderMarkdown(src: string, ctx?: MdContext): string {
  ensureHook();
  const renderer = new Renderer();
  const codespan = renderer.codespan.bind(renderer);
  renderer.codespan = (token: Tokens.Codespan) => {
    const html = codespan(token);
    return looksLikePath(token.text) ? `<a href="${fileUrl(token.text, ctx)}">${html}</a>` : html;
  };
  const table = renderer.table.bind(renderer);
  renderer.table = (token: Tokens.Table) => `<div class="table-wrap">${table(token)}</div>`;
  const html = marked.parse(src, {
    async: false,
    renderer,
    walkTokens(token) {
      if ((token.type === 'link' || token.type === 'image') && isLocalHref(token.href)) {
        token.href = fileUrl(safeDecode(token.href), ctx);
      }
    },
  }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
    FORBID_ATTR: ['style'],
  });
}
