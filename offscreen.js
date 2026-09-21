// Tab mode. Lives in the hidden offscreen document, the only extension page
// that can hold a capture stream without a visible window.

import { getMic, Session } from './recorder-core.js';

let session = null;

async function start({ recId, streamId, micDeviceId, silenceStopMinutes }) {
  const source = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  const mic = await getMic(micDeviceId);
  session = new Session({
    recId,
    source,
    mic,
    playSource: true,
    silenceStopMinutes,
    onAutoStop: (result) => {
      session = null;
      chrome.runtime.sendMessage({ target: 'background', type: 'finished', ...result });
    },
  });
  await session.start();
  return { ok: true, mic: Boolean(mic) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  const reply = (p) => p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
  if (msg.type === 'start') {
    reply(start(msg));
    return true;
  }
  if (msg.type === 'stop') {
    const s = session;
    session = null;
    reply(s ? s.stop() : Promise.resolve({ ok: false, error: 'Not recording' }));
    return true;
  }
  return false;
});
