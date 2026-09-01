const {
  configureStore,
  createEntityAdapter,
  createSlice,
} = require('@reduxjs/toolkit');
const {
  curry,
  fromNullable,
  match,
  requireJust,
} = require('functional-programming-composition');

const { DEFAULT_SECURITY_POLICY } = require('../components/securityPolicy');

const clientHistoryAdapter = createEntityAdapter({
  selectId: (client) => client.clientKey,
});

const rateLimitStateFrom = (policy) =>
  clientHistoryAdapter.getInitialState({
    policy: {
      limit: policy.limit,
      windowMs: policy.windowMs,
      maxClients: policy.maxClients,
    },
  });

const rateLimitTransition = (policy) => (observedAt) => (history) => {
  const activeHistory = history.filter(
    (timestamp) => observedAt - timestamp < policy.windowMs
  );
  const allowed = activeHistory.length < policy.limit;

  return {
    allowed,
    history: allowed ? [...activeHistory, observedAt] : activeHistory,
  };
};

const decisionFrom = curry((policy, client) => {
  const resetAt = (client.history[0] ?? client.observedAt) + policy.windowMs;

  return Object.freeze({
    allowed: client.allowed,
    history: client.history,
    observedAt: client.observedAt,
    remaining: Math.max(0, policy.limit - client.history.length),
    resetAt,
  });
});

const clientFrom = (state, clientKey) =>
  fromNullable(state.entities[clientKey]);

const decisionFromState = (state, clientKey) =>
  match(
    clientFrom(state, clientKey),
    decisionFrom(state.policy),
    () => null
  );

const rateLimitSlice = createSlice({
  name: 'rateLimit',
  initialState: rateLimitStateFrom(DEFAULT_SECURITY_POLICY.rateLimit),
  reducers: {
    clientRequestObserved(state, action) {
      const { clientKey, observedAt } = action.payload;
      const previousClient = state.entities[clientKey];
      const previousHistory = previousClient?.history ?? [];
      const transition = rateLimitTransition(state.policy)(observedAt)(previousHistory);
      const clientWasKnown = previousClient !== undefined;

      clientHistoryAdapter.removeOne(state, clientKey);

      const clientToEvict = !clientWasKnown && state.ids.length >= state.policy.maxClients
        ? state.ids[0]
        : null;
      match(
        fromNullable(clientToEvict),
        (evictedClientKey) => clientHistoryAdapter.removeOne(state, evictedClientKey),
        () => undefined
      );

      clientHistoryAdapter.addOne(state, {
        clientKey,
        history: transition.history,
        observedAt,
        allowed: transition.allowed,
      });
    },
  },
  selectors: {
    selectAdmission: (state, clientKey) =>
      match(
        clientFrom(state, clientKey),
        (client) => client.allowed,
        () => false
      ),
    selectClientHistory: (state, clientKey) =>
      match(
        clientFrom(state, clientKey),
        (client) => client.history,
        () => []
      ),
    selectDecision: decisionFromState,
    selectRemaining: (state, clientKey) =>
      match(
        clientFrom(state, clientKey),
        (client) => Math.max(0, state.policy.limit - client.history.length),
        () => state.policy.limit
      ),
    selectResetAt: (state, clientKey) =>
      match(
        clientFrom(state, clientKey),
        (client) => (client.history[0] ?? client.observedAt) + state.policy.windowMs,
        () => null
      ),
  },
});

const { clientRequestObserved } = rateLimitSlice.actions;
const rateLimitSelectors = Object.freeze(rateLimitSlice.selectors);

/** Creates one serializable, process-local history authority for a warm instance. */
const createRateLimitHistoryStore = (policy) =>
  configureStore({
    reducer: {
      [rateLimitSlice.reducerPath]: rateLimitSlice.reducer,
    },
    preloadedState: {
      [rateLimitSlice.reducerPath]: rateLimitStateFrom(policy),
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ thunk: false }),
  });

/** Keeps the clock effect outside Redux and exposes decisions rather than state. */
const createRateLimitStore = (now) => (policy) => {
  const historyStore = createRateLimitHistoryStore(policy);

  const consume = (clientKey) => {
    const observedAt = now();
    historyStore.dispatch(clientRequestObserved({ clientKey, observedAt }));

    return requireJust(
      fromNullable(
        rateLimitSelectors.selectDecision(historyStore.getState(), clientKey)
      ),
      'Rate-limit decision missing after request observation'
    );
  };

  return Object.freeze({ consume });
};

module.exports = {
  clientRequestObserved,
  createRateLimitHistoryStore,
  createRateLimitStore,
  rateLimitSelectors,
  rateLimitTransition,
};
