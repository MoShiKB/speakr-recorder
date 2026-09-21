// The hidden offscreen document: the only extension page that can hold a
// capture stream without a visible window. It records tab mode, and
// whole-computer mode when the Windows helper streams the computer's sound.

import { getMic, Session } from './recorder-core.js';

let session = null;
let pcmNode = null;

const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg });

function begin({ recId, source, makeSource, mic, playSource, silenceStopMinutes }) {
  session = new Session({
    recId,
    source,
    makeSource,
    mic,
    playSource,
    silenceStopMinutes,
    onAutoStop: (result) => {
      session = null;
      pcmNode = null;
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

// The helper's PCM arrives relayed by the background (only it can hold the
// native-messaging port) and plays into the mix through pcm-worklet.js.
async function startHelper({ recId, micDeviceId, silenceStopMinutes }) {
  const mic = await getMic(micDeviceId);
  await begin({
    recId,
    mic,
    playSource: false,
    silenceStopMinutes,
    makeSource: async (ctx) => {
      await ctx.audioWorklet.addModule('pcm-worklet.js');
      pcmNode = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [1] });
      return pcmNode;
    },
  });
  // The helper records at this rate, so nothing needs resampling here.
  return { ok: true, mic: Boolean(mic), sampleRate: session.ctx.sampleRate };
}

function pushPcm(base64) {
  if (!pcmNode) return;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const samples = new Int16Array(bytes.buffer);
  pcmNode.port.postMessage(samples, [samples.buffer]);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  const reply = (p) => p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
  switch (msg.type) {
    case 'start':
      reply(startTab(msg));
      return true;
    case 'start-helper':
      reply(startHelper(msg));
      return true;
    case 'pcm':
      pushPcm(msg.data);
      return false;
    case 'stop': {
      const s = session;
      session = null;
      pcmNode = null;
      reply(s ? s.stop() : Promise.resolve({ ok: false, error: 'Not recording' }));
      return true;
    }
    default:
      return false;
  }
});
