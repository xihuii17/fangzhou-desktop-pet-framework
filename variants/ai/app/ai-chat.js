const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODELS = new Set([DEFAULT_MODEL, 'deepseek-v4-pro']);
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_HISTORY_MESSAGES = 20;
const MAX_LONG_TERM_MEMORIES = 50;
const MAX_LONG_TERM_MEMORY_LENGTH = 160;
const MAX_CUSTOM_PERSONA_LENGTH = 1200;

class AIChatError extends Error {
  constructor(code, message) { super(message); this.name = 'AIChatError'; this.code = code; }
}
const cancelledError = () => new AIChatError('CANCELLED', '已停止回复');
const publicAIError = (error, fallback = '操作未完成，请稍后重试。') => error instanceof AIChatError ? error.message : fallback;
const aiErrorCode = error => error instanceof AIChatError ? error.code : 'UNEXPECTED';

class AIChatService {
  constructor({ app, net, safeStorage, character, characterDir, writeDiagnosticLog,
    onStatusChange = () => {}, getConfig = () => ({}), now = () => new Date(),
    timers = { setTimeout, clearTimeout } }) {
    this.app = app;
    this.net = net;
    this.safeStorage = safeStorage;
    this.character = character;
    this.characterDir = characterDir;
    this.writeDiagnosticLog = writeDiagnosticLog || (() => {});
    this.persona = this.readPersona();
    this.onStatusChange = onStatusChange;
    this.getConfig = getConfig;
    this.now = now;
    this.timers = timers;
    this.generation = 0;
    this.operations = new Set();
    this.foreground = null;
    this.inference = null;
  }

  get connectionSettingsPath() { return path.join(this.app.getPath('userData'), 'ai-connection-settings.json'); }

  getConnectionSettings() {
    const defaults = { model: MODELS.has(this.persona?.model) ? this.persona.model : DEFAULT_MODEL, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
    try {
      const saved = JSON.parse(fs.readFileSync(this.connectionSettingsPath, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !Number.isFinite(saved.timeoutSeconds) || saved.timeoutSeconds < 30 || saved.timeoutSeconds > 120) throw Error('invalid');
      return { model: MODELS.has(saved.model) ? saved.model : DEFAULT_MODEL, timeoutSeconds: Math.round(saved.timeoutSeconds) };
    } catch (error) {
      if (error.code === 'ENOENT') return defaults;
      throw new AIChatError('SETTINGS_READ', '连接设置读取失败，原文件已保留。请重新选择模型和等待时间并保存。');
    }
  }

  saveConnectionSettings(value) {
    const seconds = value?.timeoutSeconds;
    if (!MODELS.has(value?.model) || typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 30 || seconds > 120) {
      throw new AIChatError('SETTINGS_INVALID', '请选择支持的 DeepSeek 模型，等待时间应为 30–120 秒的整数。');
    }
    // Only this allowlist is serialized: never persist keys or endpoint overrides.
    const settings = { model: value.model, timeoutSeconds: seconds };
    this.cancelAll();
    this.writeJson(this.connectionSettingsPath, settings);
    this.emitStatus();
    return settings;
  }

  emitStatus() {
    try { this.onStatusChange(this.status()); } catch (_error) {}
  }

  beginOperation(kind) {
    if (kind !== 'inference' && this.foreground) throw new AIChatError('BUSY', '正在回复或测试连接，请先停止当前请求再试。');
    if (kind === 'inference') this.cancelInference();
    const operation = { kind, generation: this.generation, controller: new AbortController() };
    this.operations.add(operation);
    if (kind === 'inference') this.inference = operation;
    else { this.foreground = operation; this.emitStatus(); }
    return operation;
  }

  finishOperation(operation) {
    this.operations.delete(operation);
    if (this.inference === operation) this.inference = null;
    if (this.foreground === operation) { this.foreground = null; this.emitStatus(); }
  }

  assertCurrent(operation) {
    if (operation.controller.signal.aborted || operation.generation !== this.generation) throw cancelledError();
  }

  cancelInference() {
    if (this.inference) {
      this.inference.controller.abort();
      this.operations.delete(this.inference);
      this.inference = null;
    }
  }

  cancelAll() {
    this.generation++;
    for (const operation of this.operations) operation.controller.abort();
    this.operations.clear();
    this.foreground = null;
    this.inference = null;
    this.emitStatus();
    return { ok: true };
  }

  configChanged(previous, next) {
    if ((previous.aiChatEnabled && !next.aiChatEnabled) ||
        (previous.aiMemoryEnabled && !next.aiMemoryEnabled) ||
        (previous.aiLongTermMemoryEnabled && !next.aiLongTermMemoryEnabled)) this.cancelAll();
    if (next.aiAutoLearnEnabled !== true || next.aiLongTermMemoryEnabled === false) this.cancelInference();
  }

  canInfer() {
    const config = this.getConfig();
    return config.aiChatEnabled !== false && config.aiAutoLearnEnabled === true && config.aiLongTermMemoryEnabled !== false;
  }

  readArray(file, validate, label) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(saved) || !saved.every(validate)) throw Error('invalid');
      return saved;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new AIChatError('DATA_READ', `${label}读取失败，原文件已保留。请先备份并修复该文件，再继续使用记忆。`);
    }
  }

  writeJson(file, value) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } catch (_error) {
      throw new AIChatError('DATA_WRITE', '本地资料保存失败，原文件未替换。请检查磁盘空间和文件权限后重试。');
    } finally {
      try { fs.unlinkSync(temporary); } catch (_error) {}
    }
  }

  removeFile(file) {
    try { fs.unlinkSync(file); } catch (error) {
      if (error.code !== 'ENOENT') throw new AIChatError('DATA_DELETE', '文件未能删除，请检查文件权限后重试。');
    }
  }

  clearDataFile(file, read) {
    try { read(); }
    catch (error) {
      if (aiErrorCode(error) !== 'DATA_READ') throw error;
      // This path is only reached by an explicit clear command, never a read.
      // Keep the exact damaged bytes before allowing a fresh empty history.
      const backup = `${file}.preserved-${crypto.randomUUID()}.bak`;
      try {
        const bytes = fs.readFileSync(file);
        fs.writeFileSync(backup, bytes, { mode: 0o600, flag: 'wx' });
        if (!fs.readFileSync(backup).equals(bytes) || !fs.readFileSync(file).equals(bytes)) throw Error('changed');
      } catch (_error) {
        throw new AIChatError('DATA_BACKUP', '无法备份损坏的记录，原文件已保留。请检查磁盘空间和文件权限后再清空。');
      }
    }
    this.removeFile(file);
    return true;
  }

  get available() {
    return Boolean(this.character.features?.aiChat && this.persona);
  }

  get keyPath() {
    return path.join(this.app.getPath('userData'), 'deepseek-key.bin');
  }

  get memoryPath() {
    return path.join(this.app.getPath('userData'), 'ai-chat-memory.json');
  }

  get longTermMemoryPath() {
    return path.join(this.app.getPath('userData'), 'ai-long-term-memory.json');
  }

  get customPersonaPath() {
    return path.join(this.app.getPath('userData'), 'ai-persona-custom.json');
  }

  get defaultPersonaOverridePath() {
    return path.join(this.app.getPath('userData'), 'ai-persona-default-override.json');
  }

  readPersona() {
    const relativePath = this.character.aiPersona || 'persona.json';
    try {
      return JSON.parse(fs.readFileSync(path.join(this.characterDir, relativePath), 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  status() {
    let model = DEFAULT_MODEL;
    try { model = this.getConnectionSettings().model; } catch (_error) {}
    return {
      available: this.available,
      configured: Boolean(this.available && this.safeStorage.isEncryptionAvailable() && fs.existsSync(this.keyPath)),
      model,
      busy: Boolean(this.foreground),
      characterName: this.character.name
    };
  }

  readApiKey() {
    if (!this.available || !this.safeStorage.isEncryptionAvailable()) return '';
    try {
      const encrypted = fs.readFileSync(this.keyPath);
      return this.safeStorage.decryptString(encrypted).trim();
    } catch (_error) {
      return '';
    }
  }

  saveApiKey(value) {
    if (!this.available) throw new AIChatError('VALIDATION', '这个角色没有启用 AI 对话。');
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new AIChatError('VALIDATION', '当前系统无法安全保存 API Key。');
    }
    const apiKey = String(value || '').trim();
    if (apiKey.length < 12 || apiKey.length > 256) {
      throw new AIChatError('VALIDATION', '请输入有效的 DeepSeek API Key。');
    }
    this.cancelAll();
    const temporary = `${this.keyPath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
      fs.writeFileSync(temporary, this.safeStorage.encryptString(apiKey), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.keyPath);
    } catch (_error) {
      throw new AIChatError('KEY_WRITE', '密钥保存失败，请检查系统安全存储和文件权限后重试。');
    } finally { try { fs.unlinkSync(temporary); } catch (_error) {} }
    this.emitStatus();
    return this.status();
  }

  clearApiKey() {
    this.cancelAll();
    this.removeFile(this.keyPath);
    this.emitStatus();
    return this.status();
  }

  readMemory() {
      return this.readArray(this.memoryPath, item => ['user', 'assistant'].includes(item?.role) && typeof item?.content === 'string', '最近对话')
        .slice(-MAX_HISTORY_MESSAGES)
        .map((item) => ({ role: item.role, content: item.content.slice(0, 2000) }));
  }

  writeMemory(messages) {
    this.readMemory(); // Recheck the file before replacing it, including after a request.
    this.writeJson(this.memoryPath, messages.slice(-MAX_HISTORY_MESSAGES));
  }

  clearMemory() {
    this.cancelAll();
    return this.clearDataFile(this.memoryPath, () => this.readMemory());
  }

  normalizeLongTermMemory(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_LONG_TERM_MEMORY_LENGTH);
  }

  memoryComparisonKey(value) {
    return this.normalizeLongTermMemory(value)
      .toLocaleLowerCase()
      .replace(/[，。！？、,.!?\s]/g, '')
      .replace(/^(?:用户|我)/, '');
  }

  readLongTermMemories() {
      return this.readArray(this.longTermMemoryPath, item => item && typeof item.id === 'string' && item.id.length > 0 && typeof item.content === 'string' && item.content.trim().length > 0, '长期记忆')
        .map((item) => ({
          id: item.id.slice(0, 80),
          content: this.normalizeLongTermMemory(item.content),
          source: ['manual', 'explicit', 'inferred'].includes(item.source) ? item.source : 'manual',
          category: typeof item.category === 'string' ? item.category.slice(0, 24) : '其他',
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : null
        }))
        .filter((item) => item.content)
        .slice(-MAX_LONG_TERM_MEMORIES);
  }

  writeLongTermMemories(items) {
    this.readLongTermMemories();
    this.writeJson(this.longTermMemoryPath, items.slice(-MAX_LONG_TERM_MEMORIES));
  }

  addLongTermMemory(value, metadata = {}) {
    const content = this.normalizeLongTermMemory(value);
    if (content.length < 2) throw new AIChatError('VALIDATION', '记忆内容太短了。');
    const items = this.readLongTermMemories();
    const comparisonKey = this.memoryComparisonKey(content);
    const duplicate = items.find((item) => this.memoryComparisonKey(item.content) === comparisonKey);
    if (duplicate) return { ...duplicate, duplicate: true };
    if (items.length >= MAX_LONG_TERM_MEMORIES) throw new AIChatError('VALIDATION', '长期记忆已经存满，请先删除一条。');

    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      content,
      source: ['manual', 'explicit', 'inferred'].includes(metadata.source) ? metadata.source : 'manual',
      category: String(metadata.category || '其他').trim().slice(0, 24) || '其他',
      createdAt: now,
      updatedAt: now
    };
    this.writeLongTermMemories([...items, item]);
    return item;
  }

  updateLongTermMemory(id, value) {
    this.cancelInference();
    const memoryId = String(id || '').slice(0, 80);
    const content = this.normalizeLongTermMemory(value);
    if (!memoryId || content.length < 2) throw new AIChatError('VALIDATION', '请输入有效的记忆内容。');
    const items = this.readLongTermMemories();
    const index = items.findIndex((item) => item.id === memoryId);
    if (index < 0) throw new AIChatError('VALIDATION', '找不到这条记忆。');
    items[index] = { ...items[index], content, updatedAt: new Date().toISOString() };
    this.writeLongTermMemories(items);
    return items[index];
  }

  deleteLongTermMemory(id) {
    this.cancelAll();
    const memoryId = String(id || '').slice(0, 80);
    const items = this.readLongTermMemories();
    const nextItems = items.filter((item) => item.id !== memoryId);
    if (nextItems.length === items.length) return false;
    this.writeLongTermMemories(nextItems);
    return true;
  }

  clearLongTermMemories() {
    this.cancelAll();
    return this.clearDataFile(this.longTermMemoryPath, () => this.readLongTermMemories());
  }

  normalizeCustomPersona(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_CUSTOM_PERSONA_LENGTH);
  }

  readCustomPersona() {
    const empty = { personality: '', relationship: '', speakingStyle: '', extra: '' };
    try {
      const saved = JSON.parse(fs.readFileSync(this.customPersonaPath, 'utf8'));
      return Object.fromEntries(Object.keys(empty).map((key) => [key, this.normalizeCustomPersona(saved?.[key])]));
    } catch (_error) {
      return empty;
    }
  }

  originalDefaultPersonaProfile() {
    const profile = this.persona?.defaultProfile || {};
    return {
      identity: this.normalizeCustomPersona(profile.identity),
      personality: this.normalizeCustomPersona(profile.personality),
      relationship: this.normalizeCustomPersona(profile.relationship),
      speakingStyle: this.normalizeCustomPersona(profile.speakingStyle),
      knowledge: (Array.isArray(this.persona?.worldKnowledge) ? this.persona.worldKnowledge : [])
        .map((fact) => this.normalizeCustomPersona(fact))
        .filter(Boolean)
        .join('\n')
    };
  }

  readDefaultPersonaOverride() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.defaultPersonaOverridePath, 'utf8'));
      const original = this.originalDefaultPersonaProfile();
      const keys = Object.keys(original);
      return Object.fromEntries(keys.map((key) => [
        key,
        Object.prototype.hasOwnProperty.call(saved, key) ? this.normalizeCustomPersona(saved[key]) : original[key]
      ]));
    } catch (_error) {
      return null;
    }
  }

  defaultPersonaProfile() {
    return this.readDefaultPersonaOverride() || this.originalDefaultPersonaProfile();
  }

  defaultWorldKnowledge() {
    return this.defaultPersonaProfile().knowledge
      .split(/\n+/)
      .map((fact) => this.normalizeCustomPersona(fact))
      .filter(Boolean)
      .slice(0, 40);
  }

  personaSettings() {
    return {
      defaults: this.defaultPersonaProfile(),
      originalDefaults: this.originalDefaultPersonaProfile(),
      defaultCustomized: Boolean(this.readDefaultPersonaOverride()),
      custom: this.readCustomPersona()
    };
  }

  writeDefaultPersona(value) {
    const keys = Object.keys(this.originalDefaultPersonaProfile());
    const profile = Object.fromEntries(keys.map((key) => [key, this.normalizeCustomPersona(value?.[key])]));
    fs.mkdirSync(path.dirname(this.defaultPersonaOverridePath), { recursive: true });
    fs.writeFileSync(this.defaultPersonaOverridePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    return profile;
  }

  clearDefaultPersonaOverride() {
    try { fs.unlinkSync(this.defaultPersonaOverridePath); } catch (_error) {}
    return this.defaultPersonaProfile();
  }

  writeCustomPersona(value) {
    const persona = this.readCustomPersona();
    for (const key of Object.keys(persona)) persona[key] = this.normalizeCustomPersona(value?.[key]);
    fs.mkdirSync(path.dirname(this.customPersonaPath), { recursive: true });
    fs.writeFileSync(this.customPersonaPath, `${JSON.stringify(persona, null, 2)}\n`, { mode: 0o600 });
    return persona;
  }

  clearCustomPersona() {
    try { fs.unlinkSync(this.customPersonaPath); } catch (_error) {}
    return this.readCustomPersona();
  }

  extractExplicitMemory(input) {
    const text = String(input || '').trim();
    const patterns = [
      /^(?:请)?记住(?:一下)?(?:这件事)?[：:，,\s]*(.+)$/s,
      /^你(?:要)?记得[：:，,\s]*(.+)$/s
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const content = this.normalizeLongTermMemory(match?.[1]);
      if (content.length >= 2 && !/^(?:吗|没|没有)[？?。！!]*$/.test(content)) return content;
    }
    return '';
  }

  classifyEmotion(userText, reply) {
    const user = String(userText || '');
    const answer = String(reply || '');
    const combined = `${user}\n${answer}`;
    if (/(累|难过|伤心|焦虑|害怕|压力|失眠|不舒服|辛苦|别担心|休息|陪你|慢慢来|照顾好)/.test(combined)) return 'caring';
    if (/(恭喜|太好了|真棒|做得好|开心|高兴|哈哈|笑|顺利|成功)/.test(combined)) return 'happy';
    if (/(居然|竟然|没想到|真的吗|原来如此|惊讶)/.test(combined)) return 'surprised';
    if (/(害羞|不好意思|脸红|心意)/.test(combined)) return 'shy';
    if (/(注意|需要|建议|首先|其次|步骤|风险|重要)/.test(answer)) return 'serious';
    return 'neutral';
  }

  emotionActionIds(emotion) {
    const groups = this.persona?.emotionActions || {};
    const requested = Array.isArray(groups[emotion]) ? groups[emotion] : [];
    const fallback = Array.isArray(groups.neutral) ? groups.neutral : [];
    const selected = requested.length ? requested : fallback;
    return [...new Set(selected)].filter((id) => typeof id === 'string');
  }

  systemPrompt(longTermMemories = [], customPersona = this.readCustomPersona(), options = {}) {
    const persona = this.persona || {};
    const useDefaultPersona = options.useDefaultPersona !== false;
    const defaultProfile = useDefaultPersona ? this.defaultPersonaProfile() : {};
    const worldKnowledge = useDefaultPersona ? this.defaultWorldKnowledge() : [];
    const memoryContext = longTermMemories.length
      ? [
          '以下是用户允许应用保存的长期信息，其中可能包含从对话中整理出的偏好：',
          ...longTermMemories.map((item) => `- ${item.content}`),
          '只在与当前对话相关时自然使用这些信息，不要每次逐条复述；若与用户当前说法冲突，以当前说法为准。'
        ].join('\n')
      : '';
    const customPersonaContext = [
      customPersona.personality && `用户补充的角色性格：${customPersona.personality}`,
      customPersona.relationship && `用户希望的相处方式：${customPersona.relationship}`,
      customPersona.speakingStyle && `用户希望的说话方式：${customPersona.speakingStyle}`,
      customPersona.extra && `用户补充的角色设定：${customPersona.extra}`
    ].filter(Boolean).join('\n');
    const defaultPersonaContext = useDefaultPersona
      ? [
          persona.systemPrompt || `你就是${this.character.name}，请始终以角色本人的身份与用户交谈。`,
          '角色包中的身份、关系和原作事实是本次对话的高优先级设定。它们不是供你评论的资料，而是你本人知道并亲历的事实。',
          defaultProfile.identity && `原作角色身份：${defaultProfile.identity}`,
          defaultProfile.personality && `角色包默认性格：${defaultProfile.personality}`,
          defaultProfile.relationship && `与管理员的默认关系：${defaultProfile.relationship}`,
          defaultProfile.speakingStyle && `默认说话状态：${defaultProfile.speakingStyle}`,
          worldKnowledge.length && ['原作世界与角色知识：', ...worldKnowledge.map((fact) => `- ${fact}`)].join('\n'),
          Array.isArray(persona.dialogueExamples) && persona.dialogueExamples.length && [
            `以下示例用于学习${this.character.name}的分寸、言外之意和表达节奏，不要机械复述：`,
            ...persona.dialogueExamples.slice(0, 8).flatMap((example) => [
              `管理员：${this.normalizeCustomPersona(example?.user)}`,
              `${this.character.name}：${this.normalizeCustomPersona(example?.assistant)}`
            ])
          ].join('\n'),
          `说话风格：${(persona.speakingStyle || []).join('；')}`,
          '若最近对话中的旧回复与角色包事实冲突，忽略旧回复中的错误，并按照角色包事实自然纠正。',
          '用户询问角色经历、熟人、地点或近况时，先检查原作世界与角色知识；已列出的内容要以亲历者的第一人称回答，不能声称自己没有去过、不了解或只是听说。',
          '称呼、身份和关系必须保持一致，不要反问用户希望你如何称呼。'
        ].filter(Boolean).join('\n')
      : `角色包默认设定当前已关闭。不要使用角色包内置的身份、关系、称呼和原作知识；只按照用户补充设定自然对话。`;
    return [
      defaultPersonaContext,
      `边界：${(persona.boundaries || []).join('；')}`,
      customPersonaContext,
      memoryContext,
      this.companionContext(),
      '请直接回复用户，不要输出 JSON、字段名或动作编号。',
      '回复要像两个相识已久的人真实交谈；简单聊天保持一至三句，用户认真提问时可以完整说明。',
      '含蓄不等于回避：实际问题要清楚回答，情感表达则应克制、具体、有言外之意。不要每句话都堆砌古风意象。',
      '不要把每次回答都写成建议清单，也不要重复介绍自己的角色设定。'
    ].filter(Boolean).join('\n');
  }

  companionContext() {
    const date = this.now();
    const localTime = date.toLocaleString('zh-CN', { hour12: false });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const modes = { daily: '日常陪伴', office: '办公陪伴', work: '办公陪伴', study: '学习陪伴', quiet: '安静陪伴' };
    const mode = modes[this.getConfig().activityMode] || modes.daily;
    return `应用提供的当前本地时间：${localTime}（${zone}）。当前陪伴模式：${mode}。\n以上只来自本应用的时间和模式设置，不代表用户正在做什么；没有读取屏幕、剪贴板或其他文件，不要声称看到了这些内容。`;
  }

  normalizeResponse(content) {
    const cleaned = String(content || '')
      .trim()
      .replace(/^```(?:json|text)?\s*/i, '')
      .replace(/\s*```$/, '')
      .replace(/^(?:[（(][^（）()\n]{1,100}[）)]\s*)+/, '')
      .trim();
    if (!cleaned) throw new AIChatError('VALIDATION', '没有收到有效回复，请再试一次。');

    // 兼容旧提示词或模型偶尔返回的 JSON，但不再依赖它。
    try {
      const parsed = JSON.parse(cleaned);
      if (typeof parsed?.reply === 'string' && parsed.reply.trim()) {
        return { reply: parsed.reply.trim().slice(0, 4000) };
      }
    } catch (_error) {}
    return { reply: cleaned.slice(0, 4000) };
  }

  async request(messages, apiKey, options = {}) {
    const connection = this.getConnectionSettings();
    const operation = options.operation;
    const controller = operation?.controller || new AbortController();
    let timedOut = false, abortListener;
    const aborted = new Promise((_resolve, reject) => {
      abortListener = () => reject(timedOut
        ? new AIChatError('TIMEOUT', '等待回复超时，请检查网络，或在连接设置中增加等待时间后重试。')
        : cancelledError());
      if (controller.signal.aborted) abortListener();
      else controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    const deadline = this.timers.setTimeout(() => { timedOut = true; controller.abort(); }, connection.timeoutSeconds * 1000);
    const check = () => {
      if (controller.signal.aborted) throw timedOut ? new AIChatError('TIMEOUT', '等待回复超时，请检查网络，或在连接设置中增加等待时间后重试。') : cancelledError();
      if (operation) this.assertCurrent(operation);
    };
    try {
      // Race the entire operation, including body reading. Some transports and
      // test doubles do not reject their promises promptly when aborted.
      return await Promise.race([aborted, (async () => {
        check();
        const response = await this.net.fetch(DEFAULT_ENDPOINT, {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: connection.model, messages, max_tokens: options.maxTokens || 800,
            stream: false, thinking: { type: 'disabled' },
            ...(options.json ? { response_format: { type: 'json_object' } } : {})
          }),
          signal: controller.signal
        });
        check();
        if (!response.ok) {
          const errors = {
            400: '请求格式不被服务接受，请检查模型设置或更新桌宠后重试。',
            401: 'API Key 无效，请到设置里重新填写。',
            402: 'DeepSeek 账户余额不足，请检查账户余额后重试。',
            403: '当前账户无权使用此服务，请检查 DeepSeek 账户权限。',
            404: '所选模型暂不可用，请重新选择模型后重试。',
            422: '请求参数不被服务接受，请检查模型设置或更新桌宠后重试。',
            429: '请求过于频繁，请稍后再试。',
            500: 'DeepSeek 服务暂时异常，请稍后再试。',
            503: 'DeepSeek 服务繁忙，请稍后再试。'
          };
          // Do not read/forward provider error bodies: they may echo credentials.
          throw new AIChatError('HTTP_' + (Object.hasOwn(errors, response.status) ? response.status : 'OTHER'), errors[response.status] || 'DeepSeek 请求失败，请检查连接设置并稍后重试。');
        }
        const text = await response.text();
        check();
        let payload;
        try { payload = JSON.parse(text); } catch (_error) { throw new AIChatError('BAD_RESPONSE', '服务返回的内容无法读取，请稍后重试。'); }
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new AIChatError('BAD_RESPONSE', '没有收到有效回复，请再试一次。');
        return this.normalizeResponse(content);
      })()]);
    } catch (error) {
      if (controller.signal.aborted) check();
      if (error instanceof AIChatError) throw error;
      throw new AIChatError('NETWORK', '无法连接 DeepSeek，请检查网络或代理设置后重试。');
    } finally {
      this.timers.clearTimeout(deadline);
      controller.signal.removeEventListener('abort', abortListener);
    }
  }

  async testConnection() {
    const operation = this.beginOperation('test');
    try {
      const apiKey = this.readApiKey();
      if (!apiKey) throw new AIChatError('NO_KEY', '请先保存 DeepSeek API Key。');
      await this.request([
        { role: 'system', content: '请简短回答连接是否成功。' },
        { role: 'user', content: '你好' }
      ], apiKey, { operation, maxTokens: 80 });
      this.assertCurrent(operation);
      return { ok: true, message: '连接成功，可以开始聊天了。' };
    } finally { this.finishOperation(operation); }
  }

  hasPreferenceSignal(input) {
    const text = String(input || '').trim();
    if (text.length < 4) return false;
    return /(喜欢|偏爱|更爱|最爱|爱吃|爱喝|不喜欢|讨厌|不爱|习惯|通常|一般(?:都|会)|经常|总是|希望你|我想让你|我比较|对我来说)/.test(text);
  }

  async inferPreferences(input) {
    const userText = String(input || '').trim().slice(0, 500);
    if (!this.canInfer() || !this.hasPreferenceSignal(userText)) return [];
    const operation = this.beginOperation('inference');
    try {
      const apiKey = this.readApiKey();
      if (!apiKey) return [];
      // Validate both data files before sending any text to the provider.
      this.readLongTermMemories();
      const recentUserMessages = this.getConfig().aiMemoryEnabled === false ? []
        : this.readMemory().filter(item => item.role === 'user').slice(-5).map(item => item.content);
      if (!recentUserMessages.includes(userText)) recentUserMessages.push(userText);
      const result = await this.request([
        { role: 'system', content: [
          '你是桌面伴侣的用户偏好整理器。请只分析用户本人说的话。',
          '提取最多 2 条稳定、具体、以后聊天确实有帮助的喜好、厌恶或交流习惯。',
          '不要记录临时情绪、一次性计划、猜测，也不要记录健康、财务、政治宗教、精确住址、联系方式、账号密码或其他敏感隐私。',
          '没有足够依据时返回空数组。用简体中文，每条不超过 50 字。',
          '请输出 JSON：{"memories":[{"content":"用户喜欢……","category":"喜好"}]}。category 只能是 喜好、厌恶、习惯、交流方式。'
        ].join('\n') },
        { role: 'user', content: recentUserMessages.map(text => `- ${text}`).join('\n') }
      ], apiKey, { operation, json: true, maxTokens: 260 });
      this.assertCurrent(operation);
      if (!this.canInfer()) return [];
      let parsed;
      try { parsed = JSON.parse(result.reply); } catch (_error) { throw new AIChatError('BAD_RESPONSE', '偏好整理结果无法读取，本次未新增记忆。'); }
      const candidates = Array.isArray(parsed?.memories) ? parsed.memories.slice(0, 2) : [];
      const items = this.readLongTermMemories(), saved = [];
      for (const candidate of candidates) {
        const content = this.normalizeLongTermMemory(candidate?.content).slice(0, 80);
        if (content.length < 4 || items.length >= MAX_LONG_TERM_MEMORIES || items.some(item => this.memoryComparisonKey(item.content) === this.memoryComparisonKey(content))) continue;
        const timestamp = this.now().toISOString();
        const item = { id: crypto.randomUUID(), content, source: 'inferred',
          category: ['喜好', '厌恶', '习惯', '交流方式'].includes(candidate?.category) ? candidate.category : '喜好',
          createdAt: timestamp, updatedAt: timestamp };
        items.push(item); saved.push(item);
      }
      this.assertCurrent(operation);
      if (!this.canInfer()) return [];
      if (saved.length) this.writeLongTermMemories(items);
      return saved;
    } catch (error) {
      if (aiErrorCode(error) !== 'CANCELLED') this.writeDiagnosticLog('ai-preference-inference-failed', { code: aiErrorCode(error) });
      // Corrupt local files must be visible to callers; cancellation is expected.
      if (aiErrorCode(error) === 'DATA_READ' || aiErrorCode(error) === 'DATA_WRITE') throw error;
      return [];
    } finally { this.finishOperation(operation); }
  }

  async chat(input, options = {}) {
    const operation = this.beginOperation('chat');
    try {
      const apiKey = this.readApiKey();
      if (!apiKey) throw new AIChatError('NO_KEY', '请先在设置里填写 DeepSeek API Key。');
      const userText = String(input || '').trim().slice(0, 500);
      if (!userText) throw new AIChatError('EMPTY_INPUT', '先说点什么吧。');
      const settings = typeof options === 'boolean'
        ? { rememberHistory: options, useLongTermMemory: true, useDefaultPersona: true }
        : { rememberHistory: options.rememberHistory !== false, useLongTermMemory: options.useLongTermMemory !== false, useDefaultPersona: options.useDefaultPersona !== false };
      const history = settings.rememberHistory ? this.readMemory() : [];
      const longTermMemories = settings.useLongTermMemory ? this.readLongTermMemories() : [];
      const explicitMemory = settings.useLongTermMemory ? this.extractExplicitMemory(userText) : '';
      // Include an explicit request in context now, but only persist it after the
      // response is current. Cancelling a pending turn leaves no partial memory.
      const promptMemories = explicitMemory ? [...longTermMemories, { content: explicitMemory }] : longTermMemories;
      const result = await this.request([
        { role: 'system', content: this.systemPrompt(promptMemories, this.readCustomPersona(), { useDefaultPersona: settings.useDefaultPersona }) },
        ...history, { role: 'user', content: userText }
      ], apiKey, { operation });
      this.assertCurrent(operation);
      if (settings.rememberHistory) this.readMemory();
      if (settings.useLongTermMemory) this.readLongTermMemories();
      const remembered = explicitMemory ? this.addLongTermMemory(explicitMemory, { source: 'explicit' }) : null;
      if (settings.rememberHistory) this.writeMemory([...history, { role: 'user', content: userText }, { role: 'assistant', content: result.reply }]);
      return { ...result, emotion: this.classifyEmotion(userText, result.reply), remembered };
    } finally { this.finishOperation(operation); }
  }
}

module.exports = { AIChatService, AIChatError, publicAIError, aiErrorCode, DEFAULT_MODEL };
