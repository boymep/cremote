import { structuredPatch } from 'diff';
import { shortPath, truncate } from './format';

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function compactJson(v: unknown, max = 160): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? '';
  } catch {
    s = String(v);
  }
  return truncate(s, max);
}

export function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? '';
  } catch {
    return String(v);
  }
}

export interface ToolSummary {
  /** Короткое имя действия: Edit, Bash, Read… */
  verb: string;
  /** Путь, команда, паттерн или компактный JSON. */
  detail: string;
  /** Детали показывать моноширинным шрифтом. */
  mono: boolean;
}

export function toolSummary(name: string, input: unknown, cwd?: string): ToolSummary {
  const i = obj(input);
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'Read':
      return { verb: name, detail: shortPath(str(i.file_path ?? i.notebook_path), cwd), mono: true };
    case 'Bash':
      return { verb: 'Bash', detail: firstLine(str(i.command)), mono: true };
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
      return { verb: name, detail: str(i.bash_id ?? i.shell_id), mono: true };
    case 'Grep': {
      const where = i.path ? ` · ${shortPath(str(i.path), cwd)}` : i.glob ? ` · ${str(i.glob)}` : '';
      return { verb: 'Grep', detail: str(i.pattern) + where, mono: true };
    }
    case 'Glob': {
      const where = i.path ? ` · ${shortPath(str(i.path), cwd)}` : '';
      return { verb: 'Glob', detail: str(i.pattern) + where, mono: true };
    }
    case 'WebFetch':
      return { verb: 'WebFetch', detail: str(i.url), mono: true };
    case 'WebSearch':
      return { verb: 'WebSearch', detail: str(i.query), mono: false };
    case 'Task':
    case 'Agent':
      return {
        verb: name,
        detail: [str(i.subagent_type), str(i.description)].filter(Boolean).join(': '),
        mono: false,
      };
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos.length : 0;
      return { verb: 'TodoWrite', detail: `${todos} задач`, mono: false };
    }
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? i.questions : [];
      return { verb: 'Вопрос', detail: str(obj(qs[0]).question), mono: false };
    }
    case 'ExitPlanMode':
      return { verb: 'План', detail: firstLine(str(i.plan)), mono: false };
    default:
      return { verb: name, detail: compactJson(input), mono: true };
  }
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return s.includes('\n') ? line + ' …' : line;
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
}

export interface FileDiff {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

function diffStrings(oldStr: string, newStr: string): DiffLine[] {
  const patch = structuredPatch('a', 'b', oldStr, newStr, '', '', { context: 3 });
  const out: DiffLine[] = [];
  patch.hunks.forEach((h, idx) => {
    if (idx > 0 || patch.hunks.length > 1) out.push({ kind: 'hunk', text: `@@ −${h.oldStart} +${h.newStart} @@` });
    for (const l of h.lines) {
      if (l.startsWith('\\')) continue;
      const c = l[0];
      out.push({ kind: c === '+' ? 'add' : c === '-' ? 'del' : 'ctx', text: l.slice(1) });
    }
  });
  return out;
}

function count(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

/** Diff для Edit, MultiEdit и Write. null для остальных инструментов. */
export function toolDiff(name: string, input: unknown, cwd?: string): FileDiff | null {
  const i = obj(input);
  const path = shortPath(str(i.file_path), cwd);
  let lines: DiffLine[];
  if (name === 'Edit') {
    lines = diffStrings(str(i.old_string), str(i.new_string));
  } else if (name === 'MultiEdit') {
    const edits = Array.isArray(i.edits) ? i.edits : [];
    lines = [];
    edits.forEach((e, n) => {
      const eo = obj(e);
      if (edits.length > 1) lines.push({ kind: 'hunk', text: `правка ${n + 1} из ${edits.length}` });
      lines.push(...diffStrings(str(eo.old_string), str(eo.new_string)));
    });
  } else if (name === 'Write') {
    const content = str(i.content);
    lines = content.split('\n').map((text) => ({ kind: 'add' as const, text }));
    if (content.endsWith('\n')) lines.pop();
  } else {
    return null;
  }
  return { path, lines, ...count(lines) };
}
