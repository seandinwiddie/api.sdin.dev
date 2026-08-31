/** Owns process-local request histories; callers receive decisions, never maps. */
const createRateLimitStore = (now) => (transition) => (maxClients) => {
  const entries = new Map();

  const evictBeforeInsert = (key) => {
    const existed = entries.delete(key);
    const oldest = entries.keys().next();
    return !existed && entries.size >= maxClients && !oldest.done
      ? entries.delete(oldest.value)
      : false;
  };

  const consume = (key) => {
    const observedAt = now();
    const current = entries.get(key)?.history ?? [];
    const decision = transition(observedAt)(current);
    evictBeforeInsert(key);
    entries.set(key, { history: decision.history });
    return decision;
  };

  return Object.freeze({ consume });
};

module.exports = { createRateLimitStore };
