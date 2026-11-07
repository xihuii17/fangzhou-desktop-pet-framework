const fs = require('node:fs/promises');
const { selectCachedLine } = require('./qqmusic-cache');

const MAX_LYRIC_BYTES = 1024 * 1024;

// Bound reads even when the player replaces or grows a cache file during a read.
async function readBounded(file, limit = MAX_LYRIC_BYTES) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Unsupported cache file');
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size || bytesRead > limit) throw new Error('Cache is changing');
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const copy = Buffer.from(buffer.subarray(2));
    if (copy.length % 2) throw new Error('Truncated UTF-16');
    return copy.swap16().toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

// Only extract string objects from an Apple binary plist. No arbitrary object
// deserialization: the player's NSKeyedArchive contains a JSON string payload.
function plistStrings(buffer) {
  if (buffer.length < 40 || buffer.subarray(0, 8).toString() !== 'bplist00') return [];
  const trailer = buffer.length - 32;
  const integer = (offset, size) => {
    if (size < 1 || size > 8 || offset < 0 || offset + size > buffer.length) throw new Error('Invalid plist integer');
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + buffer[offset + i];
    if (!Number.isSafeInteger(value)) throw new Error('Oversized plist integer');
    return value;
  };
  const width = buffer[trailer + 6], count = integer(trailer + 8, 8), table = integer(trailer + 24, 8);
  if (count > 20000 || table < 8 || table + count * width > trailer) throw new Error('Invalid plist table');
  const strings = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    let offset = integer(table + i * width, width);
    if (offset < 8 || offset >= table) throw new Error('Invalid plist offset');
    const marker = buffer[offset++], kind = marker >> 4;
    if (kind !== 5 && kind !== 6) continue;
    let length = marker & 15;
    if (length === 15) {
      const sizeMarker = buffer[offset++];
      if (sizeMarker >> 4 !== 1) throw new Error('Invalid plist length');
      const size = 2 ** (sizeMarker & 15);
      length = integer(offset, size); offset += size;
    }
    const bytes = length * (kind === 6 ? 2 : 1);
    total += bytes;
    if (offset + bytes > table || total > buffer.length) throw new Error('Oversized plist strings');
    const data = Buffer.from(buffer.subarray(offset, offset + bytes));
    strings.push(kind === 6 ? data.swap16().toString('utf16le') : data.toString('utf8'));
  }
  return strings;
}

function cacheJson(buffer) {
  const candidates = buffer.subarray(0, 8).toString() === 'bplist00' ? plistStrings(buffer) : [decodeText(buffer)];
  for (const text of candidates) {
    if (!/^[\s]*[\[{]/.test(text)) continue;
    try { return JSON.parse(text); } catch (_) { /* Partial player writes are retried later. */ }
  }
  return null;
}

class LocalLyricsCache {
  constructor(playerId, playerName) {
    this.playerId = playerId;
    this.playerName = playerName;
    this.memo = null;
  }

  async read(track) {
    if (!track?.title || track.title.length > 500 || !Number.isFinite(track.elapsed) || track.elapsed < 0) return null;
    const key = JSON.stringify([track.title, track.artist || '', track.album || '', track.duration || 0]);
    let memo = this.memo;
    if (!memo || memo.key !== key || memo.expiresAt <= Date.now()) {
      let lyrics = null;
      try { lyrics = await this.load(track); } catch (_) { /* Keep native UI and online fallbacks available. */ }
      memo = { key, lyrics, expiresAt: Date.now() + (lyrics ? 15000 : 3000) };
      this.memo = memo;
    }
    const lines = memo.lyrics && selectCachedLine(memo.lyrics, track.elapsed);
    return lines ? { ...lines, state: 'ok', playerId: this.playerId, playerName: this.playerName, sourceKind: 'local-cache' } : null;
  }
}

module.exports = { MAX_LYRIC_BYTES, readBounded, decodeText, plistStrings, cacheJson, LocalLyricsCache };
