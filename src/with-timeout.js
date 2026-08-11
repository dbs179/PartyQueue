/**
 * Race a promise against a wall-clock deadline.
 * Does not cancel the underlying work — callers that can abort should pass
 * AbortSignal separately (e.g. fetch). Cleared timer on settle either way.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export async function withTimeout(promise, ms, label = "Operation timed out") {
  const budget = Number(ms);
  if (!Number.isFinite(budget) || budget <= 0) {
    return promise;
  }
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), budget);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function envTimeoutMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
