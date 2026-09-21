import {
  putRecording, getRecording, listRecordings, updateRecording,
  getAudio, deleteAudio, deleteRecording, assembleChunks,
} from './db.js';
import { getSettings, saveSettings, speakrBase } from './settings.js';

const OFFSCREEN_PATH = 'offscreen.html';

// ---- the one active recording; survives service-worker restarts,
// cleared when Chrome quits (recoverOrphans() handles that case).
const getActive = async () => (await chrome.storage.session.get('active')).active || null;
const setActive = (active) =>
  active ? chrome.storage.session.set({ active }) : chrome.storage.session.remove('active');

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
    justification: 'Record the meeting tab or the computer audio, plus the microphone',
  });
}

// active.host: where the capture stream lives. 'offscreen' for tab mode and
// normally for whole-computer mode; 'window' only for the fallback window.
async function isLive(active) {
  if (!active) return false;
  if (active.host === 'window') return chrome.windows.get(active.windowId).then(() => true, () => false);
  return hasOffscreen();
}

async function closeRecorder(active) {
  if (active?.host === 'window') await chrome.windows.remove(active.windowId).catch(() => {});
  else if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

// Grey icon when idle; red icon + REC badge while recording.
function setRecordingUi(on) {
  const icon = (n) => `icons/${on ? 'icon' : 'idle'}${n}.png`;
  chrome.action.setIcon({ path: { 16: icon(16), 32: icon(32), 48: icon(48) } });
  chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  chrome.action.setTitle({ title: on ? 'Speakr Recorder: recording (click to stop)' : 'Speakr Recorder' });
}

function notify(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message });
}

const cleanTitle = (tab) => (tab?.title || '').replace(/^Meet\s*[-–]\s*/i, 'Meet: ').trim() || 'Browser meeting';

// ---------------------------------------------------------------- start
async function start({ mode, tab }) {
  if (await getActive()) throw new Error('Already recording');
  const settings = await getSettings();
  await saveSettings({ mode });  // the keyboard shortcut repeats the last mode
  return mode === 'screen' ? startScreen(settings) : startTab(settings, tab);
}

async function startTab(settings, tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Switch to the meeting tab first');
  // Chrome only allows this right after the user invoked the extension on
  // this tab: the popup click or the keyboard shortcut.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const id = `rec-${Date.now()}`;
  await putRecording({
    id, mode: 'tab', status: 'recording', startedAt: Date.now(), language: settings.language,
    title: cleanTitle(tab), source: new URL(tab.url).hostname,
  });

  await ensureOffscreen();
  let res = null;
  let lastError = null;
  // createDocument can resolve a moment before the offscreen listener exists.
  for (let i = 0; i < 10 && !res; i++) {
    try {
      res = await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'start', recId: id, streamId,
        micDeviceId: settings.micDeviceId, silenceStopMinutes: settings.silenceStopMinutes,
      });
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!res?.ok) {
    const error = res?.error || String(lastError?.message || 'The recorder did not start');
    await updateRecording(id, { status: 'failed', error });
    await closeRecorder({ host: 'offscreen' });
    throw new Error(error);
  }

  await updateRecording(id, { micCaptured: res.mic });
  await setActive({ id, mode: 'tab', host: 'offscreen', tabId: tab.id, startedAt: Date.now() });
  setRecordingUi(true);
  if (!res.mic) warnNoMic(id);
  return { ok: true, id };
}

async function startScreen(settings) {
  const id = `rec-${Date.now()}`;
  await putRecording({
    id, mode: 'screen', status: 'starting', startedAt: Date.now(), language: settings.language,
    title: 'Computer audio', source: 'whole computer',
  });
  await setActive({ id, mode: 'screen', host: 'offscreen', starting: true, startedAt: null });
  // Chrome's share dialog opens straight from the hidden document, so no window
  // of ours is needed. The outcome comes back as screen-started, -cancelled,
  // -no-audio or -needs-window.
  await ensureOffscreen();
  for (let i = 0; i < 10; i++) {
    try {
      await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'start-screen', recId: id,
        micDeviceId: settings.micDeviceId, silenceStopMinutes: settings.silenceStopMinutes,
      });
      return { ok: true, id };
    } catch (e) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  await openRecorderWindow(await getActive());
  return { ok: true, id };
}

// Fallback when Chrome will not show the share dialog from the hidden
// document: a visible window asks instead, then minimizes itself.
async function openRecorderWindow(active) {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  const win = await chrome.windows.create({
    url: `recorder.html?recId=${active.id}`, type: 'popup', width: 860, height: 700, focused: true,
  });
  await setActive({ ...active, host: 'window', windowId: win.id });
}

function warnNoMic(id) {
  notify(`nomic:${id}`, 'Recording without your microphone',
    'Only the other side is being recorded. Allow the microphone in the extension options.');
}

// ---------------------------------------------------------------- stop
async function stop(reason = 'manual') {
  const active = await getActive();
  if (!active) return { ok: false, error: 'Not recording' };
  if (active.starting) {
    await cancelScreen(active);
    return { ok: true };
  }
  const target = active.host === 'window' ? { target: 'recorder', recId: active.id } : { target: 'offscreen' };
  if (await isLive(active)) {
    try {
      await chrome.runtime.sendMessage({ ...target, type: 'stop', reason });
    } catch (e) {
      // Recorder already gone; settle() stitches the saved chunks.
    }
  }
  await afterStop(active, reason);
  return { ok: true, id: active.id };
}

async function cancelScreen(active) {
  await setActive(null);
  await deleteRecording(active.id);
  await closeRecorder(active);
}

async function afterStop(active, reason) {
  await setActive(null);
  setRecordingUi(false);
  await closeRecorder(active);
  await settle(active.id, reason);
}

// Bring a stopped recording to 'saved' (stitching chunks if the recorder died
// before it could save), then send it or leave it in the list.
async function settle(id, reason) {
  let rec = await getRecording(id);
  if (!rec) return;
  if (rec.status === 'starting') {
    await deleteRecording(id);
    return;
  }
  if (rec.status === 'recording') {
    const blob = await assembleChunks(id);
    rec = await updateRecording(id, blob
      ? {
        status: 'saved', endedAt: Date.now(), size: blob.size, hasAudio: true, recovered: true,
        durationSec: Math.round(((rec.lastChunkAt || Date.now()) - rec.startedAt) / 1000),
      }
      : { status: 'failed', error: 'Nothing was recorded' });
  }
  if (rec.status !== 'saved') return;
  if (reason === 'silence') {
    notify(`silence:${id}`, 'Recording stopped', `No sound for a while, so "${rec.title}" was stopped and saved.`);
  }
  const settings = await getSettings();
  if (settings.afterStop === 'auto') await send(id);
  else notify(`saved:${id}`, 'Recording saved', `"${rec.title}" is in the list. Press Send when you want it in Speakr.`);
}

// ---------------------------------------------------------------- upload
async function send(id) {
  const settings = await getSettings();
  const rec = await getRecording(id);
  if (!rec) return { ok: false, error: 'Recording not found' };
  const blob = await getAudio(id);
  if (!blob) return { ok: false, error: 'The audio is no longer stored' };
  if (!settings.token) {
    await updateRecording(id, { status: 'failed', error: 'No Speakr API token in the options' });
    notify(`notoken:${id}`, 'Not sent', 'Set your Speakr API token in the extension options, then press Send.');
    return { ok: false, error: 'No token' };
  }

  await updateRecording(id, { status: 'sending', sendingSince: Date.now(), error: null });
  const started = new Date(rec.startedAt);
  const stamp = started.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const form = new FormData();
  form.append('file', blob, `${rec.mode === 'tab' ? 'meeting' : 'computer'}-${stamp}.webm`);
  form.append('language', rec.language || settings.language);
  form.append('meeting_date', started.toISOString());
  form.append('notes', `Recorded by Speakr Recorder (${rec.mode === 'tab' ? rec.source : 'whole computer'}: ${rec.title}).`);

  try {
    const r = await fetch(`${speakrBase(settings)}/api/v1/recordings/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.token}` },
      body: form,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || body.message || `HTTP ${r.status}`);

    await updateRecording(id, {
      status: 'sent', sentAt: Date.now(), speakrId: body.id, speakrStatus: body.status, error: null,
    });
    if (settings.deleteAfterSend) {
      await deleteAudio(id);
      await updateRecording(id, { hasAudio: false });
    }
    notify(`sent:${body.id}`, 'Sent to Speakr', `"${rec.title}" is being transcribed. Click to open it.`);
    return { ok: true, speakrId: body.id };
  } catch (e) {
    const error = String(e.message || e);
    await updateRecording(id, { status: 'failed', error });
    notify(`fail:${id}`, 'Sending to Speakr failed', `${error}. It is kept in the list; press Send to retry.`);
    return { ok: false, error };
  }
}

// After a crash or a browser restart: stitch recordings that never finished,
// drop never-started ones, release uploads that were cut off mid-flight.
async function recoverOrphans() {
  const active = await getActive();
  const live = await isLive(active);
  if (active && !live) await setActive(null);
  for (const rec of await listRecordings()) {
    const isCurrent = live && active.id === rec.id;
    if ((rec.status === 'recording' || rec.status === 'starting') && !isCurrent) {
      await settle(rec.id, 'recovered');
    } else if (rec.status === 'sending' && Date.now() - (rec.sendingSince || 0) > 5 * 60_000) {
      await updateRecording(rec.id, { status: 'failed', error: 'The upload was interrupted' });
    }
  }
  setRecordingUi(Boolean(live && !active.starting));
}

// ---------------------------------------------------------------- wiring
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return false;
  const reply = (p) => p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));

  switch (msg.type) {
    case 'start':
      reply((msg.tabId ? chrome.tabs.get(msg.tabId).catch(() => null) : Promise.resolve(null))
        .then((tab) => start({ mode: msg.mode, tab })));
      return true;
    case 'stop':
      reply(stop('manual'));
      return true;
    case 'send':
      reply(send(msg.id));
      return true;
    case 'state':
      reply(getActive().then((active) => ({ ok: true, active })));
      return true;
    case 'screen-started':
      reply((async () => {
        const active = await getActive();
        if (active?.id !== msg.recId) return { ok: false };
        const startedAt = Date.now();
        await updateRecording(msg.recId, { status: 'recording', startedAt, micCaptured: msg.mic });
        await setActive({ ...active, starting: false, startedAt });
        setRecordingUi(true);
        if (!msg.mic) warnNoMic(msg.recId);
        return { ok: true };
      })());
      return true;
    case 'screen-needs-window':
      reply(getActive().then((a) => (a?.id === msg.recId && a.host === 'offscreen' ? openRecorderWindow(a) : null)).then(() => ({ ok: true })));
      return true;
    case 'screen-no-audio':
      notify(`noaudio:${msg.recId}`, 'Nothing recorded',
        'No sound was shared. Choose Entire screen and turn on "Share system audio".');
      reply(getActive().then((a) => (a?.id === msg.recId ? cancelScreen(a) : null)).then(() => ({ ok: true })));
      return true;
    case 'screen-cancelled':
      reply(getActive().then((a) => (a?.id === msg.recId ? cancelScreen(a) : null)).then(() => ({ ok: true })));
      return true;
    case 'finished':
      // The recorder stopped by itself (tab closed, Stop sharing, silence, or
      // the Stop button in the recorder window) and saved the file.
      reply(getActive().then((a) => (a?.id === msg.recId ? afterStop(a, msg.reason) : null)).then(() => ({ ok: true })));
      return true;
    default:
      return false;
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-recording') return;
  try {
    if (await getActive()) await stop('manual');
    else await start({ mode: (await getSettings()).mode, tab });
  } catch (e) {
    notify(`err:${Date.now()}`, 'Speakr Recorder', String(e.message || e));
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await getActive();
  if (active?.mode === 'tab' && active.tabId === tabId) await stop('tab-closed');
});

// The recorder window was closed by hand.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const active = await getActive();
  if (active?.host !== 'window' || active.windowId !== windowId) return;
  if (active.starting) await cancelScreen(active);
  else await afterStop(active, 'window-closed');
});

chrome.notifications.onClicked.addListener(async (id) => {
  const settings = await getSettings();
  const [kind, ref] = id.split(':');
  if (kind === 'sent') chrome.tabs.create({ url: `${speakrBase(settings)}/recordings/${ref}` });
  else if (kind === 'nomic' || kind === 'notoken') chrome.runtime.openOptionsPage();
  chrome.notifications.clear(id);
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(recoverOrphans);
recoverOrphans();
