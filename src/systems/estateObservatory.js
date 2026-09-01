'use strict';

const {
  ematch,
  fold,
  left,
  right,
} = require('functional-programming-composition');

const indexById = (entries) =>
  fold(entries ?? [], {}, (index, entry) => ({
    ...index,
    [entry.id]: entry,
  }));

const observedCapability = (instrumented, observation) =>
  instrumented
    ? Object.freeze({
        instrumented: true,
        ...(observation ?? { availability: 'unavailable' }),
      })
    : Object.freeze({
        instrumented: false,
        availability: 'not-instrumented',
      });

const presenceCapability = (instrumented, observation) =>
  instrumented
    ? Object.freeze({
        instrumented: true,
        availability: observation?.state ?? 'unavailable',
        httpStatus: observation?.httpStatus ?? null,
        latencyMs: observation?.latencyMs ?? null,
        checkedAt: observation?.checkedAt ?? null,
      })
    : Object.freeze({
        instrumented: false,
        availability: 'not-instrumented',
        httpStatus: null,
        latencyMs: null,
        checkedAt: null,
      });

const estateFrom = (sources) => (site) => {
  const property = sources.properties[site.id];
  const presence = sources.presence[site.id];
  return Object.freeze({
    id: site.id,
    label: site.label,
    url: site.url,
    capabilities: Object.freeze({
      presence: presenceCapability(site.capabilities.presence, presence),
      analytics: observedCapability(
        site.capabilities.analytics,
        property?.analytics
      ),
      searchConsole: observedCapability(
        site.capabilities.searchConsole,
        property?.searchConsole
      ),
    }),
  });
};

const projectEstateObservatory = (sites) => ({ observatory, presence }) => {
  const sources = {
    properties: indexById(observatory.properties),
    presence: indexById(presence?.channels),
  };
  return Object.freeze({
    ...observatory,
    estates: Object.freeze((sites ?? []).map(estateFrom(sources))),
  });
};

const attemptPresence = (promise) =>
  promise.then(right, () => left('presence-unavailable'));

const createEstateObservatoryService = ({
  sites,
  observatoryService,
  presenceService,
}) => {
  const project = projectEstateObservatory(sites);
  const getSummary = () =>
    Promise.all([
      observatoryService.getSummary(),
      attemptPresence(presenceService.getSummary()),
    ]).then(([observatory, presenceResult]) =>
      project({
        observatory,
        presence: ematch(presenceResult, () => null, (value) => value),
      })
    );

  return Object.freeze({ getSummary });
};

module.exports = {
  createEstateObservatoryService,
  projectEstateObservatory,
};
