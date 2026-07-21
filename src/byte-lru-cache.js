export function createByteLruCache(maxBytes) {
  const limit = Math.max(0, Number(maxBytes) || 0);
  const entries = new Map();
  let bytes = 0;

  return {
    get(key) {
      const value = entries.get(key);
      if (!value) return null;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      const size = Number(value?.body?.length) || 0;
      if (!size || size > limit) return false;
      const old = entries.get(key);
      if (old) bytes -= Number(old.body?.length) || 0;
      entries.delete(key);
      entries.set(key, value);
      bytes += size;
      while (bytes > limit && entries.size > 1) {
        const oldestKey = entries.keys().next().value;
        const oldest = entries.get(oldestKey);
        entries.delete(oldestKey);
        bytes -= Number(oldest?.body?.length) || 0;
      }
      return true;
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}

export function createInFlightCoalescer() {
  const pending = new Map();
  return {
    run(key, load) {
      const active = pending.get(key);
      if (active) return active;
      const request = Promise.resolve().then(load);
      pending.set(key, request);
      return request.finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      });
    },
    get size() {
      return pending.size;
    },
  };
}
