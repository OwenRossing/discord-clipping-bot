const { EndBehaviorType } = require('@discordjs/voice');
const { PassThrough } = require('stream');
const { log } = require('./utils');

/** Stores short PCM chunks in RAM, independently for each speaker. */
class Recorder {
  constructor(minutes = 30) {
    this.maxAgeMs = minutes * 60 * 1000;
    this.users = new Map();
    this.subscriptions = new Map();
  }
  start(connection) {
    this.connection = connection;
    connection.receiver.speaking.on('start', id => this.subscribe(id));
    connection.receiver.speaking.on('end', id => this.stopSubscription(id));
    log('Recorder started.');
  }
  subscribe(userId) {
    if (this.subscriptions.has(userId)) return;
    const opus = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 300 } });
    const decoder = new (require('@discordjs/opus').OpusEncoder)(48000, 2);
    const output = new PassThrough();
    opus.on('data', packet => { try { output.write(decoder.decode(packet)); } catch (error) { log(`Decode error: ${error.message}`); } });
    opus.on('end', () => output.end());
    output.on('data', chunk => this.add(userId, chunk));
    output.on('end', () => this.subscriptions.delete(userId));
    this.subscriptions.set(userId, { opus, output });
  }
  stopSubscription(userId) { this.subscriptions.get(userId)?.opus.destroy(); }
  add(userId, buffer) {
    const now = Date.now();
    const chunks = this.users.get(userId) || [];
    chunks.push({ at: now, buffer: Buffer.from(buffer) });
    const earliest = now - this.maxAgeMs;
    while (chunks.length && chunks[0].at < earliest) chunks.shift();
    this.users.set(userId, chunks);
  }
  extract(seconds) {
    const since = Date.now() - seconds * 1000;
    const audio = new Map();
    for (const [userId, chunks] of this.users) {
      const selected = chunks.filter(chunk => chunk.at >= since).map(chunk => chunk.buffer);
      if (selected.length) audio.set(userId, Buffer.concat(selected));
    }
    return audio;
  }
  status() { return { users: this.users.size, subscriptions: this.subscriptions.size, bufferMinutes: this.maxAgeMs / 60000 }; }
  stop() { for (const { opus } of this.subscriptions.values()) opus.destroy(); this.subscriptions.clear(); this.users.clear(); }
}
module.exports = Recorder;
