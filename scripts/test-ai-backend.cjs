// All keys, personas, profiles and network replies in this suite are synthetic.
// No Electron session, real userData or paid API is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { AIChatService, AIChatError, publicAIError, aiErrorCode, DEFAULT_MODEL } = require('../variants/ai/app/ai-chat');
const root = path.resolve(__dirname, '..');
const KEY = 'sk-test-only-never-a-real-credential';
const PRIVATE_ERROR = KEY + ' synthetic-private-chat';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (content = '我在，慢慢说。') => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ model = 'deepseek-v4-flash', autoLearn = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-ai-backend-'));
  const characterDir = path.join(dir, 'character'); fs.mkdirSync(characterDir);
  const character = { name: '测试伙伴乙', features: { aiChat: true }, aiPersona: 'persona.json' };
  fs.writeFileSync(path.join(characterDir, 'persona.json'), JSON.stringify({ model, endpoint: 'https://example.invalid/never-send-keys',
    defaultProfile: { identity: '测试伙伴乙自己的经历', relationship: '熟悉的朋友' },
    dialogueExamples: [{ user: '你好', assistant: '欢迎回来' }], emotionActions: { neutral: ['idle'], caring: ['care'] } }));
  const state = { calls: [], statuses: [], logs: [], decryptions: 0,
    config: { aiChatEnabled: true, aiMemoryEnabled: true, aiLongTermMemoryEnabled: true, aiAutoLearnEnabled: autoLearn, activityMode: 'study' },
    fetch: async () => response() };
  const timers = new Map(); let serial = 0;
  const service = new AIChatService({ app: { getPath: () => dir }, character, characterDir,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from('test-encrypted:' + s),
      decryptString: b => { state.decryptions++; return b.toString().replace(/^test-encrypted:/, ''); } },
    net: { fetch: async (url, options) => { state.calls.push({ url, options, body: JSON.parse(options.body) }); return state.fetch(url, options); } },
    now: () => new Date(2026, 10, 6, 12, 34, 56), getConfig: () => state.config,
    onStatusChange: status => state.statuses.push(status), writeDiagnosticLog: (event, details) => state.logs.push({ event, details }),
    timers: { setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) }
  });
  service.saveApiKey(KEY);
  return { dir, service, state, timers, character,
    expire() { for (const { fn } of [...timers.values()]) fn(); },
    cleanup() { service.cancelAll(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

let passed = 0;
async function check(name, run, options) {
  const f = fixture(options);
  try { await run(f); passed++; console.log('PASS ' + name); }
  finally { f.cleanup(); }
}

async function main() {
  await check('connection allowlist, legacy model migration, timeout range and safeStorage-only key', async ({ service, dir, state }) => {
    assert.deepEqual(service.getConnectionSettings(), { model: 'deepseek-flash', timeoutSeconds: 60 });
    assert.equal(state.decryptions, 0, 'status must not decrypt keys');
    for (const seconds of [30, 60, 120]) for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
      const saved = service.saveConnectionSettings({ model, timeoutSeconds: seconds, apiKey: KEY, endpoint: 'https://example.invalid' });
      assert.deepEqual(Object.keys(saved), ['model', 'timeoutSeconds']);
      assert.deepEqual(JSON.parse(fs.readFileSync(service.connectionSettingsPath)), saved);
      assert.equal(service.status().model, model);
    }
    const before = fs.readFileSync(service.connectionSettingsPath, 'utf8');
    for (const value of [{ model: 'unknown', timeoutSeconds: 60 }, { model: DEFAULT_MODEL, timeoutSeconds: 29 }, { model: DEFAULT_MODEL, timeoutSeconds: 121 }, { model: DEFAULT_MODEL, timeoutSeconds: '60' }, { model: DEFAULT_MODEL, timeoutSeconds: NaN }]) assert.throws(() => service.saveConnectionSettings(value), /30–120/);
    assert.equal(fs.readFileSync(service.connectionSettingsPath, 'utf8'), before);
    assert.ok(!before.includes(KEY));
    const result = await service.chat('你好');
    assert.ok(result.reply); assert.equal(service.readMemory().length, 2);
    assert.equal(state.calls[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(state.calls[0].options.redirect, 'error');
    assert.equal(state.calls[0].body.model, 'deepseek-v4-pro');
    assert.equal(state.calls[0].options.headers.Authorization, 'Bearer ' + KEY);
    assert.ok(!JSON.stringify(state.statuses).includes(KEY));
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) assert.ok(!fs.readFileSync(path.join(dir, name), 'utf8').includes(KEY));
    assert.equal(service.status().busy, false);
  });
  await check('existing Pro persona retains supported model', ({ service }) => assert.equal(service.getConnectionSettings().model, 'deepseek-v4-pro'), { model: 'deepseek-v4-pro' });
  await check('character-specific examples, local time and app-only companion mode', async ({ service, state }) => {
    await service.chat('下午好');
    const prompt = state.calls[0].body.messages[0].content;
    assert.ok(prompt.includes('测试伙伴乙：欢迎回来'));
    assert.ok(!prompt.includes('庄方宜'));
    assert.ok(prompt.includes('2026') && prompt.includes('12:34:56') && prompt.includes('学习陪伴'));
    assert.ok(prompt.includes('没有读取屏幕、剪贴板或其他文件'));
  });
  await check('401/402/429/400/403/404/422/500/503 and unknown HTTP errors never expose provider bodies', async ({ service, state }) => {
    for (const status of [401, 402, 429, 400, 403, 404, 422, 500, 503, 418]) {
      state.fetch = async () => ({ ok: false, status, text: () => assert.fail('provider error body must not be read') });
      await assert.rejects(service.chat('测试'), error => error instanceof AIChatError && error.code.startsWith('HTTP_') && !error.message.includes(PRIVATE_ERROR));
      assert.equal(service.status().busy, false);
      assert.deepEqual(service.readMemory(), []);
    }
    state.fetch = async () => { throw Error(PRIVATE_ERROR); };
    await assert.rejects(service.chat('测试'), error => error.code === 'NETWORK' && !error.message.includes(KEY));
    assert.ok(!JSON.stringify(state.logs).includes(KEY));
  });
  await check('malformed success payload is actionable and does not overwrite history', async ({ service, state }) => {
    state.fetch = async () => ({ ok: true, text: async () => PRIVATE_ERROR });
    await assert.rejects(service.chat('测试'), error => error.code === 'BAD_RESPONSE' && !error.message.includes(KEY));
    assert.deepEqual(service.readMemory(), []);
  });
  for (const phase of ['headers', 'body']) await check('deadline covers ' + phase + ' even when transport ignores abort', async ({ service, state, timers, expire }) => {
    const late = deferred();
    state.fetch = async () => phase === 'headers' ? late.promise : { ok: true, status: 200, text: () => late.promise };
    const pending = service.chat('请记住我喜欢测试');
    const rejected = assert.rejects(pending, error => error.code === 'TIMEOUT' && error.message.includes('等待时间'));
    await flush(); assert.equal([...timers.values()][0].ms, 60000); expire(); await rejected;
    assert.ok(state.calls[0].options.signal.aborted);
    late.resolve(phase === 'headers' ? response() : JSON.stringify({ choices: [{ message: { content: '迟到内容' } }] }));
    await flush(); assert.deepEqual(service.readMemory(), []); assert.deepEqual(service.readLongTermMemories(), []);
    assert.equal(timers.size, 0);
  });
  await check('concurrent chat rejected; cancellation releases busy and stale finally cannot clear a new request', async ({ service, state }) => {
    const first = deferred(), second = deferred(); let n = 0;
    state.fetch = () => (++n === 1 ? first.promise : second.promise);
    const old = service.chat('请记住取消这轮');
    const oldRejected = assert.rejects(old, e => e.code === 'CANCELLED');
    assert.equal(service.status().busy, true);
    await assert.rejects(service.chat('并发消息'), e => e.code === 'BUSY');
    assert.equal(state.calls.length, 1);
    assert.deepEqual(service.cancelAll(), { ok: true });
    const current = service.chat('下一轮'); await oldRejected;
    assert.equal(service.status().busy, true);
    first.resolve(response('旧回复')); await flush();
    assert.equal(service.status().busy, true); assert.deepEqual(service.readMemory(), []);
    second.resolve(response('新回复')); await current;
    assert.deepEqual(service.readMemory().map(m => m.content), ['下一轮', '新回复']);
    assert.deepEqual(service.readLongTermMemories(), []);
    assert.equal(service.status().busy, false);
  });
  for (const action of ['history', 'key', 'disable', 'long-disable']) await check('pending chat cannot write after ' + action, async ({ service, state }) => {
    const late = deferred(); state.fetch = () => late.promise;
    service.writeMemory([{ role: 'user', content: '旧对话' }]);
    const pending = service.chat('请记住这轮正在等待');
    const rejected = assert.rejects(pending, e => e.code === 'CANCELLED');
    if (action === 'history') service.clearMemory();
    if (action === 'key') service.clearApiKey();
    if (action === 'disable' || action === 'long-disable') {
      const previous = { ...state.config };
      state.config[action === 'disable' ? 'aiChatEnabled' : 'aiLongTermMemoryEnabled'] = false;
      service.configChanged(previous, state.config);
    }
    await rejected; late.resolve(response()); await flush();
    assert.deepEqual(service.readLongTermMemories(), []);
    assert.deepEqual(service.readMemory().map(m => m.content), action === 'history' ? [] : ['旧对话']);
  });
  await check('automatic learning defaults off and does not call network', async ({ service, state }) => {
    assert.deepEqual(await service.inferPreferences('我喜欢无糖咖啡'), []);
    assert.equal(state.calls.length, 0);
  });
  await check('deleting a memory cancels an older explicit-memory chat', async ({ service, state }) => {
    const item = service.addLongTermMemory('用户喜欢测试咖啡');
    const late = deferred(); state.fetch = () => late.promise;
    const pending = service.chat('请记住用户喜欢测试咖啡');
    const rejected = assert.rejects(pending, e => e.code === 'CANCELLED');
    service.deleteLongTermMemory(item.id); late.resolve(response()); await rejected; await flush();
    assert.deepEqual(service.readLongTermMemories(), []); assert.deepEqual(service.readMemory(), []);
  });
  await check('history damaged during a pending request is not replaced by a late reply', async ({ service, state }) => {
    const late = deferred(); state.fetch = () => late.promise;
    const pending = service.chat('请记住本轮临时信息');
    const rejected = assert.rejects(pending, e => e.code === 'DATA_READ');
    fs.writeFileSync(service.memoryPath, '{damaged during request');
    late.resolve(response()); await rejected;
    assert.equal(fs.readFileSync(service.memoryPath, 'utf8'), '{damaged during request');
    assert.deepEqual(service.readLongTermMemories(), []);
  });
  for (const mutation of ['disable', 'delete', 'clear', 'history']) await check('inference race: ' + mutation + ' cannot resurrect preferences', async ({ service, state }) => {
    const existing = service.addLongTermMemory('用户喜欢测试咖啡');
    const late = deferred(); state.fetch = () => late.promise;
    const pending = service.inferPreferences('我喜欢测试咖啡');
    if (mutation === 'disable') {
      const previous = { ...state.config }; state.config.aiAutoLearnEnabled = false;
      service.configChanged(previous, state.config);
      state.config.aiAutoLearnEnabled = true; // Re-enabling cannot revive the old operation.
    }
    if (mutation === 'delete') service.deleteLongTermMemory(existing.id);
    if (mutation === 'clear') service.clearLongTermMemories();
    if (mutation === 'history') service.clearMemory();
    late.resolve(response('{"memories":[{"content":"用户喜欢测试咖啡"},{"content":"用户喜欢旧请求产物"}]}'));
    assert.deepEqual(await pending, []);
    assert.equal(service.readLongTermMemories().length, ['delete', 'clear'].includes(mutation) ? 0 : 1);
  }, { autoLearn: true });
  await check('enabled inference merges current memory, deduplicates and persists once', async ({ service, state }) => {
    state.fetch = async () => response('{"memories":[{"content":"用户喜欢无糖咖啡","category":"喜好"}]}');
    assert.equal((await service.inferPreferences('我喜欢无糖咖啡')).length, 1);
    assert.equal((await service.inferPreferences('我喜欢无糖咖啡')).length, 0);
    assert.equal(service.readLongTermMemories().length, 1);
  }, { autoLearn: true });
  await check('history-off inference sends only this input, even with damaged old history', async ({ service, state }) => {
    state.config.aiMemoryEnabled = false;
    service.writeMemory([{ role: 'user', content: 'NEVER_SEND_OLD_HISTORY_SENTINEL' }]);
    state.fetch = async () => response('{"memories":[]}');
    await service.inferPreferences('我喜欢清淡的茶');
    assert.ok(!JSON.stringify(state.calls.at(-1).body).includes('NEVER_SEND_OLD_HISTORY_SENTINEL'));
    assert.equal(state.calls.at(-1).body.messages[1].content, '- 我喜欢清淡的茶');
    fs.writeFileSync(service.memoryPath, '{broken');
    await service.inferPreferences('我喜欢安静聊天');
    assert.equal(state.calls.at(-1).body.messages[1].content, '- 我喜欢安静聊天');
    assert.equal(fs.readFileSync(service.memoryPath, 'utf8'), '{broken');
  }, { autoLearn: true });
  for (const kind of ['history', 'long']) await check('corrupt/unreadable ' + kind + ' is preserved and blocks overwrite', async ({ service, state }) => {
    const file = kind === 'history' ? service.memoryPath : service.longTermMemoryPath;
    for (const data of ['{broken ' + PRIVATE_ERROR, '{}', '[{"invalid":true}]']) {
      fs.writeFileSync(file, data);
      const read = () => kind === 'history' ? service.readMemory() : service.readLongTermMemories();
      assert.throws(read, e => e.code === 'DATA_READ' && !e.message.includes(KEY));
      assert.throws(() => kind === 'history' ? service.writeMemory([]) : service.writeLongTermMemories([]), /原文件已保留/);
      await assert.rejects(service.chat('测试'), /原文件已保留/);
      assert.equal(fs.readFileSync(file, 'utf8'), data);
      const before = new Set(fs.readdirSync(path.dirname(file)));
      assert.equal(kind === 'history' ? service.clearMemory() : service.clearLongTermMemories(), true);
      const backups = fs.readdirSync(path.dirname(file)).filter(name => !before.has(name) && name.endsWith('.bak'));
      assert.equal(backups.length, 1);
      const backup = path.join(path.dirname(file), backups[0]);
      assert.equal(fs.readFileSync(backup, 'utf8'), data);
      assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
      assert.deepEqual(read(), []);
    }
    fs.mkdirSync(file);
    await assert.rejects(service.chat('测试'), /原文件已保留/);
    assert.ok(fs.statSync(file).isDirectory()); assert.equal(state.calls.length, 0);
  });
  await check('atomic file replacement failure preserves previous bytes and sanitizes OS errors', ({ service }) => {
    service.writeMemory([{ role: 'user', content: '保留这段历史' }]);
    const before = fs.readFileSync(service.memoryPath), rename = fs.renameSync;
    fs.renameSync = () => { throw Error(PRIVATE_ERROR); };
    try { assert.throws(() => service.writeMemory([]), e => e.code === 'DATA_WRITE' && !e.message.includes(KEY)); }
    finally { fs.renameSync = rename; }
    assert.deepEqual(fs.readFileSync(service.memoryPath), before);
  });
  await check('explicit damaged-history clear refuses deletion when backup cannot be written', ({ service }) => {
    fs.writeFileSync(service.memoryPath, '{keep damaged bytes');
    const write = fs.writeFileSync;
    fs.writeFileSync = () => { throw Error(PRIVATE_ERROR); };
    try { assert.throws(() => service.clearMemory(), e => e.code === 'DATA_BACKUP' && !e.message.includes(KEY)); }
    finally { fs.writeFileSync = write; }
    assert.equal(fs.readFileSync(service.memoryPath, 'utf8'), '{keep damaged bytes');
  });
  await testIPC();
  console.log(`PASS ${passed} AI backend scenarios; mocked network/isolated storage only, no paid API or real credentials.`);
}

// Real main-process handlers and preload adapter, with Electron surfaces mocked.
async function testIPC() {
  await check('real IPC/preload contracts, broadcast, defaults and no late action after close/clear/disable', async f => {
    const { dir, service, state, character } = f;
    const source = fs.readFileSync(path.join(root, 'variants/ai/app/main.js'), 'utf8');
    const handlers = new Map(), renderer = new EventEmitter(), reactions = [];
    renderer.invoke = (channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({ sender: { isDestroyed: () => false } }, ...args));
    renderer.send = () => {};
    class Window extends EventEmitter {
      constructor() { super(); this.webContents = new EventEmitter(); this.webContents.send = (channel, value) => renderer.emit(channel, {}, value); }
      isDestroyed() { return false; } loadFile() {} show() {} focus() {}
    }
    const context = { fs, path, __dirname: path.join(root, 'variants/ai/app'), console,
      AIChatError, publicAIError, aiErrorCode, DEFAULT_MODEL, aiChatService: service,
      CHARACTER: character, DEFAULT_ACTION_ID: 'idle', ACTION_MODES: new Set(['daily', 'office', 'quiet']), LYRICS_AVAILABLE: false,
      DEFAULT_APPEARANCE_ID: 'default', HAS_MULTIPLE_APPEARANCES: false, APPEARANCES: [], safeAppearanceId: () => 'default',
      CONFIG_PATH: () => path.join(dir, 'config.json'), CUSTOM_MANIFEST_PATH: () => path.join(dir, 'custom.json'), ACTIONS: [],
      safeScale: n => n, safeBubbleScale: n => n, safeLyricsScale: n => n, safeMode: n => n,
      writeCustomManifest() {}, removeEmptyManifestEntry() {}, applyWindowConfig() {}, sendConfig() {}, configureLyrics() {},
      app: { setLoginItemSettings() {} }, process: { platform: 'darwin' },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      petWindow: new Window(), settingsWindow: new Window(), managerWindow: null, chatWindow: null,
      BrowserWindow: Window, ICON_PATH: '', createSettingsWindow() {},
      playAIReaction: emotion => { reactions.push(emotion); return { emotion }; },
      writeDiagnosticLog: (event, details) => state.logs.push({ event, details }) };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('const DEFAULT_CONFIG ='), source.indexOf('const WINDOW_BASE =')) +
      source.slice(source.indexOf('function readConfig()'), source.indexOf('function readCustomManifest()')) +
      source.slice(source.indexOf('function persistConfig('), source.indexOf('function sendLyrics(')) +
      source.slice(source.indexOf('function createChatWindow()'), source.indexOf('function toggleQuietMode()')) +
      source.slice(source.indexOf("ipcMain.handle('config:save'"), source.indexOf("ipcMain.handle('lyrics:status-get'")) +
      source.slice(source.indexOf('function sendAIStatus('), source.indexOf("ipcMain.handle('chat:open'")), context);
    service.getConfig = () => context.readConfig();
    service.onStatusChange = status => { state.statuses.push(status); context.sendAIStatus(status); };
    let api;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'variants/ai/app/preload.js'), 'utf8'), {
      process: { platform: 'darwin' }, require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: renderer })
    });
    assert.equal(context.readConfig().aiAutoLearnEnabled, false, 'new profiles default off');
    const config = { ...plain(context.readConfig()), aiChatEnabled: true, firstLaunch: false };
    for (const enabled of [true, false]) {
      fs.writeFileSync(context.CONFIG_PATH(), JSON.stringify({ ...config, aiAutoLearnEnabled: enabled }));
      assert.equal(context.readConfig().aiAutoLearnEnabled, enabled);
    }
    const legacy = { ...config }; delete legacy.aiAutoLearnEnabled;
    fs.writeFileSync(context.CONFIG_PATH(), JSON.stringify(legacy));
    assert.equal(context.readConfig().aiAutoLearnEnabled, true, 'existing pre-switch profiles retain the old default');
    fs.writeFileSync(context.CONFIG_PATH(), JSON.stringify(config));
    const events = [], unsubscribe = api.onAIStatusChanged(status => events.push(status));
    const saved = await api.saveAIConnectionSettings({ model: 'deepseek-v4-pro', timeoutSeconds: 90, apiKey: KEY });
    assert.equal(saved.ok, true); assert.equal(saved.status.model, 'deepseek-v4-pro');
    assert.deepEqual(plain(await api.getAIConnectionSettings()), { model: 'deepseek-v4-pro', timeoutSeconds: 90 });
    assert.ok(events.length); assert.ok(!JSON.stringify(events).includes(KEY));
    await api.saveConfig({ apiKey: KEY, endpoint: 'https://example.invalid', aiAutoLearnEnabled: false });
    assert.ok(!fs.readFileSync(context.CONFIG_PATH(), 'utf8').includes(KEY));
    assert.equal((await api.getAIStatus()).configured, true);
    const bad = await api.saveAIConnectionSettings({ model: 'invalid', timeoutSeconds: 60 });
    assert.equal(bad.ok, false); assert.ok(bad.settings && bad.status && bad.error);
    state.fetch = async () => ({ ok: false, status: 401, text: () => assert.fail('must not read error body') });
    const connection = await api.testAIConnection();
    assert.equal(connection.ok, false); assert.match(connection.error, /重新填写/);
    assert.equal((await api.getAIStatus()).busy, false);
    state.fetch = async () => { throw Error(PRIVATE_ERROR); };
    const network = await api.sendAIMessage('网络失败示例');
    assert.equal(network.ok, false); assert.match(network.error, /网络或代理/);
    assert.ok(!JSON.stringify([connection, network]).includes(KEY));
    for (const cancel of ['button', 'close', 'history', 'key', 'disable']) {
      context.createChatWindow();
      await api.saveConfig({ aiChatEnabled: true });
      if (!service.status().configured) await api.saveAIKey(KEY);
      const late = deferred(); state.fetch = () => late.promise;
      const pending = api.sendAIMessage('请记住这轮尚未完成'); await flush();
      assert.equal((await api.getAIStatus()).busy, true);
      if (cancel === 'button') assert.equal((await api.cancelAIMessage()).ok, true);
      if (cancel === 'close') { context.chatWindow.emit('close'); context.chatWindow.emit('closed'); }
      if (cancel === 'history') await api.clearAIMemory();
      if (cancel === 'key') await api.clearAIKey();
      if (cancel === 'disable') await api.saveConfig({ aiChatEnabled: false });
      const result = await pending;
      assert.deepEqual(plain(result), { ok: false, cancelled: true, error: '已停止回复' });
      late.resolve(response('迟到内容')); await flush();
      assert.equal(reactions.length, 0); assert.deepEqual(service.readMemory(), []); assert.deepEqual(service.readLongTermMemories(), []);
    }
    await api.saveConfig({ aiChatEnabled: true });
    state.fetch = async () => response();
    // Clear after the service's commit but before the IPC await continuation.
    let clearOnComplete = true;
    service.onStatusChange = status => {
      context.sendAIStatus(status);
      if (!status.busy && clearOnComplete) { clearOnComplete = false; service.clearMemory(); }
    };
    const cleared = await api.sendAIMessage('完成瞬间清空');
    assert.equal(cleared.cancelled, true); assert.equal(reactions.length, 0); assert.deepEqual(service.readMemory(), []);
    fs.writeFileSync(service.memoryPath, '{bad');
    await assert.rejects(api.getAIHistory(), /原文件已保留/);
    const clear = await api.clearAIMemory(); assert.equal(clear.ok, true); assert.equal(fs.existsSync(service.memoryPath), false);
    assert.ok(fs.readdirSync(dir).some(name => name.endsWith('.bak') && fs.readFileSync(path.join(dir, name), 'utf8') === '{bad'));
    assert.ok(!JSON.stringify(state.logs).includes(KEY));
    const count = renderer.listenerCount('ai:status-changed'); unsubscribe(); assert.equal(renderer.listenerCount('ai:status-changed'), count - 1);
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
