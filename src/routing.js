'use strict';

const TIERS = ['fable', 'opus', 'sonnet', 'haiku', 'default'];

function classifyModel(model) {
  const name = typeof model === 'string' ? model.toLowerCase() : '';
  for (const tier of TIERS.slice(0, -1)) {
    if (name.includes(tier)) return tier;
  }
  return 'default';
}

function resolveRoute(mode, model) {
  const tier = classifyModel(model);
  return { tier, upstream: mode.routes[tier] };
}

module.exports = { TIERS, classifyModel, resolveRoute };
