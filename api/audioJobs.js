class AudioBusyError extends Error {
  constructor(message = 'Audio rendering is busy. Please try again in a moment.') {
    super(message);
    this.status = 503;
    this.code = 'AUDIO_BUSY';
  }
}

const MAX_ACTIVE_JOBS = 2;
const MAX_QUEUED_JOBS = 20;
let activeJobs = 0;
let queuedJobs = 0;
const waiters = [];
const clipTails = new Map();
const previewRequests = new Map();

function acquire() {
  if (activeJobs < MAX_ACTIVE_JOBS) {
    activeJobs += 1;
    return Promise.resolve();
  }
  if (queuedJobs >= MAX_QUEUED_JOBS) return Promise.reject(new AudioBusyError());
  queuedJobs += 1;
  return new Promise(resolve => waiters.push(() => {
    queuedJobs -= 1;
    resolve();
  }));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else activeJobs -= 1;
}

function runAudioJob(clipId, kind, task) {
  const previous = clipTails.get(clipId) || Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    await acquire();
    const startedAt = Date.now();
    console.info(JSON.stringify({ event: 'ffmpeg_started', clipId, kind, activeJobs }));
    try {
      return await task();
    } finally {
      console.info(JSON.stringify({ event: 'ffmpeg_finished', clipId, kind, elapsedMs: Date.now() - startedAt }));
      release();
    }
  });
  clipTails.set(clipId, job);
  job.finally(() => {
    if (clipTails.get(clipId) === job) clipTails.delete(clipId);
  }).catch(() => {});
  return job;
}

function checkPreviewRate(userId, now = Date.now()) {
  const cutoff = now - 60_000;
  const recent = (previewRequests.get(userId) || []).filter(timestamp => timestamp > cutoff);
  if (recent.length >= 10) {
    const error = new Error('Preview limit reached. Wait a minute before rendering another preview.');
    error.status = 429;
    error.code = 'PREVIEW_RATE_LIMIT';
    throw error;
  }
  recent.push(now);
  previewRequests.set(userId, recent);
}

module.exports = { AudioBusyError, runAudioJob, checkPreviewRate };
