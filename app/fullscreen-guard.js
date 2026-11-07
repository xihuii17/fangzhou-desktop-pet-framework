const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { suppressPreparedPet } = require('./pet-window-ready');

function validRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) &&
    rect.width > 0 && rect.height > 0;
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

// Only the Windows helper reads foreground window geometry. It never opens a
// game process, installs hooks, or sends input to another application.
function createFullscreenGuard({ window, screen, platform = process.platform,
  onSuspend = () => {}, onResume = () => {}, onError = () => {},
  spawnHelper = spawn, now = Date.now,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  if (platform !== 'win32') return { isSuppressed: () => false, canRaise: () => true, stop() {} };

  let stopped = false, suppressed = false, inputBlocked = false, child = null, retryTimer = null;
  let clearSamples = 0, knownAt = null, retryDelay = 1000;
  let lastOutputAt = now();

  function blockInput(value) {
    if (inputBlocked === value || window.isDestroyed()) return;
    inputBlocked = value;
    window.setIgnoreMouseEvents(value);
    window.setFocusable(!value);
    if (value) onSuspend();
  }

  function awaitObservation() {
    knownAt = null;
    clearSamples = 0;
    // On startup or probe failure a pet can still paint, but must not capture
    // clicks or compete for z-order until we can establish what is in front.
    blockInput(true);
    if (!window.isDestroyed()) window.setAlwaysOnTop(false);
  }

  function applySuppression(value) {
    if (stopped || window.isDestroyed() || suppressed === value) return;
    suppressed = value;
    if (value) {
      // Remove hit testing before hiding, so the invisible surface cannot steal
      // a game click even while Windows is processing the hide operation.
      blockInput(true);
      window.setAlwaysOnTop(false);
      suppressPreparedPet(window, true);
    } else {
      blockInput(false);
      // Reapply the user's current preference; do not rewrite saved config.
      onResume();
      suppressPreparedPet(window, false);
    }
  }

  function accept(sample) {
    if (stopped || window.isDestroyed()) return;
    if (!sample || !['clear', 'fullscreen', 'unknown'].includes(sample.state)) return;
    if (sample.state === 'unknown') {
      // Foreground HWND may be null while switching apps or locking the screen.
      awaitObservation();
      return;
    }
    if (sample.state === 'fullscreen' && !validRect(sample.bounds)) return;
    let overlaps = false;
    if (sample.state === 'fullscreen') {
      // Electron bounds are DIP; the native helper returns physical pixels.
      const bounds = screen.dipToScreenRect(window, window.getBounds());
      if (!validRect(bounds)) return;
      overlaps = intersects(bounds, sample.bounds);
    }
    knownAt = now();
    retryDelay = 1000;
    if (overlaps) {
      clearSamples = 0;
      applySuppression(true);
    } else {
      // Two clear observations prevent one transient Alt-Tab frame from
      // restoring an interactive window above an otherwise fullscreen game.
      clearSamples++;
      if (clearSamples >= 2) {
        if (suppressed) applySuppression(false);
        else if (inputBlocked) { blockInput(false); onResume(); }
      }
    }
  }

  function launch() {
    if (stopped) return;
    let helperPath = path.join(__dirname, 'fullscreen-windows.ps1');
    // PowerShell cannot read scripts inside Electron's virtual ASAR filesystem.
    helperPath = helperPath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    let current;
    let output = '', errors = '', failed = false;
    const fail = reason => {
      if (failed || stopped) return;
      failed = true;
      if (child === current) child = null;
      awaitObservation();
      current?.kill();
      onError(String(reason).slice(0, 1000));
      // Keep an already-suppressed pet harmless until a valid observation,
      // including across helper failure/restart and display mode transitions.
      retryTimer = timers.setTimeout(launch, retryDelay);
      retryTimer.unref?.();
      retryDelay = Math.min(retryDelay * 2, 30000);
    };
    try {
      if (!fs.existsSync(helperPath)) throw Error('Missing fullscreen helper: ' + helperPath);
      current = spawnHelper('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', helperPath, '-ParentProcessId', String(process.pid)
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child = current;
      lastOutputAt = now();
      current.stdout.setEncoding('utf8');
      current.stderr.setEncoding('utf8');
      current.stdout.on('data', chunk => {
        if (failed || stopped) return;
        lastOutputAt = now();
        output += chunk;
        if (output.length > 65536) return fail('Fullscreen helper output exceeded limit');
        let newline;
        while ((newline = output.indexOf('\n')) !== -1) {
          const line = output.slice(0, newline).trim();
          output = output.slice(newline + 1);
          if (!line) continue;
          try { accept(JSON.parse(line)); }
          catch (error) { fail(error); return; }
        }
      });
      current.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
      current.once('error', fail);
      current.once('exit', (code, signal) => fail(errors || `Fullscreen helper exited (${code ?? signal})`));
      current.failFullscreenProbe = fail;
    } catch (error) { fail(error); }
  }

  const watchdog = timers.setInterval(() => {
    if (knownAt !== null && now() - knownAt >= 1000) awaitObservation();
    if (child && now() - lastOutputAt > 15000) child.failFullscreenProbe('Fullscreen helper timed out');
  }, 1000);
  watchdog.unref?.();
  awaitObservation();
  launch();
  return {
    isSuppressed: () => suppressed,
    canRaise: () => !stopped && !suppressed && !inputBlocked && knownAt !== null && now() - knownAt < 1000,
    stop() {
      stopped = true;
      timers.clearTimeout(retryTimer);
      timers.clearInterval(watchdog);
      child?.kill();
      child = null;
    }
  };
}

module.exports = { createFullscreenGuard };
