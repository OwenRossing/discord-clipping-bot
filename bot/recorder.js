const { EndBehaviorType } = require('@discordjs/voice');
const { log } = require('./utils');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

/** Stores short PCM chunks in RAM, independently for each speaker. */
class Recorder {
  constructor(minutes = 30) {
    this.maxAgeMs = minutes * 60 * 1000;
    this.users = new Map();
    this.subscriptions = new Map();
    this.totalPackets = 0;
    this.totalBytes = 0;
    this.lastPacketAt = null;
  }
  start(connection) {
    this.connection = connection;
    connection.receiver.speaking.on('start', id => this.subscribe(id));
    log('Recorder started.');
  }
  subscribe(userId) {
    if (this.subscriptions.has(userId)) return;
    const opus = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterInactivity, duration: 1000 } });
    const decoder = new (require('@discordjs/opus').OpusEncoder)(SAMPLE_RATE, CHANNELS);
    const cleanup = () => this.subscriptions.delete(userId);
    opus.on('data', packet => {
      try { this.add(userId, decoder.decode(packet)); }
      catch (error) { log(`Opus decode error for ${userId}: ${error.message}`); }
    });
    opus.once('end', cleanup);
    opus.once('close', cleanup);
    opus.once('error', error => { log(`Voice receive error for ${userId}: ${error.message}`); cleanup(); });
    this.subscriptions.set(userId, { opus });
    log(`Receiving audio from ${userId}.`);
  }
  add(userId, buffer) {
    const now = Date.now();
    const chunks = this.users.get(userId) || [];
    chunks.push({ at: now, buffer: Buffer.from(buffer) });
    const earliest = now - this.maxAgeMs;
    while (chunks.length && chunks[0].at < earliest) chunks.shift();
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
      const selected = chunks.filter(chunk => chunk.at >= since && chunk.at <= until);
      if (!selected.length) continue;
      const track = Buffer.alloc(outputLength);
      for (const chunk of selected) {
        const offset = Math.max(0, Math.round((((chunk.at - since) / 1000) * BYTES_PER_SECOND - chunk.buffer.length) / 4) * 4);
        if (offset < track.length) chunk.buffer.copy(track, offset, 0, Math.min(chunk.buffer.length, track.length - offset));
      }
      audio.set(userId, track);
    }
    return audio;
  }
  status() { return { users: this.users.size, subscriptions: this.subscriptions.size, bufferMinutes: this.maxAgeMs / 60000, totalPackets: this.totalPackets, totalBytes: this.totalBytes, lastPacketAt: this.lastPacketAt }; }
  stop() { for (const { opus } of this.subscriptions.values()) opus.destroy(); this.subscriptions.clear(); this.users.clear(); }
}
module.exports = Recorder;
