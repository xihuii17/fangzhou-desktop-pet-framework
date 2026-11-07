const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { decryptQrc } = require('./vendor/qrc-decoder/index.cjs');

const MAX_BYTES = 1024 * 1024;
const normalize = value => String(value || '').normalize('NFKC').trim().toLowerCase();
const sqlString = value => "'" + String(value).replace(/'/g, "''") + "'";

// Use only the player's music and lyric databases, opened read-only. No login
// data, network requests or dependency on a developer-installed Python runtime.
function localCommand(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 1200, maxBuffer: MAX_BYTES * 3, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
    child.stdin.on('error', () => {}); // A failed plutil may close stdin early.
    child.stdin.end(input);
  });
}

function xmlText(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (entity, key) => {
    const names = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
    if (names[key.toLowerCase()]) return names[key.toLowerCase()];
    const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

function parseNativeLyrics(source) {
  if (typeof source !== 'string' || source.length > MAX_BYTES) return [];
  const attribute = source.match(/LyricContent\s*=\s*(["'])([\s\S]*?)\1/);
  let text = xmlText(attribute ? attribute[2] : source).replace(/^\uFEFF/, '');
  // Some QQ LRC envelopes store LyricContent as base64 instead of plain XML text.
  if (attribute && /^[A-Za-z0-9+/=\s]+$/.test(text) && !text.includes('[')) text = Buffer.from(text, 'base64').toString('utf8');
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const qrc = raw.match(/^\[(\d+),(\d+)\](.*)$/);
    if (qrc) {
      const words = qrc[3].replace(/\(\d+,\d+(?:,\d+)?\)/g, '').trim();
      if (words) lines.push({ time: Math.max(0, Number(qrc[1]) / 1000 - offset), text: words });
      continue;
    }
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const words = raw.slice(stamps.at(-1).index + stamps.at(-1)[0].length).trim();
    if (!words) continue;
    for (const stamp of stamps) lines.push({ time: Math.max(0, Number(stamp[1]) * 60 + Number(stamp[2]) - offset), text: words });
  }
  return lines.sort((a, b) => a.time - b.time).filter((line, index, all) =>
    index === 0 || line.time !== all[index - 1].time || line.text !== all[index - 1].text
  );
}

function matchSong(rows, track) {
  const artist = normalize(track.artist);
  const album = normalize(track.album);
  const matches = rows.filter(row => {
    if (!/^\d+$/.test(String(row.id)) || normalize(row.name) !== normalize(track.title)) return false;
    const names = String(row.singer || '').split(/\r?\n/).map(normalize).filter(Boolean);
    const joined = [names.join('/'), names.join(' / '), names.join('、')];
    if (artist ? !names.includes(artist) && !joined.includes(artist) : !album) return false;
    if (track.duration > 0 && row.duration > 0 && Math.abs(track.duration - row.duration) > 2) return false;
    return !album || !row.album || normalize(row.album) === album;
  });
  const ids = [...new Set(matches.map(row => String(row.id)))];
  return ids.length === 1 ? ids[0] : null;
}

function selectCachedLine(lyrics, elapsed) {
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const lines = lyrics.lines;
  let index = -1;
  for (let i = 0; i < lines.length && lines[i].time <= elapsed; i++) index = i;
  if (index < 0) return null;
  const current = lines[index];
  // Translation timestamps may differ slightly from the word-level source.
  const translation = lyrics.translation.reduce((closest, line) =>
    Math.abs(line.time - current.time) <= 0.6 && (!closest || Math.abs(line.time - current.time) < Math.abs(closest.time - current.time)) ? line : closest, null);
  return { current: current.text, next: translation && translation.text !== current.text ? translation.text : (lines[index + 1]?.text || '') };
}

class QQMusicCache {
  constructor({ platform = process.platform, home = os.homedir(), command = localCommand } = {}) {
    this.platform = platform;
    this.command = command;
    this.root = path.join(home, 'Library/Containers/com.tencent.QQMusicMac/Data/Library/Application Support/QQMusicMac');
    this.memo = null;
  }

  async read(track) {
    if (this.platform !== 'darwin' || !track.title || track.title.length > 500 || !Number.isFinite(track.elapsed)) return null;
    const key = JSON.stringify([track.title, track.artist || '', track.album || '']);
    if (!this.memo || this.memo.key !== key || this.memo.expiresAt < Date.now()) {
      let lyrics = null;
      try { lyrics = await this.load(track); } catch (_error) { /* Missing/locked/changed player cache falls back to other readers. */ }
      this.memo = { key, lyrics, expiresAt: Date.now() + (lyrics ? 30000 : 3000) };
    }
    const lines = this.memo.lyrics && selectCachedLine(this.memo.lyrics, track.elapsed);
    return lines ? { ...lines, state: 'ok', playerId: 'qqmusic', playerName: 'QQ 音乐', sourceKind: 'local-cache' } : null;
  }

  async load(track) {
    const songsDb = path.join(this.root, 'qqmusic.sqlite');
    const lyricsDb = path.join(this.root, 'iRRCache/rrdbcache.sqlite');
    if (!fs.existsSync(songsDb) || !fs.existsSync(lyricsDb)) return null;
    const songs = JSON.parse(await this.command('/usr/bin/sqlite3', ['-readonly', '-json', songsDb,
      `SELECT id,name,singer,album FROM SONGS WHERE name=${sqlString(track.title)} COLLATE NOCASE LIMIT 20;`]) || '[]');
    const id = matchSong(songs, track);
    if (!id) return null;
    const cached = JSON.parse(await this.command('/usr/bin/sqlite3', ['-readonly', '-json', lyricsDb,
      `SELECT keyId,hex(data) AS payload FROM Cache WHERE keyId IN ('${id}.qrc','${id}_trans.lrc') AND length(data)<=${MAX_BYTES} LIMIT 2;`]) || '[]');
    const decoded = {};
    for (const row of cached) {
      if (typeof row.payload !== 'string' || row.payload.length > MAX_BYTES * 2 || !/^[\da-f]+$/i.test(row.payload)) continue;
      try {
        const encrypted = await this.command('/usr/bin/plutil', ['-extract', '$objects.1', 'raw', '-o', '-', '-'], Buffer.from(row.payload, 'hex'));
        if (!encrypted || encrypted.length > MAX_BYTES * 2 || encrypted.length % 16 || !/^[\da-f]+$/i.test(encrypted)) continue;
        decoded[row.keyId] = parseNativeLyrics(decryptQrc(encrypted));
      } catch (_error) { /* A missing/broken translation must not discard the original. */ }
    }
    const lines = decoded[`${id}.qrc`];
    return lines?.length ? { lines, translation: decoded[`${id}_trans.lrc`] || [] } : null;
  }
}

module.exports = { QQMusicCache, matchSong, parseNativeLyrics, selectCachedLine, localCommand };
