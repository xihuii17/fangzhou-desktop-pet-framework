const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
for (const edition of ['base', 'ai', 'standard-music', 'growth']) {
  const shell = edition === 'base' ? path.join(root, 'app') : path.join(root, 'variants', edition, 'app');
  const source = fs.readFileSync(path.join(shell, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(shell, 'pet.html'), 'utf8');
  assert.match(renderer, /Math\.hypot\(event\.screenX - pointerState\.screenX, event\.screenY - pointerState\.screenY\)/);
  assert.match(source, /topmostGuardTimer = setInterval\(\(\) => \{\s*if \(dragState\?\.moving\) return;/);
  const functions = source.slice(source.indexOf('function updateDragPosition()'), source.indexOf('function createPetWindow()'));
  const start = source.indexOf("ipcMain.on('drag:start'");
  const end = source.indexOf("ipcMain.on('drag:end'", start);
  const handlers = source.slice(start, source.indexOf('\n});', end) + 4);
  for (const scale of [1, 1.25, 1.5, 2]) {
    let bounds = { x: 300, y: 700, width: Math.round(300 / scale), height: Math.round(540 / scale) };
    let cursor = { x: 420, y: 840 };
    let saved = 0, writes = 0;
    const events = new Map(), timers = new Set();
    const c = {
      petGeometryGuard: null, dragState: null, dragTimer: null, process: { platform: 'win32' },
      screen: { getCursorScreenPoint: () => ({ ...cursor }) },
      petWindow: {
        isDestroyed: () => false, getBounds: () => ({ ...bounds }),
        getPosition: () => [bounds.x, bounds.y], getContentBounds: () => ({ ...bounds }),
        setPosition: (x, y) => { writes++; bounds = { ...bounds, x, y }; }
      },
      // The old full-window constraint pushes a horizontal drag upward here.
      visiblePosition: (p, s) => ({ x: Math.max(0, Math.min(p.x, 1920 - s.width)), y: Math.max(0, Math.min(p.y, 1040 - s.height)) }),
      savePosition: () => { saved++; },
      ipcMain: { on: (name, callback) => events.set(name, callback) },
      setInterval: callback => { timers.add(callback); return callback; },
      clearInterval: callback => timers.delete(callback)
    };
    vm.runInNewContext(functions + handlers, c);
    // Repeated drags with lyrics hanging below the screen must not accumulate Y offset.
    for (let drag = 0; drag < 100; drag++) {
      events.get('drag:start')(); cursor.x += 10; events.get('drag:move')();
      assert.equal(bounds.y, 700, `${edition}: horizontal drag drift at scale ${scale}`);
      for (let tick = 0; tick < 30; tick++) { cursor.x += 1; c.updateDragPosition(); }
      cursor.x -= 40; events.get('drag:end')();
      assert.equal(bounds.x, 300); assert.equal(bounds.y, 700);
      assert.equal(timers.size, 0);
    }
    // Cross to a display with negative coordinates, then return; no screen snapping.
    // Vertical drags must preserve the grab anchor, including the last release movement.
    for (let drag = 0; drag < 100; drag++) {
      events.get('drag:start')();
      cursor.y -= 120; events.get('drag:move')();
      assert.equal(bounds.y, 580);
      cursor.y += 250; c.updateDragPosition();
      assert.equal(bounds.y, 830);
      cursor.y -= 130; events.get('drag:end')();
      assert.equal(bounds.y, 700);
      assert.equal(bounds.x, 300);
    }
    assert.equal(saved, 200);
    events.get('drag:start')(); cursor = { x: -400, y: 200 }; events.get('drag:move')();
    assert.equal(bounds.x, -520); assert.equal(bounds.y, 60);
    const previousWrites = writes; for (let i = 0; i < 100; i++) c.updateDragPosition();
    assert.equal(writes, previousWrites, 'Stationary mouse must not move the window');
    cursor = { x: 420, y: 840 }; events.get('drag:end')();
    assert.equal(bounds.x, 300); assert.equal(bounds.y, 700); assert.equal(saved, 201);
    events.get('drag:start')(); events.get('drag:end')(); assert.equal(saved, 201, 'Click is not a drag');
  }
  console.log(`${edition}: repeated drags, bottom edge, lyrics, DIP scales, negative display coordinates, stationary cursor and release passed`);
}
