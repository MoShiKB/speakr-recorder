// The recording engine shared by both capture paths: the hidden offscreen
// document (tab and whole-computer mode) and the fallback recorder window.
// It mixes the captured source with the microphone into one Opus/WebM file.

import { putChunk, updateRecording, assembleChunks } from './db.js';

const CHUNK_MS = 10_000;
// RMS below this counts as silence. Speech sits around 0.02-0.2; noise-
// suppressed mic hiss and an idle call stay under 0.005.
const SILENCE_RMS = 0.004;

// Chrome's share dialog, preset to the whole screen with system audio. Video is
// mandatory for getDisplayMedia; it is kept tiny and never recorded.
export const DISPLAY_OPTIONS = {
  video: { displaySurface: 'monitor', frameRate: 1, width: { max: 640 }, height: { max: 360 } },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  systemAudio: 'include',
  monitorTypeSurfaces: 'include',
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'exclude',
  preferCurrentTab: false,
};

export async function getMic(deviceId) {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base,
    });
  } catch (e) {
    if (!deviceId) return null;
    // The chosen mic is gone (headset unplugged): fall back to the default.
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: base });
    } catch {
      return null;
    }
  }
}

export class Session {
  // source: MediaStream with the other side's audio.
  // playSource: tabCapture mutes the tab for the user, so route it back out.
  constructor({ recId, source, mic, playSource, silenceStopMinutes, onAutoStop }) {
    Object.assign(this, { recId, source, mic, playSource, silenceStopMinutes, onAutoStop });
    this.seq = 0;
    this.writes = Promise.resolve();
    this.stopping = null;
  }

  async start() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    if (this.source.getAudioTracks().length) {
      const src = ctx.createMediaStreamSource(this.source);
      src.connect(dest);
      src.connect(analyser);
      if (this.playSource) src.connect(ctx.destination);
    }
    if (this.mic) {
      const micSrc = ctx.createMediaStreamSource(this.mic);
      micSrc.connect(dest);
      micSrc.connect(analyser);
    }

    const recorder = new MediaRecorder(dest.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 64_000,
    });
    this.recorder = recorder;
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      const seq = this.seq++;
      this.writes = this.writes
        .then(() => putChunk(this.recId, seq, e.data))
        .then(() => updateRecording(this.recId, { lastChunkAt: Date.now() }));
    };
    recorder.start(CHUNK_MS);
    this.startedAt = Date.now();

    // Closing the tab, or Chrome's "Stop sharing" bar, ends the source.
    for (const track of this.source.getTracks()) {
      track.addEventListener('ended', () => this.autoStop('source-ended'), { once: true });
    }

    if (this.silenceStopMinutes > 0) {
      const buf = new Float32Array(analyser.fftSize);
      let lastSound = Date.now();
      this.silenceTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        if (Math.sqrt(sum / buf.length) > SILENCE_RMS) lastSound = Date.now();
        else if (Date.now() - lastSound > this.silenceStopMinutes * 60_000) this.autoStop('silence');
      }, 1000);
    }
  }

  autoStop(reason) {
    if (this.stopping) return;
    this.stop().then((result) => this.onAutoStop?.({ ...result, reason }));
  }

  stop() {
    if (!this.stopping) this.stopping = this.finalize();
    return this.stopping;
  }

  async finalize() {
    clearInterval(this.silenceTimer);
    if (this.recorder && this.recorder.state !== 'inactive') {
      const done = new Promise((resolve) => { this.recorder.onstop = resolve; });
      this.recorder.stop();
      await done;
    }
    await this.writes;
    for (const track of [...this.source.getTracks(), ...(this.mic?.getTracks() || [])]) track.stop();
    await this.ctx?.close().catch(() => {});

    const blob = await assembleChunks(this.recId);
    if (!blob) {
      await updateRecording(this.recId, { status: 'failed', error: 'Nothing was recorded' });
      return { ok: false, recId: this.recId };
    }
    await updateRecording(this.recId, {
      status: 'saved',
      endedAt: Date.now(),
      durationSec: Math.round((Date.now() - this.startedAt) / 1000),
      size: blob.size,
      hasAudio: true,
    });
    return { ok: true, recId: this.recId };
  }
}
