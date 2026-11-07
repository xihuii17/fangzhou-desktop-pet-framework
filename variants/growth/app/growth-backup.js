const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_BYTES = 1024 * 1024;
const FORMAT = 'desktop-pet-companion-save';

function validateState(state) {
  const fail = () => { throw new Error('存档内容不完整或已损坏，未修改当前数据。'); };
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const number = v => Number.isSafeInteger(v) && v >= 0 && v <= 2000000000;
  const string = v => typeof v === 'string' && v.length > 0 && v.length <= 500;
  const strings = v => Array.isArray(v) && v.length <= 10000 && v.every(string);
  if (!object(state) || state.schemaVersion !== 1) fail();
  for (const key of ['points', 'experience', 'totalCompanionSeconds']) if (!number(state[key])) fail();
  for (const key of ['unlockedActionIds', 'newActionIds', 'appliedShowcaseBoosts']) if (!strings(state[key])) fail();
  for (const key of ['freeBlindBoxCoupons', 'halfPriceBlindBoxCoupons']) if (!number(state[key])) fail();
  if (typeof state.starterBlindBoxAvailable !== 'boolean') fail();
  const today = state.today;
  if (!object(today) || typeof today.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today.day)) fail();
  for (const key of ['activeSeconds', 'giftActiveSeconds', 'timePointsGranted', 'experienceGranted', 'blindBoxesBought', 'smallGiftProgressSeconds', 'smallGiftsCollected', 'randomGiftsSpawned', 'randomActionGiftsSpawned', 'nextRandomGiftAtSeconds']) if (!number(today[key])) fail();
  if (today.nextRandomGiftAtSeconds <= today.giftActiveSeconds || today.activeSeconds > 28800 || today.smallGiftProgressSeconds > 1800 || typeof today.smallGiftReady !== 'boolean') fail();
  if (!Array.isArray(today.milestonesGranted) || !today.milestonesGranted.every(number)) fail();
  if (!Array.isArray(state.recentRewards) || state.recentRewards.length > 30 || !state.recentRewards.every(r => object(r) && string(r.text) && string(r.at))) fail();
  if (!Array.isArray(state.giftInbox) || state.giftInbox.length > 10000) fail();
  const ids = new Set();
  for (const gift of state.giftInbox) {
    if (!object(gift) || !string(gift.id) || ids.has(gift.id) || !string(gift.createdAt) || !object(gift.reward)) fail();
    ids.add(gift.id);
    const r = gift.reward;
    if (!string(r.label) || !['points', 'action', 'free-blind-box', 'half-blind-box'].includes(r.type)) fail();
    if (r.type === 'points' && !number(r.points)) fail();
    if (r.type === 'action' && !string(r.actionId)) fail();
  }
  return state;
}

function encodeBackup(store) {
  validateState(store.state);
  const data = JSON.stringify({ format: FORMAT, version: 1, platform: 'desktop', characterId: store.character.id,
    characterName: store.character.name, exportedAt: new Date().toISOString(), state: store.state }, null, 2) + '\n';
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('存档过大，暂时无法导出。');
  return data;
}

function decodeBackup(text, characterId) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('文件超过 1 MB，无法导入。');
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''), (key, value) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('unsafe key');
      return value;
    });
  } catch { throw new Error('不是有效的陪伴存档文件。'); }
  if (data?.format !== FORMAT || data.version !== 1 || data.platform !== 'desktop') throw new Error('请选择桌面陪伴版导出的存档，暂不支持安卓存档。');
  if (data.characterId !== characterId) throw new Error('这份存档属于其他角色，不能覆盖当前角色。');
  validateState(data.state);
  return data;
}

function restoreBackup(store, backup) {
  // Revalidate immediately before changing any live state.
  const incoming = decodeBackup(JSON.stringify(backup), store.character.id).state;
  const before = store.state;
  const backupPath = path.join(path.dirname(store.filePath), 'backups', `before-import-${Date.now()}-${randomUUID()}.json`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, encodeBackup(store), { encoding: 'utf8', flag: 'wx' });
  try {
    store.state = incoming;
    store.ensureToday();
    store.ensureRequiredActions();
    store.save(false);
    store.lastTickAt = Date.now();
  } catch (error) {
    store.state = before;
    throw error;
  }
  return backupPath;
}

module.exports = { MAX_BYTES, validateState, encodeBackup, decodeBackup, restoreBackup };
