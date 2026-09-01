'use strict';

const {
  configureStore,
  createEntityAdapter,
  createSlice,
} = require('@reduxjs/toolkit');

const siteAdapter = createEntityAdapter({
  selectId: (site) => site.id,
});

const initialState = siteAdapter.getInitialState({
  schemaVersion: null,
  kind: null,
  description: null,
  checkedAt: null,
  scope: null,
  posture: null,
  assessments: [],
  links: [],
  provenance: null,
  expiresAt: 0,
  stale: false,
});

const securityPostureSlice = createSlice({
  name: 'securityPosture',
  initialState,
  reducers: {
    snapshotRecorded(state, action) {
      const { value, expiresAt } = action.payload;
      siteAdapter.setAll(state, value.sites);
      state.schemaVersion = value.schemaVersion;
      state.kind = value.kind;
      state.description = value.description;
      state.checkedAt = value.checkedAt;
      state.scope = value.scope;
      state.posture = value.posture;
      state.assessments = value.assessments;
      state.links = value.links;
      state.provenance = value.provenance;
      state.expiresAt = expiresAt;
      state.stale = false;
    },
    snapshotDeferred(state, action) {
      state.expiresAt = action.payload.expiresAt;
      state.stale = true;
    },
  },
});

const siteSelectors = siteAdapter.getSelectors((state) => state);
const { snapshotDeferred, snapshotRecorded } = securityPostureSlice.actions;

const snapshotFrom = (state) =>
  state.checkedAt === null
    ? null
    : {
        schemaVersion: state.schemaVersion,
        kind: state.kind,
        description: state.description,
        checkedAt: state.checkedAt,
        scope: state.scope,
        posture: state.posture,
        sites: siteSelectors.selectAll(state),
        assessments: state.assessments,
        links: state.links,
        provenance: state.provenance,
      };

const withCacheProvenance = (value, cached, stale) => ({
  ...value,
  cached,
  stale,
  provenance: {
    ...value.provenance,
    cached,
    stale,
  },
});

/**
 * RTK owns the serializable snapshot. The in-flight Promise remains outside
 * Redux because it is an effect capability rather than application state.
 */
const createSecurityPostureStore = ({ now, ttlMs }) => {
  const store = configureStore({
    reducer: securityPostureSlice.reducer,
  });
  let pending = null;

  const current = () => {
    const state = store.getState();
    const value = snapshotFrom(state);
    return value === null
      ? null
      : { state, value };
  };

  const isFresh = (entry) => Boolean(entry) && entry.state.expiresAt > now();

  const deferStale = (entry) => {
    store.dispatch(snapshotDeferred({ expiresAt: now() + ttlMs }));
    return withCacheProvenance(entry.value, true, true);
  };

  const refresh = (produce) =>
    Promise.resolve()
      .then(produce)
      .then((value) => {
        store.dispatch(snapshotRecorded({ value, expiresAt: now() + ttlMs }));
        return withCacheProvenance(value, false, false);
      });

  const start = (produce) => {
    pending = refresh(produce)
      .catch((error) => {
        const retained = current();
        if (retained === null) throw error;
        return deferStale(retained);
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  const read = (produce) => {
    const retained = current();
    return isFresh(retained)
      ? Promise.resolve(
          withCacheProvenance(
            retained.value,
            true,
            retained.state.stale
          )
        )
      : (pending ?? start(produce));
  };

  return Object.freeze({
    read,
    getState: store.getState,
  });
};

module.exports = {
  createSecurityPostureStore,
  securityPostureReducer: securityPostureSlice.reducer,
  snapshotFrom,
};
