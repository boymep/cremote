import type { Block, Message, MetaBlock } from './types.js';

const MAX_IMAGE_B64 = 2 * 1024 * 1024;
const MAX_TOOL_RESULT = 20_000;
const STOP_FEEDBACK_PREFIX = 'Stop hook feedback:';
/** Header of a phone message handed to Claude by hooks (see Hub.takeQueued). */
export const PHONE_PREFIX = 'The user sent a message from their phone (cremote):';

/**
 * The phone message inside hook text: a Stop block reason, a Wait rewake
 * (`<task-notification>… Stop hook blocking error from command "Stop": …</system-reminder>`)
 * or PostToolUse additionalContext. Null when the text is not one.
 */
function phoneText(text: string): string | null {
  const i = text.indexOf(PHONE_PREFIX);
  if (i < 0) return null;
  let t = text.slice(i + PHONE_PREFIX.length);
  const end = t.lastIndexOf('</system-reminder>');
  if (end >= 0) t = t.slice(0, end);
  return t.trim();
}

type Json = Record<string, any>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strips `<tag>…</tag>` wrappers used by Claude Code for commands and reminders. */
export function stripTags(text: string): string {
  return text
    .replace(/<([a-zA-Z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?[a-zA-Z][\w-]*(\s[^>]*)?>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Header Claude Code puts before a message from another session or a subagent hand-back. */
const AGENT_MESSAGE_PREFIX = 'Another Claude session sent a message:';
const REPORT_FOLLOWS = 'The report follows:';
const INTERRUPT_RE = /^\[Request interrupted by user[^\]\n]*\]$/;
const SYSTEM_NOTICE_PREFIX = '[SYSTEM NOTIFICATION - NOT USER INPUT]';

function looksLikeServiceText(text: string): boolean {
  const t = text.trimStart();
  return /^<(command-|local-command-|system-reminder|task-notification|bash-|user-memory-input|ide_|agent-message)/.test(t)
    || t.startsWith('Caveat: The messages below were generated')
    || t.startsWith(AGENT_MESSAGE_PREFIX)
    || t.startsWith(SYSTEM_NOTICE_PREFIX)
    || INTERRUPT_RE.test(t.trim());
}

/** Noise without information for the reader: the caveat before locally run commands. */
function isCaveat(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<local-command-caveat>') || t.startsWith('Caveat: The messages below were generated');
}

function tagValue(text: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1].trim() : undefined;
}

/** First meaningful line for a caption: skips markdown headings, strips tags and list markers. */
function captionOf(text: string, max = 140): string {
  for (const raw of text.replace(/<\/?[a-zA-Z][\w-]*(\s[^>]*)?>/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^[-=*_]{3,}$/.test(line)) continue;
    const t = line.replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ');
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }
  return '';
}

/** Removes the two-space indent the harness adds to every line of a subagent report. */
function dedent(text: string): string {
  const lines = text.split('\n');
  const indented = lines.filter((l) => l.trim()).every((l) => l.startsWith('  '));
  return (indented ? lines.map((l) => l.slice(2)) : lines).join('\n').trim();
}

/** Report body of a subagent hand-back: between the frame line and the closing tag. */
function handbackBody(text: string, origin: Json | undefined): string | undefined {
  if (typeof origin?.handbackReportText === 'string' && origin.handbackReportText.trim()) {
    return origin.handbackReportText.trim();
  }
  const start = text.indexOf(REPORT_FOLLOWS);
  if (start < 0) return undefined;
  let body = text.slice(start + REPORT_FOLLOWS.length);
  const end = body.indexOf('</agent-message>');
  if (end >= 0) body = body.slice(0, end);
  return dedent(body.replace(/^\n/, ''));
}

/**
 * Classifies a harness-injected user entry so the client can show it as a compact system row
 * instead of a user bubble. Null for caveats, which carry nothing for the reader.
 */
export function systemBlock(text: string, origin?: Json): MetaBlock | null {
  const t = text.trim();
  if (isCaveat(t)) return null;
  const meta = (m: Omit<MetaBlock, 'kind' | 'text'>): MetaBlock => ({
    kind: 'meta',
    text: truncate(text, MAX_TOOL_RESULT),
    ...m,
    ...(m.body !== undefined ? { body: truncate(m.body, MAX_TOOL_RESULT) } : {}),
  });

  if (t.startsWith(AGENT_MESSAGE_PREFIX) || t.startsWith('<agent-message')) {
    const name = typeof origin?.name === 'string' ? origin.name : '';
    const report = origin?.handback === true || t.includes('[Subagent hand-back]');
    const body = report
      ? handbackBody(t, origin)
      : (tagValue(t, 'agent-message') ?? (typeof origin?.body === 'string' ? origin.body : undefined));
    const first = body ? captionOf(body) : '';
    const summary = [name, first].filter(Boolean).join(': ');
    return meta({ sys: report ? 'agent_report' : 'agent_message', summary, ...(body ? { body } : {}) });
  }
  if (t.startsWith('<task-notification')) {
    const summary = tagValue(t, 'summary') ?? '';
    const status = tagValue(t, 'status');
    const result = tagValue(t, 'result');
    const body = [summary, result].filter(Boolean).join('\n\n');
    return meta({
      sys: 'task',
      summary: captionOf(summary),
      ...(status ? { status } : {}),
      ...(body ? { body } : {}),
    });
  }
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) {
    const name = tagValue(t, 'command-name') ?? tagValue(t, 'command-message') ?? '';
    const args = tagValue(t, 'command-args') ?? '';
    return meta({ sys: 'command', summary: captionOf([name, args].filter(Boolean).join(' ')) });
  }
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) {
    const out = tagValue(t, 'local-command-stdout') ?? tagValue(t, 'local-command-stderr') ?? '';
    return meta({ sys: 'command', summary: captionOf(out), body: out });
  }
  if (INTERRUPT_RE.test(t)) return meta({ sys: 'interrupt' });
  const rest = t.startsWith(SYSTEM_NOTICE_PREFIX) ? t.slice(SYSTEM_NOTICE_PREFIX.length) : t;
  return meta({ sys: 'notice', summary: captionOf(rest) });
}

/** Removes the `[command]: ` prefix Claude Code puts before hook output. */
function cleanHookFeedback(text: string): string {
  let t = text.startsWith(STOP_FEEDBACK_PREFIX) ? text.slice(STOP_FEEDBACK_PREFIX.length) : text;
  t = t.trim();
  const m = /^\[[^\]\n]*\]:\s*/.exec(t);
  if (m) t = t.slice(m[0].length);
  return t;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (isObj(c) ? (c.type === 'text' ? String(c.text ?? '') : c.type === 'image' ? '[image]' : '') : ''))
    .filter(Boolean)
    .join('\n');
}

function userTextBlock(text: string, isMeta: boolean, origin?: Json): Block | null {
  if (!text.trim()) return null;
  const phone = phoneText(text);
  if (phone !== null) return { kind: 'hook_feedback', text: phone };
  if (text.trimStart().startsWith(STOP_FEEDBACK_PREFIX)) return { kind: 'hook_feedback', text: cleanHookFeedback(text) };
  if (isMeta || looksLikeServiceText(text)) return systemBlock(text, origin);
  return { kind: 'text', text };
}

function imageBlock(c: Json): Block | null {
  const src = c.source;
  if (!isObj(src) || src.type !== 'base64' || typeof src.data !== 'string') return null;
  if (src.data.length > MAX_IMAGE_B64) {
    const text = `Картинка ${src.media_type ?? ''} не передана: ${(src.data.length / 1048576).toFixed(1)} МБ`;
    return { kind: 'meta', text, sys: 'notice', summary: text };
  }
  return { kind: 'image', mediaType: String(src.media_type ?? 'image/png'), data: src.data };
}

function userBlocks(entry: Json): Block[] {
  const content = entry.message?.content;
  const kind = entry.origin?.kind;
  const isMeta = !!entry.isMeta || kind === 'peer' || kind === 'task-notification';
  const origin = isObj(entry.origin) ? entry.origin : undefined;
  const blocks: Block[] = [];
  if (typeof content === 'string') {
    const b = userTextBlock(content, isMeta, origin);
    if (b) blocks.push(b);
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === 'text') {
      const b = userTextBlock(String(c.text ?? ''), isMeta, origin);
      if (b) blocks.push(b);
    } else if (c.type === 'image') {
      const b = imageBlock(c);
      if (b) blocks.push(b);
    } else if (c.type === 'tool_result') {
      blocks.push({
        kind: 'tool_result',
        toolUseId: String(c.tool_use_id ?? ''),
        isError: !!c.is_error,
        text: truncate(toolResultText(c.content), MAX_TOOL_RESULT),
      });
    }
  }
  return blocks;
}

function assistantBlocks(entry: Json): Block[] {
  const content = entry.message?.content;
  const blocks: Block[] = [];
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) blocks.push({ kind: 'text', text: c.text });
    else if (c.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim())
      blocks.push({ kind: 'thinking', text: c.thinking });
    else if (c.type === 'tool_use')
      blocks.push({ kind: 'tool_use', id: String(c.id ?? ''), name: String(c.name ?? ''), input: c.input ?? {} });
  }
  return blocks;
}

/**
 * Attachments that carry user-visible content: prompts queued mid-turn and phone messages
 * delivered mid-turn as PostToolUse additionalContext.
 * Stop-hook feedback is also written as an attachment, but the paired isMeta user entry
 * ("Stop hook feedback:\n<reason>") already covers it.
 */
function attachmentMessage(entry: Json): { role: 'user'; blocks: Block[] } | null {
  const a = entry.attachment;
  if (!isObj(a)) return null;
  if (a.type === 'queued_command' && a.commandMode === 'prompt' && !a.isMeta) {
    const blocks = userBlocks({ message: { content: a.prompt }, origin: a.origin });
    return blocks.length ? { role: 'user', blocks } : null;
  }
  if (a.type === 'hook_additional_context' && Array.isArray(a.content)) {
    const blocks: Block[] = [];
    for (const c of a.content) {
      const t = typeof c === 'string' ? phoneText(c) : null;
      if (t) blocks.push({ kind: 'hook_feedback', text: t });
    }
    return blocks.length ? { role: 'user', blocks } : null;
  }
  return null;
}

export function normalizeEntry(entry: unknown): Message | null {
  if (!isObj(entry) || typeof entry.uuid !== 'string') return null;
  let role: 'user' | 'assistant';
  let blocks: Block[];
  if (entry.type === 'user') {
    role = 'user';
    blocks = userBlocks(entry);
  } else if (entry.type === 'assistant') {
    role = 'assistant';
    blocks = assistantBlocks(entry);
  } else if (entry.type === 'attachment') {
    const m = attachmentMessage(entry);
    if (!m) return null;
    role = m.role;
    blocks = m.blocks;
  } else {
    return null;
  }
  if (!blocks.length) return null;
  return {
    uuid: entry.uuid,
    role,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
    blocks,
    isSidechain: !!entry.isSidechain,
  };
}

/** First human-typed text of a user entry, for titles. Returns '' when the entry is not a real prompt. */
export function promptText(entry: Json): string {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return '';
  const kind = entry.origin?.kind;
  if (kind && kind !== 'human') return '';
  const content = entry.message?.content;
  const parts: string[] =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.filter((c) => isObj(c) && c.type === 'text').map((c) => String(c.text ?? ''))
        : [];
  for (const p of parts) {
    if (p.trimStart().startsWith(STOP_FEEDBACK_PREFIX)) continue;
    const t = stripTags(p);
    if (t) return t.slice(0, 80);
  }
  return '';
}
