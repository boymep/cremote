import { app } from './state.svelte';

export interface Attachment {
  key: number;
  name: string;
  preview: string;
  status: 'uploading' | 'done' | 'error';
  id?: string;
  error?: string;
}

const MAX_BYTES = 10 * 1024 * 1024;
let seq = 0;

/** Картинки для сообщения: превью и загрузка через /api/upload сразу после выбора. */
export class Attachments {
  items = $state<Attachment[]>([]);

  readonly uploading = $derived(this.items.some((a) => a.status === 'uploading'));
  readonly ids = $derived(this.items.filter((a) => a.status === 'done' && a.id).map((a) => a.id as string));
  readonly hasErrors = $derived(this.items.some((a) => a.status === 'error'));

  add(files: FileList | File[] | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
        app.toast(`${file.name}: можно прикреплять только картинки`, 'error');
        continue;
      }
      const key = ++seq;
      const item: Attachment = {
        key,
        name: file.name,
        preview: URL.createObjectURL(file),
        status: file.size > MAX_BYTES ? 'error' : 'uploading',
        error: file.size > MAX_BYTES ? 'Больше 10 МБ' : undefined,
      };
      this.items.push(item);
      if (item.status === 'uploading') void this.upload(key, file);
    }
  }

  private async upload(key: number, file: File) {
    try {
      const res = await app.api.upload(file);
      this.update(key, { status: 'done', id: res.id });
    } catch (e) {
      this.update(key, { status: 'error', error: (e as Error).message });
    }
  }

  private update(key: number, patch: Partial<Attachment>) {
    const i = this.items.findIndex((a) => a.key === key);
    if (i >= 0) this.items[i] = { ...this.items[i], ...patch };
  }

  remove(key: number) {
    const a = this.items.find((x) => x.key === key);
    if (a) URL.revokeObjectURL(a.preview);
    this.items = this.items.filter((x) => x.key !== key);
  }

  clear() {
    for (const a of this.items) URL.revokeObjectURL(a.preview);
    this.items = [];
  }
}
