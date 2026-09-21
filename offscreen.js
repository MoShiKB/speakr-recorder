// The hidden offscreen document: the only extension page that can hold a
// capture stream without a visible window. It records tab mode.

import { getMic, Session } from './recorder-core.js';

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  const reply = (p) => p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
  switch (msg.type) {
    case 'start':
      reply(startTab(msg));
      return true;
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
