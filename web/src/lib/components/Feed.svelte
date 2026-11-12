<script lang="ts">
  import type { Message } from '../protocol';
  import { buildFeed } from '../feed';
  import MessageView from './MessageView.svelte';
  import SidechainGroup from './SidechainGroup.svelte';
  import FileViewer from './FileViewer.svelte';

  let { messages, cwd, sessionId }: { messages: Message[]; cwd?: string; sessionId?: string } = $props();
  const model = $derived(buildFeed(messages));
</script>

{#each model.items as item (item.key)}
  {#if item.type === 'msg'}
    <MessageView message={item.message} results={model.results} toolUseIds={model.toolUseIds} {cwd} {sessionId} />
  {:else}
    <SidechainGroup messages={item.messages} results={model.results} toolUseIds={model.toolUseIds} {cwd} {sessionId} />
  {/if}
{/each}

<FileViewer />
