// Whole-computer mode. The background opens this window; it asks Chrome for the
// share dialog, then minimizes itself for the length of the recording.
//
// chrome.desktopCapture opens the dialog straight away. getDisplayMedia would
// not: Chrome rejects it without a click on this page, and the hidden
// offscreen document has no way to get one. getDisplayMedia stays as the
// fallback behind a button, for a dialog that offered no sound (it is the
// path Chrome 141+ documents for system audio on macOS).

import { getMic, Session, DISPLAY_OPTIONS } from './recorder-core.js';
import { getSettings } from './settings.js';

const recId = new URLSearchParams(location.search).get('recId');
const $ = (id) => document.getElementById(id);
let session = null;
let tick = null;

const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', recId, ...msg });

function show(state, message = '') {
  document.body.dataset.state = state;
  $('message').innerHTML = message;
}

const fmt = (sec) => {
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

async function setWindow(update) {
  const win = await chrome.windows.getCurrent();
  await chrome.windows.update(win.id, update).catch(() => {});
}

function pickWithDesktopCapture() {
  return new Promise((resolve) => {
    chrome.desktopCapture.chooseDesktopMedia(['screen', 'audio'], (streamId, options) => {
      resolve({ streamId, canAudio: Boolean(options?.canRequestAudioTrack) });
    });
  });
}

async function startWithDesktopCapture() {
  show('choosing');
  const { streamId, canAudio } = await pickWithDesktopCapture();
  if (!streamId) {
    // Cancel in Chrome's dialog cancels the whole thing.
    toBackground({ type: 'screen-cancelled' });
    return;
  }
  if (!canAudio) {
    show('idle', 'That share had no sound. Try again and keep <b>Share system audio</b> on.');
    return;
  }
  const source = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } };
  let display;
  try {
    display = await navigator.mediaDevices.getUserMedia({
      audio: source,
      // Chrome only hands out desktop audio together with video; keep it tiny.
      video: { mandatory: { ...source.mandatory, maxWidth: 640, maxHeight: 360, maxFrameRate: 1 } },
    });
  } catch (e) {
    show('idle', `Chrome could not start that capture (${e.name}). Try again.`);
    return;
  }
  await begin(display);
}

async function startWithDisplayMedia() {
  show('choosing');
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia(DISPLAY_OPTIONS);
  } catch (e) {
    show('idle', e.name === 'NotAllowedError' ? 'Sharing was cancelled. Try again, or Cancel.' : `${e.name}: ${e.message}`);
    return;
  }
  await begin(display);
}

async function begin(display) {
  if (!display.getAudioTracks().length) {
    display.getTracks().forEach((t) => t.stop());
    show('idle', 'No sound was shared. Try again and keep <b>Share system audio</b> on.');
    return;
  }
  const settings = await getSettings();
  const mic = await getMic(settings.micDeviceId);
  session = new Session({
    recId,
    source: display,
    mic,
    playSource: false,
    silenceStopMinutes: settings.silenceStopMinutes,
    onAutoStop: (result) => finish(result),
  });
  await session.start();
  const startedAt = Date.now();
  $('mic').textContent = mic ? 'your mic: on' : 'your mic: OFF';
  tick = setInterval(() => { $('elapsed').textContent = fmt(Math.round((Date.now() - startedAt) / 1000)); }, 500);
  show('recording', 'Recording everything this computer plays, plus your microphone.');
  await toBackground({ type: 'screen-started', mic: Boolean(mic) });
  setWindow({ state: 'minimized' });
}

async function finish(result) {
  clearInterval(tick);
  session = null;
  show('saving', result?.ok ? 'Saved. Sending to Speakr…' : 'Nothing was recorded.');
  await toBackground({ type: 'finished', ...result });
}

$('choose').addEventListener('click', startWithDisplayMedia);
$('stop').addEventListener('click', async () => {
  if (!session) return;
  const s = session;
  show('saving', 'Saving…');
  finish({ ...(await s.stop()), reason: 'manual' });
});
$('cancel').addEventListener('click', () => toBackground({ type: 'screen-cancelled' }));

// Stop requested from the popup or the keyboard shortcut.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'recorder' || msg.recId !== recId || msg.type !== 'stop') return false;
  const s = session;
  session = null;
  clearInterval(tick);
  show('saving', 'Saving…');
  (s ? s.stop() : Promise.resolve({ ok: false })).then(sendResponse);
  return true;
});

window.addEventListener('beforeunload', (e) => {
  if (session) e.preventDefault();
});

startWithDesktopCapture();
