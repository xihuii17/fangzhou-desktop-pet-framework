const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const shells = ['app', 'variants/ai/app', 'variants/standard-music/app', 'variants/growth/app'];
const original = { x: 500, y: 200, width: 184, height: 250 };
const display = (id = 1, x = 0, width = 1920, height = 1080, scaleFactor = 2) =>
  ({ id, workArea: { x, y: 0, width, height }, scaleFactor, rotation: 0 });

function harness(create, platform = 'darwin', initial = original, monitors = [display()]) {
  let bounds = { ...initial }, clock = 0, serial = 0;
  const scheduled = new Map(), power = new EventEmitter(), screen = new EventEmitter(), window = new EventEmitter();
  const state = { moving: false, monitors, writes: [], errors: [], reports: [], invalidations: 0, failPaint: false };
  const timers = {
    setTimeout(fn, delay) { const id = ++serial; scheduled.set(id, { fn, due: clock + delay }); return id; },
    clearTimeout(id) { scheduled.delete(id); }
  };
  Object.assign(screen, { getAllDisplays: () => state.monitors });
  Object.assign(window, {
    isDestroyed: () => false,
    getBounds: () => ({ ...bounds }),
    setBounds: next => { bounds = { ...next }; state.writes.push({ ...bounds }); },
    setPosition: (x, y) => { bounds = { ...bounds, x, y }; },
    getPosition: () => [bounds.x, bounds.y],
    show: () => assert.fail('Recovery must not show a hidden pet'),
    showInactive: () => assert.fail('Recovery must not change visibility'),
    focus: () => assert.fail('Recovery must not steal focus'),
    setAlwaysOnTop: () => assert.fail('Recovery must not override topmost preferences'),
    webContents: { invalidate() { state.invalidations++; if (state.failPaint) throw Error('paint failed'); } }
  });
  const guard = create({ window, screen, powerMonitor: power, platform, timers,
    isDragging: () => state.moving, cancelDrag: () => { state.moving = false; },
    onRestore: report => state.reports.push(report), onError: error => state.errors.push(error) });
  function advance(ms) {
    const end = clock + ms;
    for (;;) {
      const next = [...scheduled].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > end) break;
      clock = next[1].due; scheduled.delete(next[0]); next[1].fn();
    }
    clock = end;
  }
  return { guard, window, screen, power, state, scheduled, advance,
    nativeChange: partial => { bounds = { ...bounds, ...partial }; window.emit('move'); window.emit('resize'); } };
}

for (const shell of shells) {
  const helper = path.join(root, shell, 'pet-window-geometry.js');
  assert.equal(fs.readFileSync(helper, 'utf8'), fs.readFileSync(path.join(root, 'app/pet-window-geometry.js'), 'utf8'));
  const { createPetGeometryGuard } = require(helper);
  const h = harness(createPetGeometryGuard);
  // Native moves/resizes are deliberately NOT remembered as user intent.
  for (let cycle = 0; cycle < 30; cycle++) {
    h.state.moving = true; h.power.emit('suspend');
    assert.equal(h.state.moving, false, 'suspend cancels stale drag state');
    h.nativeChange({ y: 264, height: 400 });
    h.screen.emit('display-metrics-changed', {}, display(), ['bounds']);
    h.advance(2000); assert.equal(h.window.getBounds().y, 264, 'do not resize while suspended');
    h.power.emit('resume'); h.advance(250);
    assert.deepEqual(h.window.getBounds(), original, 'recover last requested origin AND dimensions');
    h.nativeChange({ y: 264, height: 400 }); // delayed native adjustment during wake
    h.advance(1250);
    assert.deepEqual(h.window.getBounds(), original, 'settled pass must not accumulate drift');
  }
  assert.equal(h.state.reports[0].before.height, 400);
  assert.equal(h.state.reports[0].requested.height, 250);

  // A new drag wins over a pending resume. Exercise the actual main.js drag path.
  const main = fs.readFileSync(path.join(root, shell, 'main.js'), 'utf8');
  let cursor = { x: 520, y: 220 };
  const c = { petWindow: h.window, petGeometryGuard: h.guard, appliedPetScale: .55,
    screen: { getCursorScreenPoint: () => cursor },
    dragState: { moving: true, cursorX: 520, cursorY: 220, windowX: 500, windowY: 200, lastCursorX: 520, lastCursorY: 220 },
    WINDOW_BASE: { width: 300, height: 360 }, WINDOW_MIN_WIDTH: 184, TOOLBAR_AREA_HEIGHT: 52,
    safeScale: n => n, visiblePosition: p => p, setPetAlwaysOnTop() {} };
  vm.runInNewContext(main.slice(main.indexOf('function updateDragPosition()'), main.indexOf('function stopDragTracking(')), c);
  vm.runInNewContext(main.slice(main.indexOf('function safeLyricsScale('), main.indexOf('function defaultPosition(')) +
    main.slice(main.indexOf('function applyWindowConfig('), main.indexOf('function setPetAlwaysOnTop(')), c);
  h.power.emit('resume'); h.state.moving = true;
  cursor = { x: 720, y: 320 }; c.updateDragPosition();
  h.advance(250);
  assert.equal(h.window.getBounds().x, 700, 'recovery must not interrupt active drag');
  h.state.moving = false;
  h.nativeChange({ x: 710, y: 364, height: 400 }); h.advance(250);
  assert.deepEqual(h.window.getBounds(), { ...original, x: 700, y: 300 }, 'restore the NEW drag position');

  // A settings resize during pending recovery must not resurrect the old size.
  c.applyWindowConfig({ scale: .55, lyricsEnabled: true, qqLyricsEnabled: true, lyricsScale: 1.6 });
  const resized = h.window.getBounds();
  h.nativeChange({ height: 600 }); h.advance(1500);
  assert.deepEqual(h.window.getBounds(), resized);
  assert.equal(resized.height, 382);
  assert.equal(resized.y, 300);
  assert.match(main, /petWindow\.setPosition\(position\.x, position\.y\);\s*petGeometryGuard\?\.remember\(position\);\s*savePosition\(\)/, 'reset position must also become the new anchor');
  assert.match(main, /petGeometryGuard = createPetGeometryGuard\(/, 'wire the guard into window creation');
  h.state.failPaint = true; h.power.emit('unlock-screen'); h.advance(250);
  assert.ok(h.state.errors.some(e => e.includes('paint failed')), 'report repaint failures without crashing');
  h.window.emit('closed');
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.power.listenerCount('resume'), 0);
  assert.equal(h.power.listenerCount('suspend'), 0);
  assert.equal(h.power.listenerCount('unlock-screen'), 0);
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) assert.equal(h.screen.listenerCount(event), 0);
  const writes = h.state.writes.length; h.power.emit('resume'); h.advance(2000);
  assert.equal(h.state.writes.length, writes);

  // Keep deliberate bottom-edge placement when the same monitor wakes.
  const edge = harness(createPetGeometryGuard, 'darwin', { ...original, y: 1000 });
  edge.power.emit('resume'); edge.advance(1500);
  assert.equal(edge.window.getBounds().y, 1000);
  edge.state.monitors = [display(99)]; edge.screen.emit('display-added'); edge.advance(1500);
  assert.equal(edge.window.getBounds().y, 1000, 'a reassigned display ID alone must not snap deliberate edge placement');
  edge.guard.stop();

  // A removed negative-coordinate screen fits to the nearest surviving screen;
  // reconnecting it restores the user's coordinates, not the temporary clamp.
  const multi = harness(createPetGeometryGuard, 'darwin', { ...original, x: -1800, y: 750 }, [display(), display(2, -1920, 1920, 1080, 1)]);
  multi.state.monitors = [display(1, 0, 1280, 800, 1)];
  multi.screen.emit('display-removed'); multi.advance(1500);
  assert.deepEqual(multi.window.getBounds(), { ...original, x: 0, y: 550 });
  multi.state.monitors = [display(), display(2, -1920, 1920, 1080, 1)];
  multi.screen.emit('display-added'); multi.advance(1500);
  assert.deepEqual(multi.window.getBounds(), { ...original, x: -1800, y: 750 });
  multi.screen.emit('display-metrics-changed', {}, display(), ['colorSpace']);
  assert.equal(multi.scheduled.size, 0, 'unrelated display properties do not trigger recovery');
  multi.state.monitors = []; multi.nativeChange({ y: 820 }); multi.power.emit('resume'); multi.advance(250);
  assert.equal(multi.window.getBounds().y, 820, 'wait for valid display information');
  multi.state.monitors = [display(), display(2, -1920, 1920, 1080, 1)]; multi.advance(1250);
  assert.equal(multi.window.getBounds().y, 750);
  multi.guard.stop();

  const small = harness(createPetGeometryGuard, 'darwin', original);
  small.state.monitors = [display(1, 0, 160, 200)]; small.screen.emit('display-metrics-changed', {}, null, ['workArea']); small.advance(1500);
  assert.deepEqual(small.window.getBounds(), { ...original, x: 0, y: 0 }, 'oversized windows anchor at the work-area origin, not negative clamp limits');
  small.guard.stop();
  for (const platform of ['win32', 'linux']) {
    const other = harness(createPetGeometryGuard, platform);
    other.power.emit('resume'); other.screen.emit('display-removed'); other.advance(2000);
    assert.equal(other.scheduled.size, 0); assert.equal(other.state.writes.length, 0);
    assert.equal(other.power.listenerCount('resume'), 0);
    other.guard.remember({ x: 0, y: 0 }); other.guard.stop();
  }
  console.log(`PASS ${shell}: simulated native wake drift/resize, 30 cycles, latest drag/config, display changes, hidden-state safety, cleanup and Windows no-op`);
}
assert.ok(fs.existsSync(path.join(root, 'scripts/prepare-example.cjs')));
console.log('PASS preparation gate; these deterministic event tests are not overnight-sleep or physical-monitor acceptance.');
