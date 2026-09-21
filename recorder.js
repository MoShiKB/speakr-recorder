// Whole-computer mode. getDisplayMedia needs a visible page, so this runs in a
// small window the background opens. Chrome's share dialog with "Share system
// audio" captures every app: Windows always, macOS 14.2+ with Chrome 141+.

import { getMic, Session } from './recorder-core.js';
import { getSettings } from './settings.js';

const recId = new URLSearchParams(location.search).get('recId');
const $ = (id) => document.getElementById(id);
let session = null;
let tick = null;

const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', recId, ...msg });

function show(state, message) {
  document.body.dataset.state = state;
  if (message) $('message').innerHTML = message;
}

const fmt = (sec) => {
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

async function choose() {
  show('choosing', 'Pick <b>Entire screen</b>, turn on <b>Share system audio</b>, then press <b>Share</b>.');
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      // Video is mandatory for getDisplayMedia; keep it as cheap as possible.
      video: { displaySurface: 'monitor', frameRate: 1, width: { max: 640 }, height: { max: 360 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      monitorTypeSurfaces: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      preferCurrentTab: false,
    });
  } catch (e) {
    show('idle', e.name === 'NotAllowedError'
      ? 'Sharing was cancelled. Choose again, or Cancel.'
      : 'Pick <b>Entire screen</b>, turn on <b>Share system audio</b>, then press <b>Share</b>.');
    return;
  }

  if (!display.getAudioTracks().length) {
    display.getTracks().forEach((t) => t.stop());
    show('idle', 'No sound was shared. Choose <b>Entire screen</b> and turn <b>Share system audio</b> on.');
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
}

async function finish(result) {
  clearInterval(tick);
  session = null;
  show('saving', result?.ok ? 'Saved. Sending to Speakr…' : 'Nothing was recorded.');
  await toBackground({ type: 'finished', ...result });
}

$('choose').addEventListener('click', choose);
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

// Chrome may open the share dialog straight away; if it wants a click first,
// the button is already there.
choose();
