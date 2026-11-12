import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Pending, PermissionAnswer, QuestionAnswer } from './types.js';

type Resolver =
  | { kind: 'permission'; resolve: (a: PermissionAnswer | null) => void }
  | { kind: 'question'; resolve: (a: QuestionAnswer | null) => void };

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/**
 * Open permission/question requests waiting for an answer from the phone.
 * Resolving with null means "cancelled" (hook process gone, tool already ran, etc.).
 * Emits 'changed' whenever the list changes.
 */
export class PendingRegistry extends EventEmitter {
  private items = new Map<string, { pending: Pending; resolver: Resolver }>();

  list(): Pending[] {
    return [...this.items.values()].map((x) => x.pending);
  }

  get(id: string): Pending | undefined {
    return this.items.get(id)?.pending;
  }

  addPermission(
    data: DistributiveOmit<Extract<Pending, { kind: 'permission' }>, 'id' | 'createdAt' | 'kind'>,
  ): { id: string; promise: Promise<PermissionAnswer | null> } {
    const id = crypto.randomUUID();
    const promise = new Promise<PermissionAnswer | null>((resolve) => {
      this.items.set(id, {
        pending: { id, kind: 'permission', createdAt: Date.now(), ...data },
        resolver: { kind: 'permission', resolve },
      });
    });
    this.emit('changed');
    return { id, promise };
  }

  addQuestion(sessionId: string, questions: unknown[]): { id: string; promise: Promise<QuestionAnswer | null> } {
    const id = crypto.randomUUID();
    const promise = new Promise<QuestionAnswer | null>((resolve) => {
      this.items.set(id, {
        pending: { id, kind: 'question', sessionId, questions, createdAt: Date.now() },
        resolver: { kind: 'question', resolve },
      });
    });
    this.emit('changed');
    return { id, promise };
  }

  answerPermission(id: string, answer: PermissionAnswer): boolean {
    const item = this.items.get(id);
    if (!item || item.resolver.kind !== 'permission') return false;
    this.items.delete(id);
    item.resolver.resolve(answer);
    this.emit('changed');
    return true;
  }

  answerQuestion(id: string, answer: QuestionAnswer): boolean {
    const item = this.items.get(id);
    if (!item || item.resolver.kind !== 'question') return false;
    this.items.delete(id);
    item.resolver.resolve(answer);
    this.emit('changed');
    return true;
  }

  cancel(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    item.resolver.resolve(null);
    this.emit('changed');
  }

  /** Cancels every pending item matching the predicate. */
  cancelWhere(pred: (p: Pending) => boolean): number {
    let n = 0;
    for (const [id, item] of [...this.items]) {
      if (!pred(item.pending)) continue;
      this.items.delete(id);
      item.resolver.resolve(null);
      n++;
    }
    if (n) this.emit('changed');
    return n;
  }
}
