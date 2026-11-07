(function (root) {
  const preferences = { quiet: ['idle', 'sleep'], daily: ['idle', 'sleep'], office: ['work', 'typing', 'idle'] };
  function defaults(actions) {
    return Object.fromEntries(Object.entries(preferences).map(([mode, ids]) => [mode,
      ids.map(id => actions.find(action => (action.behaviorId || action.id) === id)).find(Boolean)?.id || actions[0]?.id || null
    ]));
  }
  function resolve(config, actions) {
    const mode = config.activityMode || 'daily';
    const stored = config.modeIdleActions?.[config.appearanceId || 'default'];
    const selected = mode === 'office' ? stored?.office : (stored?.daily || stored?.quiet);
    if (actions.some(action => action.id === selected)) return selected;
    // Quiet and daily share the existing base action; office stays independent.
    if (mode !== 'office' && config.baseAction && actions.some(action => action.id === config.baseAction)) return config.baseAction;
    return defaults(actions)[mode] || defaults(actions).daily;
  }
  const api = { defaults, resolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ModeIdle = api;
})(globalThis);
