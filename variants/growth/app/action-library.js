(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ActionLibrary = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function sections(actions) {
    return [
      { id: 'unlocked', label: '已解锁', actions: actions.filter(action => !action.locked) },
      { id: 'locked', label: '未解锁', actions: actions.filter(action => action.locked) }
    ].filter(section => section.actions.length);
  }

  function withGrowthStatus(actions, status) {
    if (!Array.isArray(status?.unlockedActionIds)) return actions;
    const unlocked = new Set(status.unlockedActionIds);
    const fresh = new Set(status.newActionIds || []);
    return actions.map(action => {
      const available = Boolean(action.added || unlocked.has(action.id));
      return { ...action, unlocked: available, locked: !available, isNew: available && fresh.has(action.id) };
    });
  }

  function unlockState(action, status, busy = false) {
    const price = status?.prices?.directAction ?? action?.unlockPrice ?? 200;
    const points = Number.isFinite(status?.points) ? status.points : null;
    return { price, points, missing: points === null ? null : Math.max(0, price - points),
      canUnlock: Boolean(action?.locked && points !== null && points >= price && !busy) };
  }

  return { sections, withGrowthStatus, unlockState };
});
