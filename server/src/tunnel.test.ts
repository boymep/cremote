import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FAILURES_BEFORE_RESTART,
  MAX_RESTART_GAP_MS,
  MIN_RESTART_GAP_MS,
  WAKE_GAP_MS,
  WATCHDOG_INTERVAL_MS,
  initialWatchdogState,
  watchdogStep,
  type WatchdogState,
} from './tunnel.js';

/** Feeds probe results one interval apart and returns the actions. */
function run(results: boolean[], start: WatchdogState = initialWatchdogState(), t0 = 1_000_000) {
  let state = start;
  const actions: string[] = [];
  results.forEach((ok, i) => {
    const r = watchdogStep(state, { now: t0 + i * WATCHDOG_INTERVAL_MS, ok });
    state = r.state;
    actions.push(r.action);
  });
  return { state, actions };
}

test('restarts only after N consecutive failures', () => {
  const { actions } = run([false, false, false]);
  assert.deepEqual(actions, ['none', 'none', 'restart']);
  assert.equal(FAILURES_BEFORE_RESTART, 3);
});

test('a success resets the failure counter', () => {
  const { actions, state } = run([false, false, true, false, false]);
  assert.deepEqual(actions, ['none', 'none', 'none', 'none', 'none']);
  assert.equal(state.failures, 2);
});

test('wake gap lowers the threshold to one failure', () => {
  let s = run([true]).state;
  const r = watchdogStep(s, { now: s.lastTickAt! + WAKE_GAP_MS + 1, ok: false });
  assert.equal(r.wake, true);
  assert.equal(r.action, 'restart');
});

test('normal tick gap is not a wake', () => {
  const s = run([true]).state;
  const r = watchdogStep(s, { now: s.lastTickAt! + WATCHDOG_INTERVAL_MS, ok: false });
  assert.equal(r.wake, false);
  assert.equal(r.action, 'none');
});

test('backoff blocks a second restart and grows up to the maximum', () => {
  let state = initialWatchdogState();
  let now = 0;
  const restarts: number[] = [];
  for (let i = 0; i < 200; i++) {
    now += WATCHDOG_INTERVAL_MS;
    const r = watchdogStep(state, { now, ok: false });
    state = r.state;
    if (r.action === 'restart') restarts.push(now);
  }
  assert.ok(restarts.length >= 4);
  const gaps = restarts.slice(1).map((t, i) => t - restarts[i]);
  assert.ok(gaps.every((g) => g >= MIN_RESTART_GAP_MS));
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]));
  assert.ok(gaps.every((g) => g <= MAX_RESTART_GAP_MS + WATCHDOG_INTERVAL_MS * FAILURES_BEFORE_RESTART));
  assert.equal(state.backoffMs, MAX_RESTART_GAP_MS);
});

test('wake right after a restart waits for backoff instead of looping', () => {
  const first = watchdogStep({ ...initialWatchdogState(), lastTickAt: 0 }, { now: WAKE_GAP_MS + 1, ok: false });
  assert.equal(first.action, 'restart');
  const second = watchdogStep(first.state, { now: WAKE_GAP_MS + 1 + 5_000, ok: false });
  assert.equal(second.action, 'none');
  const third = watchdogStep({ ...second.state, failures: 5 }, { now: WAKE_GAP_MS + 1 + 10_000, ok: false });
  assert.equal(third.action, 'wait');
});

test('success resets the backoff', () => {
  const restarted = run([false, false, false]).state;
  assert.ok(restarted.backoffMs > MIN_RESTART_GAP_MS);
  const ok = watchdogStep(restarted, { now: restarted.lastTickAt! + WATCHDOG_INTERVAL_MS, ok: true });
  assert.equal(ok.state.backoffMs, MIN_RESTART_GAP_MS);
});
