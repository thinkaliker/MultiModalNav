<script lang="ts">
  import { api, AuthError } from '../lib/api';

  let { onsuccess }: { onsuccess: () => void } = $props();

  let password = $state('');
  let busy = $state(false);
  let error = $state('');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await api.login(password);
      password = '';
      onsuccess();
    } catch (err) {
      error = err instanceof AuthError ? 'Wrong password' : (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="backdrop">
  <form class="card" onsubmit={submit}>
    <h1>MultiModalNav</h1>
    <label for="password">Password</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input id="password" type="password" autocomplete="current-password" bind:value={password} autofocus required />
    {#if error}<p class="error">{error}</p>{/if}
    <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
  </form>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgb(15 23 42 / 0.45);
  }
  .card {
    width: min(22rem, 100%);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1.4rem;
    border-radius: 14px;
    background: #fff;
    box-shadow: 0 20px 50px rgb(0 0 0 / 0.25);
  }
  h1 {
    margin: 0 0 0.5rem;
    font-size: 1.25rem;
  }
  label {
    font-size: 0.85rem;
    color: var(--muted);
  }
  input {
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  button {
    margin-top: 0.4rem;
    padding: 0.65rem;
    border: 0;
    border-radius: var(--radius);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 0.875rem;
  }
</style>
