/**
 * Leading-edge off, trailing-edge debounce. `fn` runs once after `waitMs`
 * of quiet. Used so live queue SSE does not hammer GET /api/fairness.
 *
 * @param {(...args: any[]) => void} fn
 * @param {number} waitMs
 */
export function createDebounced(fn, waitMs) {
  let timer = 0;
  const wait = Math.max(0, Number(waitMs) || 0);
  function run(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      fn(...args);
    }, wait);
  }
  run.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = 0;
  };
  return run;
}
