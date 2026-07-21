const { EndBehaviorType } = require('@discordjs/voice');
const OpusScript = require('opusscript');
const { log } = require('./utils');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

/** Stores short PCM chunks in RAM, independently for each speaker. */
class Recorder {
  constructor(minutes = 30, options = {}) {
    this.maxAgeMs = minutes * 60 * 1000;
    this.users = new Map();
    this.subscriptions = new Map();
    this.totalPackets = 0;
    this.totalBytes = 0;
    this.lastPacketAt = null;
    this.shouldRecord = options.shouldRecord || (() => true);
  }
  start(connection) {
    this.connection = connection;
    connection.receiver.speaking.on('start', id => this.subscribe(id));
    log('Recorder started.');
  }
  subscribe(userId) {
    if (this.subscriptions.has(userId) || !this.shouldRecord(userId)) return;
    const opus = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterInactivity, duration: 1000 } });
    const decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    let nextChunkAt = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      decoder.delete();
      this.subscriptions.delete(userId);
    };
    opus.on('data', packet => {
      try {
        const pcm = decoder.decode(packet);
        const durationMs = (pcm.length / BYTES_PER_SECOND) * 1000;
        const receivedAt = Date.now();
        if (nextChunkAt === null || receivedAt - nextChunkAt > 120 || nextChunkAt - receivedAt > 100) nextChunkAt = receivedAt - durationMs;
        this.add(userId, pcm, nextChunkAt);
        nextChunkAt += durationMs;
      }
      catch (error) { log(`Opus decode error for ${userId}: ${error.message}`); }
    });
    opus.once('end', cleanup);
    opus.once('close', cleanup);
    opus.once('error', error => { log(`Voice receive error for ${userId}: ${error.message}`); cleanup(); });
    this.subscriptions.set(userId, { opus, cleanup });
    log(`Receiving audio from ${userId}.`);
  }
  exclude(userId) {
    const subscription = this.subscriptions.get(userId);
    if (subscription) { subscription.opus.destroy(); subscription.cleanup(); }
    this.users.delete(userId);
  }
  add(userId, buffer, at = Date.now() - (buffer.length / BYTES_PER_SECOND) * 1000) {
    const now = Date.now();
    const chunks = this.users.get(userId) || [];
    chunks.push({ at, buffer: Buffer.from(buffer) });
    const earliest = now - this.maxAgeMs;
    while (chunks.length && chunks[0].at + (chunks[0].buffer.length / BYTES_PER_SECOND) * 1000 < earliest) chunks.shift();
    this.users.set(userId, chunks);
    this.totalPackets += 1;
    this.totalBytes += buffer.length;
    this.lastPacketAt = now;
  }
  extract(seconds) {
    const until = Date.now();
    const since = until - seconds * 1000;
    const outputLength = Math.ceil(seconds * BYTES_PER_SECOND);
    const audio = new Map();
    for (const [userId, chunks] of this.users) {
      if (!this.shouldRecord(userId)) { this.exclude(userId); continue; }
      const selected = chunks.filter(chunk => chunk.at + (chunk.buffer.length / BYTES_PER_SECOND) * 1000 >= since && chunk.at <= until);
      if (!selected.length) continue;
      const track = Buffer.alloc(outputLength);
      for (const chunk of selected) {
        const rawOffset = Math.round(((chunk.at - since) / 1000) * BYTES_PER_SECOND / 4) * 4;
        const destinationOffset = Math.max(0, rawOffset);
        const sourceOffset = Math.max(0, -rawOffset);
        const copyLength = Math.min(chunk.buffer.length - sourceOffset, track.length - destinationOffset);
        if (copyLength > 0) chunk.buffer.copy(track, destinationOffset, sourceOffset, sourceOffset + copyLength);
      }
      audio.set(userId, track);
    }
    return audio;
  }
  status() { return { users: this.users.size, subscriptions: this.subscriptions.size, bufferMinutes: this.maxAgeMs / 60000, totalPackets: this.totalPackets, totalBytes: this.totalBytes, lastPacketAt: this.lastPacketAt }; }
  stop() { for (const { opus, cleanup } of this.subscriptions.values()) { opus.destroy(); cleanup(); } this.subscriptions.clear(); this.users.clear(); }
}
module.exports = Recorder;
