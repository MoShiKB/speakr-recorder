import { listRecordings, getAudio, deleteRecording, updateRecording } from './db.js';
import { getSettings, saveSettings, speakrBase } from './settings.js';

const $ = (id) => document.getElementById(id);
const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg });
const MEETING = /^https:\/\/(meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}|([\w-]+\.)?zoom\.us\/(wc|j)\/|teams\.(microsoft|live)\.com\/)/i;

let settings;
let tab;
let active = null;

const fmt = (sec) => {
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
};

function showError(text) {
  $('error').textContent = text || '';
  $('error').hidden = !text;
}

// ---------------------------------------------------------------- header
async function renderWarnings() {
  const box = $('warnings');
  box.replaceChildren();
  if (!settings.token) {
    box.append(el('button', { className: 'warn', onclick: () => chrome.runtime.openOptionsPage() },
      'Add your Speakr API token →'));
  }
  const { os } = await chrome.runtime.getPlatformInfo();
  if (os === 'win') {
    const helper = await toBackground({ type: 'helper-status' });
    $('screen-hint').textContent = helper?.ok
      ? 'One click: phone calls, WhatsApp, any app'
      : 'Through Chrome\'s share dialog';
    if (!helper?.ok) {
      box.append(el('button', {
        className: 'warn',
        onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#helper') }),
      }, 'Install the Windows helper: whole-computer recording in one click, 7.1 headsets included →'));
    }
  }
  const mic = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
  if (mic && mic.state !== 'granted') {
    box.append(el('button', { className: 'warn', onclick: () => chrome.runtime.openOptionsPage() },
      'Allow the microphone, or only the other side is recorded →'));
  }
}

function renderLive() {
  const recording = Boolean(active);
  $('live').hidden = !recording;
  $('idle').hidden = recording;
  if (!recording) return;
  if (active.starting) {
    $('elapsed').textContent = 'starting…';
    $('live-title').textContent = 'Choose Entire screen + Share system audio';
  } else {
    $('elapsed').textContent = fmt(Math.round((Date.now() - active.startedAt) / 1000));
    $('live-title').textContent = active.mode === 'tab' ? 'this tab' : 'whole computer';
  }
}

// ---------------------------------------------------------------- list
function statusLabel(rec) {
  switch (rec.status) {
    case 'starting': return ['Starting…', 'busy'];
    case 'recording': return ['Recording', 'rec'];
    case 'saved': return ['Not sent', 'idle'];
    case 'sending': return ['Sending…', 'busy'];
    case 'failed': return ['Failed', 'bad'];
    case 'sent':
      switch (rec.speakrStatus) {
        case 'COMPLETED': return ['Ready ✓', 'good'];
        case 'FAILED': return ['Speakr failed', 'bad'];
        case 'PROCESSING': return ['Transcribing…', 'busy'];
        case 'SUMMARIZING': return ['Summarizing…', 'busy'];
        default: return ['In Speakr', 'busy'];
      }
    default: return [rec.status, 'idle'];
  }
}

function confirmButton(label, action) {
  const b = el('button', { className: 'small', textContent: label });
  b.onclick = async () => {
    if (b.dataset.armed) return action();
    b.dataset.armed = '1';
    b.textContent = 'Sure?';
    setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 3000);
  };
  return b;
}

async function renderList() {
  const recs = (await listRecordings()).filter((r) => r.status !== 'starting');
  $('empty').hidden = recs.length > 0;
  const base = speakrBase(settings);
  $('list').replaceChildren(...recs.slice(0, 30).map((rec) => {
    const [label, tone] = statusLabel(rec);
    const when = new Date(rec.startedAt);
    const meta = [
      when.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric' }),
      when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      rec.durationSec ? `${Math.max(1, Math.round(rec.durationSec / 60))} min` : null,
      rec.mode === 'screen' ? 'computer' : rec.source,
    ].filter(Boolean).join(' · ');

    const actions = el('div', { className: 'actions' });
    const busy = rec.status === 'recording' || rec.status === 'sending';
    if (rec.hasAudio && rec.status !== 'sent' && !busy) {
      actions.append(el('button', {
        className: 'small primary', textContent: 'Send',
        onclick: async (e) => {
          e.target.disabled = true;
          const r = await toBackground({ type: 'send', id: rec.id });
          if (!r?.ok) showError(r?.error);
          renderList();
        },
      }));
    }
    if (rec.speakrId) {
      actions.append(el('button', {
        className: 'small', textContent: 'Open',
        onclick: () => chrome.tabs.create({ url: `${base}/recordings/${rec.speakrId}` }),
      }));
    }
    if (rec.hasAudio && !busy) {
      actions.append(el('button', {
        className: 'small', textContent: '⬇', title: 'Download',
        onclick: async () => {
          const blob = await getAudio(rec.id);
          if (!blob) return;
          const a = el('a', { href: URL.createObjectURL(blob), download: `${rec.title || rec.id}.webm` });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        },
      }));
    }
    if (!busy) {
      actions.append(confirmButton('🗑', async () => { await deleteRecording(rec.id); renderList(); }));
    }

    return el('li', {},
      el('div', { className: 'item-head' },
        el('span', { className: 'ellipsis', textContent: rec.title || 'Recording', title: rec.title || '' }),
        el('span', { className: `chip ${tone}`, textContent: label, title: rec.error || '' })),
      el('div', { className: 'item-foot' }, el('small', { className: 'muted', textContent: meta }), actions),
      rec.status === 'failed' && rec.error ? el('small', { className: 'error', textContent: rec.error }) : null);
  }));
}

// Ask Speakr how far sent recordings got (only while the popup is open).
async function refreshSpeakrStatus() {
  if (!settings.token) return;
  const pending = (await listRecordings()).filter((r) => r.status === 'sent' && r.speakrId
    && !['COMPLETED', 'FAILED'].includes(r.speakrStatus) && Date.now() - (r.sentAt || 0) < 86_400_000);
  await Promise.all(pending.map(async (rec) => {
    try {
      const r = await fetch(`${speakrBase(settings)}/api/v1/recordings/${rec.speakrId}/status`, {
        headers: { Authorization: `Bearer ${settings.token}` },
      });
      if (r.ok) await updateRecording(rec.id, { speakrStatus: (await r.json()).status });
    } catch {
      // Offline or off the tailnet; try again next time.
    }
  }));
  renderList();
}

// ---------------------------------------------------------------- actions
async function startRecording(mode) {
  showError('');
  const r = await toBackground({ type: 'start', mode, tabId: tab?.id });
  if (!r?.ok) showError(r?.error || 'Could not start');
  await refreshState();
}

async function refreshState() {
  active = (await toBackground({ type: 'state' }))?.active || null;
  renderLive();
}

async function init() {
  settings = await getSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const url = tab?.url || '';
  if (!/^https?:/.test(url)) {
    $('rec-tab').disabled = true;
    $('tab-hint').textContent = 'Open the meeting tab first';
  } else if (MEETING.test(url)) {
    $('tab-hint').textContent = `Meeting detected: ${new URL(url).hostname}`;
  } else {
    $('tab-hint').textContent = new URL(url).hostname;
  }

  $('language').value = settings.language;
  $('language').onchange = (e) => saveSettings({ language: e.target.value });
  $('rec-tab').onclick = () => startRecording('tab');
  $('rec-screen').onclick = () => startRecording('screen');
  $('stop').onclick = async () => {
    $('stop').disabled = true;
    const r = await toBackground({ type: 'stop' });
    if (!r?.ok) showError(r?.error);
    $('stop').disabled = false;
    await refreshState();
    renderList();
  };
  $('settings').onclick = () => chrome.runtime.openOptionsPage();
  $('open-speakr').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: speakrBase(settings) }); };

  const [cmd] = await chrome.commands.getAll();
  $('shortcut').textContent = cmd?.shortcut ? `${cmd.shortcut} starts/stops` : '';

  await Promise.all([renderWarnings(), refreshState(), renderList()]);
  refreshSpeakrStatus();

  setInterval(renderLive, 1000);
  setInterval(async () => { await refreshState(); renderList(); }, 3000);
}

init();
