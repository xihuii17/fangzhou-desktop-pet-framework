const fs = require('fs');
const path = require('path');
const { validateState } = require('./growth-backup');

const SCHEMA_VERSION = 1;
const STARTING_POINTS = 2000;
const DIRECT_ACTION_PRICE = 200;
const BLIND_BOX_PRICE = 100;
const DAILY_BLIND_BOX_LIMIT = 2;
const DAILY_ACTIVE_LIMIT_SECONDS = 8 * 60 * 60;
const SMALL_GIFT_INTERVAL_SECONDS = 30 * 60;
const SMALL_GIFT_POINTS = 30;
const DAILY_RANDOM_ACTION_GIFT_LIMIT = 3;
const RANDOM_GIFT_ACTION_CHANCE = 0.20;
const FIRST_RANDOM_GIFT_MIN_SECONDS = 20 * 60;
const FIRST_RANDOM_GIFT_RANGE_SECONDS = 40 * 60;
const NEXT_RANDOM_GIFT_MIN_SECONDS = 30 * 60;
const NEXT_RANDOM_GIFT_RANGE_SECONDS = 60 * 60;
const FULL_RATE_SECONDS = 4 * 60 * 60;
const MILESTONES = [
  { seconds: 30 * 60, points: 20 },
  { seconds: 60 * 60, points: 30 },
  { seconds: 2 * 60 * 60, points: 50 },
  { seconds: 4 * 60 * 60, points: 50 },
  { seconds: 6 * 60 * 60, points: 30 },
  { seconds: 8 * 60 * 60, points: 20 }
];

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clampInteger(value, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : minimum;
}

function timePointsForSeconds(seconds) {
  const safeSeconds = Math.min(DAILY_ACTIVE_LIMIT_SECONDS, clampInteger(seconds));
  const fullRatePoints = Math.floor(Math.min(safeSeconds, FULL_RATE_SECONDS) / 60);
  const reducedSeconds = Math.max(0, safeSeconds - FULL_RATE_SECONDS);
  return fullRatePoints + Math.floor(reducedSeconds / 120);
}

function levelDetails(totalExperience) {
  const experience = clampInteger(totalExperience);
  let level = 1;
  let spent = 0;
  let required = 60;
  while (experience - spent >= required && level < 999) {
    spent += required;
    level += 1;
    required = 60 + 30 * (level - 1);
  }
  return {
    level,
    currentExperience: experience - spent,
    nextLevelExperience: required,
    totalExperience: experience
  };
}

function actionAppearanceId(action, fallback) {
  return action.appearanceId || fallback;
}

function actionBehaviorId(action) {
  return action.behaviorId || action.id;
}

const ModeIdle = require('./mode-idle');
function starterIdsForActions(actions, character) {
  const appearances = Array.isArray(character.appearances) && character.appearances.length
    ? character.appearances.map((item) => item.id).filter(Boolean)
    : [character.defaultAppearance || 'default'];
  const fallbackAppearance = character.defaultAppearance || appearances[0] || 'default';
  const result = new Set();
  const quickActionIds = new Set((character.quickActions || []).map((item) => item.actionId).filter(Boolean));

  for (const appearanceId of appearances) {
    const candidates = actions.filter((action) => actionAppearanceId(action, fallbackAppearance) === appearanceId);
    const targetCount = appearances.length > 1 ? 12 : 18;
    const ordered = [
      ...Object.values(ModeIdle.defaults(candidates)).map(id => candidates.find(action => action.id === id)).filter(Boolean),
      ...candidates.filter((action) => action.id === character.defaultAction || actionBehaviorId(action) === character.defaultAction),
      ...candidates.filter((action) => action.id === character.greetingAction || actionBehaviorId(action) === character.greetingAction),
      ...candidates.filter((action) => quickActionIds.has(action.id) || quickActionIds.has(actionBehaviorId(action))),
      ...candidates.filter((action) => action.dragging),
      ...candidates.filter((action) => action.dropReaction),
      ...candidates.filter((action) => action.interaction),
      ...candidates.filter((action) => action.auto && Array.isArray(action.modes) && action.modes.length),
      ...candidates
    ];
    for (const action of ordered) {
      result.add(action.id);
      const countForAppearance = [...result].filter((id) => {
        const item = actions.find((candidate) => candidate.id === id);
        return item && actionAppearanceId(item, fallbackAppearance) === appearanceId;
      }).length;
      if (countForAppearance >= targetCount) break;
    }
  }
  for (const id of character.freeActionIds || []) {
    if (actions.some(action => action.id === id)) result.add(id);
  }
  return [...result];
}

function randomGiftDelay(random, first = false) {
  const minimum = first ? FIRST_RANDOM_GIFT_MIN_SECONDS : NEXT_RANDOM_GIFT_MIN_SECONDS;
  const range = first ? FIRST_RANDOM_GIFT_RANGE_SECONDS : NEXT_RANDOM_GIFT_RANGE_SECONDS;
  return minimum + Math.floor(random() * (range + 1));
}

function emptyToday(day, random = Math.random) {
  return {
    day,
    activeSeconds: 0,
    timePointsGranted: 0,
    experienceGranted: 0,
    milestonesGranted: [],
    blindBoxesBought: 0,
    giftActiveSeconds: 0,
    smallGiftProgressSeconds: 0,
    smallGiftReady: false,
    smallGiftsCollected: 0,
    randomGiftsSpawned: 0,
    randomActionGiftsSpawned: 0,
    nextRandomGiftAtSeconds: randomGiftDelay(random, true)
  };
}

function defaultState(actions, character, random = Math.random, now = new Date()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    points: Number.isSafeInteger(character.startingPoints) && character.startingPoints >= 0
      ? character.startingPoints : STARTING_POINTS,
    experience: 0,
    totalCompanionSeconds: 0,
    unlockedActionIds: starterIdsForActions(actions, character),
    newActionIds: [],
    starterBlindBoxAvailable: true,
    freeBlindBoxCoupons: 0,
    halfPriceBlindBoxCoupons: 0,
    giftInbox: [],
    recentRewards: [],
    appliedShowcaseBoosts: [],
    today: emptyToday(localDayKey(now), random),
    updatedAt: now.toISOString()
  };
}

class GrowthStore {
  constructor({ filePath, actions, character, random = Math.random, now = () => new Date(), onChange = null }) {
    this.filePath = filePath;
    this.actions = Array.isArray(actions) ? actions : [];
    this.character = character || {};
    this.random = random;
    this.now = now;
    this.onChange = onChange;
    this.active = true;
    this.lastTickAt = Date.now();
    this.state = this.read();
    this.persistedState = structuredClone(this.state);
    this.lastBackupAt = 0;
    this.ensureToday();
    this.ensureRequiredActions();
    this.applyShowcaseBoost();
    this.save(false);
  }

  backupPath(index) {
    return `${this.filePath}.backup-${index}.json`;
  }

  read() {
    let originalError;
    try {
      return this.normalize(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      originalError = error;
      // A newer schema must never be replaced by an older backup.
      if (error.code === 'NEWER_SCHEMA') throw error;
    }
    for (let index = 1; index <= 3; index += 1) {
      try {
        const recovered = this.normalize(JSON.parse(fs.readFileSync(this.backupPath(index), 'utf8')));
        if (fs.existsSync(this.filePath)) {
          // Preserve the damaged original before any repair writes.
          fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${require('node:crypto').randomUUID()}.json`);
        }
        this.recoveryNotice = '陪伴存档读取异常，已从最近的有效自动备份恢复；原文件已保留。';
        return recovered;
      } catch (error) {
        if (error.code && !['ENOENT', 'NEWER_SCHEMA'].includes(error.code)) {
          throw new Error(`无法安全恢复陪伴存档，原文件未覆盖：${error.message}`);
        }
      }
    }
    if (originalError.code === 'ENOENT' && ![1, 2, 3].some(i => fs.existsSync(this.backupPath(i)))) {
      return defaultState(this.actions, this.character, this.random, this.now());
    }
    throw new Error(`陪伴存档无法读取，已停止写入以保护进度。请保留应用数据目录并恢复备份。路径：${this.filePath}`);
  }

  normalize(stored) {
      if (Number.isInteger(stored?.schemaVersion) && stored.schemaVersion > SCHEMA_VERSION) {
        const error = new Error('此陪伴存档需要更新版本的软件，原存档未修改。');
        error.code = 'NEWER_SCHEMA';
        throw error;
      }
      if (stored?.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(stored.points) || stored.points < 0 ||
          !Number.isSafeInteger(stored.experience) || stored.experience < 0 ||
          !Array.isArray(stored.unlockedActionIds) || !stored.today) {
        throw new Error('invalid save');
      }
      const base = defaultState(this.actions, this.character, this.random, this.now());
      const storedToday = stored.today || {};
      const giftActiveSeconds = clampInteger(storedToday.giftActiveSeconds ?? storedToday.activeSeconds);
      const normalized = {
        ...base,
        ...stored,
        points: clampInteger(stored.points),
        experience: clampInteger(stored.experience),
        // Older saves did not have a lifetime counter. Preserve at least the
        // actual companionship already recorded for the current day.
        totalCompanionSeconds: clampInteger(stored.totalCompanionSeconds ?? giftActiveSeconds),
        unlockedActionIds: [...new Set(Array.isArray(stored.unlockedActionIds) ? stored.unlockedActionIds : base.unlockedActionIds)],
        newActionIds: [...new Set(Array.isArray(stored.newActionIds) ? stored.newActionIds : [])],
        giftInbox: Array.isArray(stored.giftInbox) ? stored.giftInbox : [],
        recentRewards: Array.isArray(stored.recentRewards) ? stored.recentRewards.slice(0, 30) : [],
        appliedShowcaseBoosts: Array.isArray(stored.appliedShowcaseBoosts) ? stored.appliedShowcaseBoosts : [],
        today: {
          ...base.today,
          ...storedToday,
          giftActiveSeconds,
          smallGiftProgressSeconds: clampInteger(
            storedToday.smallGiftProgressSeconds ?? (giftActiveSeconds % SMALL_GIFT_INTERVAL_SECONDS)
          ),
          smallGiftReady: Boolean(storedToday.smallGiftReady),
          smallGiftsCollected: clampInteger(storedToday.smallGiftsCollected ?? storedToday.smallGiftsGranted),
          randomGiftsSpawned: clampInteger(storedToday.randomGiftsSpawned ?? storedToday.giftsSpawned),
          randomActionGiftsSpawned: clampInteger(storedToday.randomActionGiftsSpawned),
          nextRandomGiftAtSeconds: storedToday.nextRandomGiftAtSeconds == null
            ? giftActiveSeconds + randomGiftDelay(this.random, true)
            : clampInteger(storedToday.nextRandomGiftAtSeconds)
        }
      };
      // Old saves can carry an overdue random-gift deadline; do not replay a backlog.
      if (normalized.today.nextRandomGiftAtSeconds <= giftActiveSeconds) {
        normalized.today.nextRandomGiftAtSeconds = giftActiveSeconds + randomGiftDelay(this.random);
      }
      validateState(normalized);
      return normalized;
  }

  save(notify = true) {
    const previous = this.persistedState;
    try {
      this.state.updatedAt = this.now().toISOString();
      validateState(this.state);
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const now = Date.now();
      if (previous && (!this.lastBackupAt || now - this.lastBackupAt >= 5 * 60 * 1000)) {
        // Three rolling snapshots, at most once per five minutes; never back up corrupt input.
        for (let index = 3; index > 1; index -= 1) {
          if (fs.existsSync(this.backupPath(index - 1))) {
            fs.copyFileSync(this.backupPath(index - 1), this.backupPath(index));
          }
        }
        const backupTemp = `${this.backupPath(1)}.tmp`;
        fs.writeFileSync(backupTemp, JSON.stringify(previous, null, 2) + '\n', 'utf8');
        fs.renameSync(backupTemp, this.backupPath(1));
        this.lastBackupAt = now;
      }
      const temporaryPath = `${this.filePath}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
      this.persistedState = structuredClone(this.state);
    } catch (error) {
      if (previous) this.state = structuredClone(previous);
      throw new Error(`陪伴进度保存失败，本次变更已撤回：${error.message}`);
    }
    if (notify && typeof this.onChange === 'function') this.onChange(this.status());
  }

  ensureToday() {
    const day = localDayKey(this.now());
    if (this.state.today?.day === day) return false;
    const previous = this.state.today || {};
    this.state.today = {
      ...emptyToday(day, this.random),
      smallGiftProgressSeconds: clampInteger(previous.smallGiftProgressSeconds),
      smallGiftReady: Boolean(previous.smallGiftReady)
    };
    return true;
  }

  ensureRequiredActions() {
    const unlocked = new Set(this.state.unlockedActionIds);
    for (const id of starterIdsForActions(this.actions, this.character)) unlocked.add(id);
    this.state.unlockedActionIds = [...unlocked];
  }

  applyShowcaseBoost() {
    const boost = this.character.showcaseBoost;
    if (!boost?.id || this.state.appliedShowcaseBoosts.includes(boost.id)) return false;
    this.state.points = Math.max(this.state.points, clampInteger(boost.minimumPoints));
    this.state.experience = Math.max(this.state.experience, clampInteger(boost.minimumExperience));
    this.state.appliedShowcaseBoosts.push(boost.id);
    this.recordReward(boost.label || '录制体验补助');
    return true;
  }

  setActive(active) {
    const next = Boolean(active);
    if (next === this.active) return;
    try {
      if (this.active) this.tick();
    } finally {
      this.active = next;
      this.lastTickAt = Date.now();
    }
  }

  tick(elapsedSeconds = null) {
    const nowMs = Date.now();
    const measured = elapsedSeconds == null ? (nowMs - this.lastTickAt) / 1000 : Number(elapsedSeconds);
    this.lastTickAt = nowMs;
    const dayChanged = this.ensureToday();
    if (!this.active || !Number.isFinite(measured) || measured <= 0) {
      if (dayChanged) this.save();
      return this.status();
    }

    // Large gaps usually mean sleep, lock screen, or a stalled renderer. Never credit them.
    const creditedSeconds = Math.min(90, Math.floor(measured));
    if (creditedSeconds <= 0) return this.status();
    this.state.totalCompanionSeconds += creditedSeconds;
    this.state.today.giftActiveSeconds += creditedSeconds;
    this.advanceSmallGift(creditedSeconds);
    this.spawnDueRandomGifts();

    const activeCredit = Math.min(
      creditedSeconds,
      Math.max(0, DAILY_ACTIVE_LIMIT_SECONDS - this.state.today.activeSeconds)
    );
    this.state.today.activeSeconds += activeCredit;

    const earnedTimePoints = timePointsForSeconds(this.state.today.activeSeconds);
    const pointDelta = Math.max(0, earnedTimePoints - clampInteger(this.state.today.timePointsGranted));
    if (pointDelta) {
      this.state.points += pointDelta;
      this.state.today.timePointsGranted = earnedTimePoints;
    }

    const earnedExperience = Math.floor(this.state.today.activeSeconds / 60);
    const experienceDelta = Math.max(0, earnedExperience - clampInteger(this.state.today.experienceGranted));
    if (experienceDelta) {
      this.state.experience += experienceDelta;
      this.state.today.experienceGranted = earnedExperience;
    }

    const granted = new Set(this.state.today.milestonesGranted || []);
    for (const milestone of MILESTONES) {
      if (this.state.today.activeSeconds < milestone.seconds || granted.has(milestone.seconds)) continue;
      granted.add(milestone.seconds);
      this.state.points += milestone.points;
      this.recordReward(`陪伴时长奖励 +${milestone.points}心意积分`);
    }
    this.state.today.milestonesGranted = [...granted];
    this.save();
    return this.status();
  }

  advanceSmallGift(seconds) {
    if (this.state.today.smallGiftReady) return false;
    this.state.today.smallGiftProgressSeconds = Math.min(
      SMALL_GIFT_INTERVAL_SECONDS,
      clampInteger(this.state.today.smallGiftProgressSeconds) + clampInteger(seconds)
    );
    if (this.state.today.smallGiftProgressSeconds < SMALL_GIFT_INTERVAL_SECONDS) return false;
    this.state.today.smallGiftReady = true;
    return true;
  }

  collectSmallGift() {
    // Settle the previous interval while the old gift is still ready.
    this.tick();
    if (!this.state.today.smallGiftReady) return { ok: false, message: '小礼物还在准备中。' };
    this.state.today.smallGiftReady = false;
    this.state.today.smallGiftProgressSeconds = 0;
    this.state.today.smallGiftsCollected += 1;
    this.state.points += SMALL_GIFT_POINTS;
    this.recordReward(`陪伴小礼物 +${SMALL_GIFT_POINTS}心意积分`);
    this.save();
    return {
      ok: true,
      reward: { type: 'points', points: SMALL_GIFT_POINTS, label: `${SMALL_GIFT_POINTS}心意积分` },
      status: this.status()
    };
  }

  reservedGiftActionIds() {
    return new Set(this.state.giftInbox
      .filter((gift) => gift?.reward?.type === 'action' && gift.reward.actionId)
      .map((gift) => gift.reward.actionId));
  }

  rollRandomGiftReward(actionPool = this.actions) {
    const reserved = this.reservedGiftActionIds();
    const availableActionIds = this.lockedActionIds(actionPool).filter((id) => !reserved.has(id));
    const canContainAction = (
      this.state.today.randomActionGiftsSpawned < DAILY_RANDOM_ACTION_GIFT_LIMIT &&
      availableActionIds.length > 0
    );
    if (canContainAction && this.random() < RANDOM_GIFT_ACTION_CHANCE) {
      const actionId = availableActionIds[Math.floor(this.random() * availableActionIds.length)];
      this.state.today.randomActionGiftsSpawned += 1;
      return { type: 'action', actionId, label: '随机未解锁动作' };
    }
    const points = 20 + Math.floor(this.random() * 11);
    return { type: 'points', points, label: `${points}心意积分` };
  }

  spawnDueRandomGifts() {
    let spawned = 0;
    while (this.state.today.giftActiveSeconds >= this.state.today.nextRandomGiftAtSeconds) {
      const reward = this.rollRandomGiftReward();
      this.state.giftInbox.push({
        id: `gift-${Date.now()}-${this.state.today.randomGiftsSpawned}`,
        createdAt: this.now().toISOString(),
        reward
      });
      this.state.today.randomGiftsSpawned += 1;
      this.state.today.nextRandomGiftAtSeconds += randomGiftDelay(this.random, false);
      spawned += 1;
    }
    return spawned;
  }

  openGift(id, actionPool = this.actions) {
    this.ensureToday();
    const index = this.state.giftInbox.findIndex((gift) => gift.id === id);
    if (index < 0) return { ok: false, message: '找不到这个礼物。' };
    const [gift] = this.state.giftInbox.splice(index, 1);
    const result = this.grantGiftReward(gift, actionPool);
    this.save();
    return { ok: true, ...result, status: this.status() };
  }

  openAllGifts(actionPool = this.actions) {
    this.ensureToday();
    if (!this.state.giftInbox.length) return { ok: false, message: '暂时没有待打开的礼物。' };
    const before = structuredClone(this.state);
    let opened;
    try {
      const gifts = this.state.giftInbox;
      this.state.giftInbox = [];
      opened = gifts.map((gift) => this.grantGiftReward(gift, actionPool));
    } catch (error) {
      this.state = before;
      throw error;
    }
    // Persist the entire batch once; save() restores persisted state on failure.
    // IPC handlers are synchronous, so a repeated request sees an empty inbox.
    this.save();
    return {
      ok: true,
      openedCount: opened.length,
      rewards: opened.map((item) => item.reward),
      actionIds: opened.map((item) => item.actionId).filter(Boolean),
      status: this.status()
    };
  }

  grantGiftReward(gift, actionPool) {
    let reward = gift.reward;
    let actionId = null;
    if (reward.type === 'action') {
      const lockedIds = this.lockedActionIds(actionPool);
      if (lockedIds.length) {
        actionId = lockedIds.includes(reward.actionId)
          ? reward.actionId
          : lockedIds[Math.floor(this.random() * lockedIds.length)];
        this.unlockAction(actionId, '天降礼物');
        const action = this.actions.find((item) => item.id === actionId);
        reward = { type: 'action', actionId, label: action?.label || actionId };
      } else {
        reward = { type: 'points', points: 25, label: '25心意积分' };
        this.state.points += reward.points;
        this.recordReward(`礼物：${reward.label}`);
      }
    } else {
      if (reward.type === 'points') this.state.points += clampInteger(reward.points);
      if (reward.type === 'free-blind-box') this.state.freeBlindBoxCoupons += 1;
      if (reward.type === 'half-blind-box') this.state.halfPriceBlindBoxCoupons += 1;
      this.recordReward(`礼物：${reward.label}`);
    }
    return { reward, actionId };
  }

  isUnlocked(id, customAdded = false) {
    return Boolean(customAdded || this.state.unlockedActionIds.includes(id));
  }

  isNewAction(id) {
    return this.state.newActionIds.includes(id);
  }

  markActionSeen(id) {
    const nextIds = this.state.newActionIds.filter((actionId) => actionId !== id);
    if (nextIds.length === this.state.newActionIds.length) return { ok: true, changed: false };
    this.state.newActionIds = nextIds;
    this.save();
    return { ok: true, changed: true };
  }

  lockedActionIds(actionPool = this.actions) {
    const unlocked = new Set(this.state.unlockedActionIds);
    return actionPool.filter((action) => !unlocked.has(action.id)).map((action) => action.id);
  }

  unlockAction(id, source) {
    if (!this.actions.some((action) => action.id === id)) return false;
    if (this.state.unlockedActionIds.includes(id)) return false;
    this.state.unlockedActionIds.push(id);
    if (!this.state.newActionIds.includes(id)) this.state.newActionIds.push(id);
    const action = this.actions.find((item) => item.id === id);
    this.recordReward(`${source}：${action?.label || id}`);
    return true;
  }

  buyAction(id) {
    this.ensureToday();
    if (this.isUnlocked(id)) return { ok: false, message: '这个动作已经解锁。' };
    if (!this.actions.some((action) => action.id === id)) return { ok: false, message: '找不到这个动作。' };
    if (this.state.points < DIRECT_ACTION_PRICE) return { ok: false, message: '心意积分不足。' };
    this.state.points -= DIRECT_ACTION_PRICE;
    this.unlockAction(id, '指定兑换');
    this.save();
    return { ok: true, actionId: id, status: this.status() };
  }

  currentBlindBoxCost() {
    if (this.state.starterBlindBoxAvailable || this.state.freeBlindBoxCoupons > 0) return 0;
    if (this.state.halfPriceBlindBoxCoupons > 0) return Math.floor(BLIND_BOX_PRICE / 2);
    return BLIND_BOX_PRICE;
  }

  blindBoxesRemaining() {
    const recordingValue = Number(this.state.today.recordingBlindBoxesRemaining);
    if (Number.isFinite(recordingValue)) return clampInteger(recordingValue);
    return Math.max(0, DAILY_BLIND_BOX_LIMIT - this.state.today.blindBoxesBought);
  }

  buyBlindBox(actionPool = this.actions) {
    this.ensureToday();
    const lockedIds = this.lockedActionIds(actionPool);
    if (!lockedIds.length) return { ok: false, message: '所有动作都已经收集完成。' };
    const starter = Boolean(this.state.starterBlindBoxAvailable);
    if (!starter && this.blindBoxesRemaining() <= 0) {
      return { ok: false, message: '今天的动作盲盒次数已经用完。' };
    }
    const cost = this.currentBlindBoxCost();
    if (this.state.points < cost) return { ok: false, message: '心意积分不足。' };
    this.state.points -= cost;
    if (starter) this.state.starterBlindBoxAvailable = false;
    else {
      if (Number.isFinite(Number(this.state.today.recordingBlindBoxesRemaining))) {
        this.state.today.recordingBlindBoxesRemaining = Math.max(
          0,
          clampInteger(this.state.today.recordingBlindBoxesRemaining) - 1
        );
      } else {
        this.state.today.blindBoxesBought += 1;
      }
      if (this.state.freeBlindBoxCoupons > 0) this.state.freeBlindBoxCoupons -= 1;
      else if (this.state.halfPriceBlindBoxCoupons > 0) this.state.halfPriceBlindBoxCoupons -= 1;
    }
    const actionId = lockedIds[Math.floor(this.random() * lockedIds.length)];
    this.unlockAction(actionId, '动作盲盒');
    this.save();
    return { ok: true, actionId, cost, status: this.status() };
  }

  recordReward(text) {
    this.state.recentRewards.unshift({ text, at: this.now().toISOString() });
    this.state.recentRewards = this.state.recentRewards.slice(0, 30);
  }

  status() {
    this.ensureToday();
    const level = levelDetails(this.state.experience);
    return {
      schemaVersion: SCHEMA_VERSION,
      points: this.state.points,
      ...level,
      unlockedCount: this.state.unlockedActionIds.length,
      totalActionCount: this.actions.length,
      unlockedActionIds: [...this.state.unlockedActionIds],
      newActionIds: [...this.state.newActionIds],
      starterBlindBoxAvailable: this.state.starterBlindBoxAvailable,
      blindBoxCost: this.currentBlindBoxCost(),
      blindBoxesRemaining: this.blindBoxesRemaining(),
      freeBlindBoxCoupons: this.state.freeBlindBoxCoupons,
      halfPriceBlindBoxCoupons: this.state.halfPriceBlindBoxCoupons,
      giftInbox: this.state.giftInbox.map((gift) => ({ id: gift.id, createdAt: gift.createdAt })),
      giftInboxCount: this.state.giftInbox.length,
      recentRewards: [...this.state.recentRewards],
      totalCompanionSeconds: this.state.totalCompanionSeconds,
      today: {
        day: this.state.today.day,
        activeSeconds: this.state.today.activeSeconds,
        companionSeconds: this.state.today.giftActiveSeconds,
        giftActiveSeconds: this.state.today.giftActiveSeconds,
        smallGiftReady: this.state.today.smallGiftReady,
        smallGiftsCollected: this.state.today.smallGiftsCollected,
        smallGiftPoints: SMALL_GIFT_POINTS,
        nextSmallGiftInSeconds: this.state.today.smallGiftReady
          ? 0
          : Math.max(0, SMALL_GIFT_INTERVAL_SECONDS - this.state.today.smallGiftProgressSeconds),
        randomGiftsSpawned: this.state.today.randomGiftsSpawned,
        randomActionGiftsSpawned: this.state.today.randomActionGiftsSpawned,
        randomActionGiftLimit: DAILY_RANDOM_ACTION_GIFT_LIMIT
      },
      prices: {
        directAction: DIRECT_ACTION_PRICE,
        blindBox: BLIND_BOX_PRICE
      }
    };
  }
}

module.exports = {
  BLIND_BOX_PRICE,
  DAILY_ACTIVE_LIMIT_SECONDS,
  DAILY_BLIND_BOX_LIMIT,
  DAILY_RANDOM_ACTION_GIFT_LIMIT,
  DIRECT_ACTION_PRICE,
  RANDOM_GIFT_ACTION_CHANCE,
  SMALL_GIFT_INTERVAL_SECONDS,
  SMALL_GIFT_POINTS,
  GrowthStore,
  MILESTONES,
  levelDetails,
  localDayKey,
  starterIdsForActions,
  timePointsForSeconds
};
