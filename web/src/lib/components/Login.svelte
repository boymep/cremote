<script lang="ts">
  import { app } from '../state.svelte';

  let password = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!password || busy) return;
    busy = true;
    error = null;
    error = await app.login(password);
    busy = false;
    if (!error) password = '';
  }
</script>

<main class="login">
  <form onsubmit={submit}>
    <img class="appicon" src="/apple-touch-icon.png" alt="" width="76" height="76" />
    <h1>cremote</h1>
    <p class="sub">Claude Code с телефона</p>
    <div class="ios-list fieldbox">
      <label class="ios-cell">
        <span class="sr-only">Пароль</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="pw"
          class="ios-input"
          type="password"
          autocomplete="current-password"
          placeholder="Пароль"
          bind:value={password}
          autofocus
        />
      </label>
    </div>
    <!-- Место под ошибку зарезервировано: форма не прыгает при её появлении. -->
    <p class="error" role="alert">{error ?? ''}</p>
    <button class="ios-btn-filled" type="submit" disabled={!password || busy}>
      {busy ? 'Входим…' : 'Войти'}
    </button>
  </form>
</main>

<style>
  .login {
    /* Страница не прокручивается: если форма не влезает (альбомная ориентация), прокручивается этот экран. */
    position: fixed;
    inset: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    background: var(--bg);
    padding: calc(var(--s-6) + var(--safe-top)) calc(var(--gutter) + var(--safe-right)) calc(var(--s-6) + var(--safe-bottom))
      calc(var(--gutter) + var(--safe-left));
  }
  form {
    /* margin: auto центрирует и не уводит верх формы за край, когда она выше экрана. */
    margin: auto;
    width: 100%;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-2);
  }
  .appicon {
    border-radius: var(--radius-group);
    box-shadow: 0 0 0 0.5px var(--border), var(--shadow);
  }
  h1 {
    margin: var(--s-2) 0 0;
    font: var(--t-large);
  }
  .sub {
    margin: 0 0 var(--s-4);
    color: var(--fg-muted);
    font: var(--t-subhead);
  }
  .fieldbox {
    width: 100%;
  }
  .fieldbox .ios-cell {
    cursor: text;
  }
  /* Две строки: форма не прыгает при появлении ошибки. */
  .error {
    color: var(--danger);
    margin: 0;
    font: var(--t-footnote);
    min-height: 40px;
    text-align: center;
  }
</style>
