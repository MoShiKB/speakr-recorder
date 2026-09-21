// The hidden offscreen document: the only extension page that can hold a
// capture stream without a visible window. It records both modes.

import { getMic, Session, DISPLAY_OPTIONS } from './recorder-core.js';

let session = null;

const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg });

function begin({ recId, source, mic, playSource, silenceStopMinutes }) {
  session = new Session({
    recId,
    source,
    mic,
    playSource,
    silenceStopMinutes,
    onAutoStop: (result) => {
      session = null;
      toBackground({ type: 'finished', ...result });
    },
  });
  return session.start();
}

async function startTab({ recId, streamId, micDeviceId, silenceStopMinutes }) {
  const source = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  const mic = await getMic(micDeviceId);
  // tabCapture mutes the tab for the user; playSource routes it back out.
  await begin({ recId, source, mic, playSource: true, silenceStopMinutes });
  return { ok: true, mic: Boolean(mic) };
}

// Not awaited by the background: the share dialog can stay open for as long
// as the user likes, so the outcome is reported by message instead of holding
// the service worker's request open.
async function startScreen({ recId, micDeviceId, silenceStopMinutes }) {
  const asked = Date.now();
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia(DISPLAY_OPTIONS);
  } catch (e) {
    // A rejection with no dialog on screen means Chrome would not open it
    // from here; the background falls back to the visible recorder window.
    const shown = Date.now() - asked > 700;
    const cancelled = e.name === 'NotAllowedError' && shown;
    toBackground({ type: cancelled ? 'screen-cancelled' : 'screen-needs-window', recId, error: `${e.name}: ${e.message}` });
    return;
  }
  if (!display.getAudioTracks().length) {
    display.getTracks().forEach((t) => t.stop());
    toBackground({ type: 'screen-no-audio', recId });
    return;
  }
  const mic = await getMic(micDeviceId);
  await begin({ recId, source: display, mic, playSource: false, silenceStopMinutes });
  toBackground({ type: 'screen-started', recId, mic: Boolean(mic) });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  const reply = (p) => p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
  switch (msg.type) {
    case 'start':
      reply(startTab(msg));
      return true;
    case 'start-screen':
      startScreen(msg).catch((e) => toBackground({ type: 'screen-needs-window', recId: msg.recId, error: String(e.message || e) }));
      sendResponse({ ok: true });
      return false;
    case 'stop': {
      const s = session;
      session = null;
      reply(s ? s.stop() : Promise.resolve({ ok: false, error: 'Not recording' }));
      return true;
    }
    default:
      return false;
  }
});
