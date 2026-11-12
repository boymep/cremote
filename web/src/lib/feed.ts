import type { Message, ToolResultBlock } from './protocol';

export type FeedItem =
  | { type: 'msg'; key: string; message: Message }
  | { type: 'sidechain'; key: string; messages: Message[] };

export interface FeedModel {
  items: FeedItem[];
  /** tool_result по id вызова: показывается под своим tool_use. */
  results: Map<string, ToolResultBlock>;
  toolUseIds: Set<string>;
}

/** Сообщение пустое после того, как tool_result ушли под свои tool_use. */
function isEmptyAfterAttach(m: Message, toolUseIds: Set<string>): boolean {
  return m.blocks.every((b) => b.kind === 'tool_result' && toolUseIds.has(b.toolUseId));
}

export function buildFeed(messages: Message[]): FeedModel {
  const results = new Map<string, ToolResultBlock>();
  const toolUseIds = new Set<string>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === 'tool_use') toolUseIds.add(b.id);
      else if (b.kind === 'tool_result') results.set(b.toolUseId, b);
    }
  }

  const items: FeedItem[] = [];
  let group: Message[] | null = null;
  for (const m of messages) {
    if (m.blocks.length === 0 || isEmptyAfterAttach(m, toolUseIds)) {
      // Пустые сообщения не рвут группу сабагента.
      continue;
    }
    if (m.isSidechain) {
      if (!group) {
        group = [];
        items.push({ type: 'sidechain', key: `sc-${m.uuid}`, messages: group });
      }
      group.push(m);
    } else {
      group = null;
      items.push({ type: 'msg', key: m.uuid, message: m });
    }
  }
  return { items, results, toolUseIds };
}
