// macOS can adjust native bounds while waking or rebuilding the display layout.
// Keep app-requested bounds separate from those unsolicited native changes.
function createPetGeometryGuard({ window, screen, powerMonitor, platform = process.platform,
  isDragging = () => false, cancelDrag = () => {}, onRestore = () => {}, onError = () => {},
  timers = { setTimeout, clearTimeout } }) {
  if (platform !== 'darwin') return { remember() {}, stop() {} };

  let stopped = false, suspended = false;
  let intended = { ...window.getBounds() };
  const pending = new Set();
  const validRect = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;
  const displays = () => screen.getAllDisplays().filter(d => validRect(d.workArea));
  // Display IDs can be reassigned after reconnecting; compare actual geometry.
  const signature = list => JSON.stringify(list.map(d => JSON.stringify([d.workArea.x, d.workArea.y,
    d.workArea.width, d.workArea.height, d.scaleFactor, d.rotation])).sort());
  let intendedDisplays = signature(displays());

  function remember(bounds) {
    if (stopped || window.isDestroyed()) return;
    const next = { ...intended, ...bounds };
    if (!validRect(next)) return;
    intended = next;
    const list = displays();
    if (list.length) intendedDisplays = signature(list);
  }

  function cancelPending() {
    for (const timer of pending) timers.clearTimeout(timer);
    pending.clear();
  }

  function targetBounds(list) {
    // Preserve deliberate edge placement when the display layout is unchanged.
    // Only fit into a work area after a real display/work-area change.
    if (signature(list) === intendedDisplays) return { ...intended };
    const cx = intended.x + intended.width / 2, cy = intended.y + intended.height / 2;
    const overlap = a => Math.max(0, Math.min(intended.x + intended.width, a.x + a.width) - Math.max(intended.x, a.x)) *
      Math.max(0, Math.min(intended.y + intended.height, a.y + a.height) - Math.max(intended.y, a.y));
    const distance = a => Math.max(a.x - cx, 0, cx - a.x - a.width) ** 2 + Math.max(a.y - cy, 0, cy - a.y - a.height) ** 2;
    const areas = list.map(d => d.workArea).sort((a, b) => overlap(b) - overlap(a) || distance(a) - distance(b));
    const area = areas[0];
    return { ...intended,
      x: Math.round(Math.min(Math.max(intended.x, area.x), area.x + Math.max(0, area.width - intended.width))),
      y: Math.round(Math.min(Math.max(intended.y, area.y), area.y + Math.max(0, area.height - intended.height))) };
  }

  function restore(reason) {
    if (stopped || suspended || window.isDestroyed()) return;
    if (isDragging()) { schedule(reason); return; }
    try {
      const list = displays();
      if (!list.length) return; // Display information may briefly be absent during wake.
      const target = targetBounds(list), before = window.getBounds();
      if (['x', 'y', 'width', 'height'].some(k => before[k] !== target[k])) {
        window.setBounds(target, false);
        onRestore({ reason, before, requested: target, actual: window.getBounds() });
      }
      // Repaint the existing surface without showing, focusing or reloading it.
      window.webContents.invalidate();
    } catch (error) { onError(String(error)); }
  }

  function schedule(reason) {
    cancelPending();
    if (stopped || suspended) return;
    // Coalesce display notifications, then retry after native wake geometry settles.
    for (const delay of [250, 1500]) {
      const timer = timers.setTimeout(() => { pending.delete(timer); restore(reason); }, delay);
      timer.unref?.();
      pending.add(timer);
    }
  }

  const suspend = () => { suspended = true; cancelPending(); cancelDrag(); };
  const resume = () => { suspended = false; cancelDrag(); schedule('resume'); };
  const unlock = () => schedule('unlock-screen');
  const metrics = (_event, _display, changed) => {
    if (!changed || changed.some(k => ['bounds', 'workArea', 'scaleFactor', 'rotation'].includes(k))) schedule('display-metrics-changed');
  };
  const added = () => schedule('display-added');
  const removed = () => schedule('display-removed');
  powerMonitor.on('suspend', suspend);
  powerMonitor.on('resume', resume);
  powerMonitor.on('unlock-screen', unlock);
  screen.on('display-metrics-changed', metrics);
  screen.on('display-added', added);
  screen.on('display-removed', removed);

  function stop() {
    stopped = true;
    cancelPending();
    powerMonitor.removeListener('suspend', suspend);
    powerMonitor.removeListener('resume', resume);
    powerMonitor.removeListener('unlock-screen', unlock);
    screen.removeListener('display-metrics-changed', metrics);
    screen.removeListener('display-added', added);
    screen.removeListener('display-removed', removed);
    window.removeListener('closed', stop);
  }
  window.once('closed', stop);
  return { remember, stop };
}

module.exports = { createPetGeometryGuard };
