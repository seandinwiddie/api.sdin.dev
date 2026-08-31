/** Owns one short-lived public observatory snapshot and one in-flight refresh. */
const createObservatoryStore = ({ now, ttlMs, preferCandidate = () => true }) => {
  let snapshot = null;
  let pending = null;

  const isFresh = (entry) => Boolean(entry) && entry.expiresAt > now();

  const decorate = (entry, provenance) => ({
    ...entry.value,
    ...provenance,
  });

  const deferStaleSnapshot = () => {
    snapshot = {
      ...snapshot,
      expiresAt: now() + ttlMs,
      stale: true,
    };
    return decorate(snapshot, { cached: true, stale: true });
  };

  const refresh = async (produce) => {
    const value = await produce();
    if (snapshot && !preferCandidate(snapshot.value, value)) {
      return deferStaleSnapshot();
    }
    snapshot = {
      value,
      expiresAt: now() + ttlMs,
      stale: false,
    };
    return decorate(snapshot, { cached: false, stale: false });
  };

  const start = (produce) => {
    pending = refresh(produce)
      .catch((error) => {
        if (!snapshot) throw error;
        return deferStaleSnapshot();
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  const read = (produce) =>
    isFresh(snapshot)
      ? Promise.resolve(
          decorate(snapshot, { cached: true, stale: snapshot.stale })
        )
      : (pending ?? start(produce));

  return Object.freeze({ read });
};

module.exports = { createObservatoryStore };
