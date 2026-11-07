// Lock and suspend are independent: resume is not the same as unlock.
function bindCompanionActivity(powerMonitor, store, run = fn => fn()) {
  let locked = powerMonitor.getSystemIdleState?.(1) === 'locked';
  let suspended = false;
  const update = () => run(() => store.setActive(!locked && !suspended));
  const handlers = {
    'lock-screen': () => { locked = true; update(); },
    'unlock-screen': () => { locked = false; update(); },
    suspend: () => { suspended = true; update(); },
    resume: () => { suspended = false; update(); }
  };
  for (const [event, handler] of Object.entries(handlers)) powerMonitor.on(event, handler);
  update();
  return () => {
    for (const [event, handler] of Object.entries(handlers)) powerMonitor.removeListener(event, handler);
  };
}
module.exports = { bindCompanionActivity };
