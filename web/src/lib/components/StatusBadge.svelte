<script lang="ts">
  import type { SessionStatus } from '../protocol';
  import { STATUS_LABEL } from '../format';

  let { status }: { status: SessionStatus } = $props();
</script>

<span class="badge {status}">{STATUS_LABEL[status] ?? status}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 8px;
    border-radius: 999px;
    font: var(--t-footnote);
        font-weight: var(--w-semibold);
    white-space: nowrap;
    background: var(--bg-sunken);
    color: var(--fg-muted);
  }
  .live,
  .idle {
    background: var(--info-soft);
    color: var(--info);
  }
  .working {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .working::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: blink 1.2s ease-in-out infinite;
  }
  .awaiting_input {
    background: var(--ok-soft);
    color: var(--ok);
  }
  @keyframes blink {
    50% {
      opacity: 0.25;
    }
  }
</style>
