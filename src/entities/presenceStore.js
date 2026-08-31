/** Owns one process-local presence snapshot and one in-flight refresh. */
const createPresenceStore = ({ now, ttlMs }) => {
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
    snapshot = {
      value,
      expiresAt: now() + ttlMs,
      stale: false,
    };
    return decorate(snapshot, { cached: false, stale: false });
  };

  const read = async (produce) => {
    if (isFresh(snapshot)) {
      return decorate(snapshot, { cached: true, stale: snapshot.stale });
    }

    if (pending) {
      return pending;
    }

    pending = refresh(produce).catch((error) => {
      if (!snapshot) throw error;
      return deferStaleSnapshot();
    });
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };

  return Object.freeze({ read });
};

module.exports = { createPresenceStore };
