const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directories = ['app', 'variants/ai/app', 'variants/standard-music/app', 'variants/growth/app'];
const fullscreen = { state: 'fullscreen', bounds: { x: 0, y: 0, width: 1920, height: 1080 } };

function harness(directory, options = {}) {
  const { preparePetWindow, showPreparedPet, hidePreparedPet } = require(path.join(root, directory, 'pet-window-ready'));
  const { createFullscreenGuard } = require(path.join(root, directory, 'fullscreen-guard'));
  const window = new EventEmitter(), ipc = new EventEmitter(), calls = [], children = [], errors = [];
  let visible = false, clock = 0, suspendedDrags = 0;
  let physicalBounds = { x: 300, y: 300, width: 200, height: 300 };
  const pending = new Set();
  const timer = (fn, ms, interval) => {
    const handle = { fn, at: clock + ms, ms, interval, unref() {} }; pending.add(handle); return handle;
  };
  const timers = {
    setTimeout: (fn, ms) => timer(fn, ms, false), clearTimeout: handle => pending.delete(handle),
    setInterval: (fn, ms) => timer(fn, ms, true), clearInterval: handle => pending.delete(handle)
  };
  const advance = ms => {
    const end = clock + ms;
    while (true) {
      const next = [...pending].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      clock = next.at;
      if (next.interval) next.at += next.ms; else pending.delete(next);
      next.fn();
    }
    clock = end;
  };
  window.webContents = new EventEmitter();
  window.webContents.invalidate = () => {};
  Object.assign(window, {
    isDestroyed: () => false, isVisible: () => visible,
    getBounds: () => ({ x: 200, y: 200, width: 140, height: 200 }),
    setBackgroundColor: () => {},
    showInactive: () => { visible = true; calls.push(['showInactive']); window.emit('show'); },
    hide: () => { visible = false; calls.push(['hide']); },
    setIgnoreMouseEvents: value => calls.push(['ignoreMouse', value]),
    setFocusable: value => calls.push(['focusable', value]),
    setAlwaysOnTop: value => calls.push(['topmost', value]),
    moveTop: () => calls.push(['moveTop'])
  });
  preparePetWindow(window, { ipcMain: ipc, platform: 'win32' });
  const source = fs.readFileSync(path.join(root, directory, 'main.js'), 'utf8');
  const c = { petWindow: window, fullscreenGuard: null, petAlwaysOnTopEnabled: true,
    topmostGuardTimer: null, dragState: null, WINDOWS_TOPMOST_INTERVAL: 1500,
    process: { platform: 'win32' }, ...timers };
  vm.runInNewContext(source.slice(source.indexOf('function setPetAlwaysOnTop('), source.indexOf('function playAction(')), c);
  const guard = createFullscreenGuard({
    window, platform: options.platform || 'win32', timers, now: () => clock,
    screen: { dipToScreenRect: (receivedWindow, bounds) => {
      assert.equal(receivedWindow, window); assert.deepEqual(bounds, window.getBounds()); return physicalBounds;
    } },
    onSuspend: () => suspendedDrags++,
    onResume: () => c.setPetAlwaysOnTop(c.petAlwaysOnTopEnabled, true),
    onError: error => errors.push(error),
    spawnHelper: (command, args, settings) => {
      assert.equal(command, 'powershell.exe');
      assert.ok(args.includes('-NonInteractive'));
      assert.ok(args.includes(String(process.pid)));
      assert.equal(settings.windowsHide, true);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGTERM'); };
      children.push(child); return child;
    }
  });
  c.fullscreenGuard = guard;
  window.on('show', () => c.setPetAlwaysOnTop(c.petAlwaysOnTopEnabled, true));
  c.startTopmostGuard();
  const raw = text => children.at(-1).stdout.emit('data', text);
  const sample = value => raw(JSON.stringify(value) + '\r\n');
  const ready = () => {
    window.emit('ready-to-show');
    ipc.emit('pet:renderer-ready', { sender: window.webContents });
  };
  if (!options.beforeReady) ready();
  return { window, c, calls, guard, children, errors, sample, raw, advance, ready,
    get visible() { return visible; }, get suspendedDrags() { return suspendedDrags; },
    movePhysical: bounds => { physicalBounds = bounds; },
    show: () => showPreparedPet(window), hide: () => hidePreparedPet(window),
    close: () => { guard.stop(); c.stopTopmostGuard(); window.emit('closed'); assert.equal(pending.size, 0); }
  };
}

for (const directory of directories) {
  for (const file of ['fullscreen-guard.js', 'fullscreen-windows.ps1', 'pet-window-ready.js']) {
    assert.equal(fs.readFileSync(path.join(root, directory, file), 'utf8'), fs.readFileSync(path.join(root, 'app', file), 'utf8'), `${directory}: shared ${file} drifted`);
  }
  const h = harness(directory);
  assert.equal(h.guard.canRaise(), false, 'do not fight the foreground app before the first observation');
  h.sample({ state: 'clear' });
  assert.equal(h.guard.canRaise(), false);
  h.sample({ state: 'clear' });
  assert.equal(h.guard.canRaise(), true);
  h.calls.length = 0;
  h.sample(fullscreen);
  assert.equal(h.visible, false);
  assert.equal(h.guard.canRaise(), false);
  assert.equal(h.suspendedDrags, 2);
  assert.deepEqual(h.calls, [['ignoreMouse', true], ['focusable', false], ['topmost', false], ['hide']]);
  h.calls.length = 0;
  h.show(); h.ready(); h.c.setPetAlwaysOnTop(true, true); h.advance(3000);
  assert.equal(h.visible, false, 'tray, renderer-ready and the watchdog cannot override a fullscreen game');
  assert.ok(!h.calls.some(([action, value]) => action === 'moveTop' || action === 'topmost' && value));
  h.sample({ state: 'clear' });
  assert.equal(h.visible, false, 'one transitional clear sample is insufficient');
  h.sample({ state: 'unknown' });
  h.sample({ state: 'clear' });
  assert.equal(h.visible, false, 'unknown HWND resets the exit debounce');
  h.sample({ state: 'clear' });
  assert.equal(h.visible, true);
  assert.ok(h.calls.some(([action]) => action === 'showInactive'));
  assert.equal(h.calls.filter(([action]) => action === 'ignoreMouse').at(-1)[1], false);

  // A hidden pet remains hidden after game exit and page reload.
  h.hide(); h.sample(fullscreen);
  h.window.webContents.emit('did-start-loading'); h.ready();
  h.sample({ state: 'clear' }); h.sample({ state: 'clear' });
  assert.equal(h.visible, false);
  h.show(); assert.equal(h.visible, true);
  h.sample(fullscreen); h.hide();
  h.sample({ state: 'clear' }); h.sample({ state: 'clear' });
  assert.equal(h.visible, false, 'manual hide during fullscreen is retained');

  // Config changes during suppression survive restoration.
  h.sample(fullscreen); h.show(); h.c.setPetAlwaysOnTop(false, true);
  h.calls.length = 0;
  h.sample({ state: 'clear' }); h.sample({ state: 'clear' });
  assert.equal(h.visible, true);
  assert.equal(h.c.petAlwaysOnTopEnabled, false);
  assert.ok(!h.calls.some(([action, value]) => action === 'topmost' && value));
  h.sample(fullscreen); assert.equal(h.visible, false, 'protection also applies when topmost is off');

  // Mixed DPI: comparison uses physical coordinates, including a display to the left.
  h.movePhysical({ x: -1600, y: 100, width: 200, height: 300 });
  h.sample(fullscreen); h.sample(fullscreen);
  assert.equal(h.visible, true, 'a game on the other display does not hide the pet');
  h.sample({ state: 'fullscreen', bounds: { x: -1920, y: 0, width: 1920, height: 1080 } });
  assert.equal(h.visible, false);
  h.movePhysical({ x: -10, y: 100, width: 200, height: 300 });
  h.sample(fullscreen); assert.equal(h.visible, false, 'straddling the game display is protected');

  // Failure must not make an invisible pet interactive, nor revive a dead helper.
  h.raw('{broken}\n');
  assert.equal(h.children[0].killed, true);
  assert.equal(h.visible, false);
  assert.equal(h.errors.length, 1);
  h.advance(1000); assert.equal(h.children.length, 2);
  h.raw('{"state":"cle'); h.raw('ar"}\r\n');
  assert.equal(h.visible, false);
  h.sample({ state: 'clear' }); assert.equal(h.visible, true);
  h.advance(1100); assert.equal(h.guard.canRaise(), false, 'stale observations cannot raise a window');
  h.advance(16000); assert.equal(h.children[1].killed, true, 'stalled helper is restarted');
  h.close();

  const startup = harness(directory, { beforeReady: true });
  startup.sample(fullscreen); startup.ready();
  assert.equal(startup.visible, false);
  startup.sample({ state: 'clear' }); startup.sample({ state: 'clear' });
  assert.equal(startup.visible, true, 'first-frame readiness survives fullscreen at startup');
  startup.close();

  const mac = harness(directory, { platform: 'darwin' });
  assert.equal(mac.children.length, 0); assert.equal(mac.guard.canRaise(), true); mac.close();
  console.log(`PASS ${directory}: fullscreen input/visibility, restore, manual hide, topmost preferences, mixed DPI/displays, startup, helper recovery and cleanup`);
}

// On a Windows build machine also compile the exact shipped C# helper and read
// one native snapshot. This is a smoke test, not a substitute for game testing.
if (process.platform === 'win32') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-fullscreen-native-'));
  try {
    const script = fs.readFileSync(path.join(root, 'app/fullscreen-windows.ps1'), 'utf8')
      .replace('static string Read(int parentId)', 'public static string Read(int parentId)')
      .replace('[PetFullscreenProbe]::Run($ParentProcessId)', '[Console]::Out.WriteLine([PetFullscreenProbe]::Read($ParentProcessId))');
    const file = path.join(temp, 'probe.ps1'); fs.writeFileSync(file, script);
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-ParentProcessId', String(process.pid)], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.ok(['clear', 'fullscreen', 'unknown'].includes(JSON.parse(output.trim()).state));
    console.log('PASS Windows native helper compilation and foreground geometry smoke test');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
} else console.log('SKIP Windows native probe: requires Windows; LOL/exclusive fullscreen still needs device testing.');

const { prepare, shells } = require('./prepare-example.cjs');
for (const variant of Object.keys(shells)) {
  const dir = prepare(variant);
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'electron-builder.json')));
  assert.ok(config.asarUnpack.includes('**/*.ps1'));
  assert.ok(fs.existsSync(path.join(dir, 'fullscreen-windows.ps1')));
}
console.log('PASS packaging: fullscreen helper unpacked in every edition; existing music helpers retained');
