import { getSettings, saveSettings, speakrBase } from './settings.js';

const $ = (id) => document.getElementById(id);
let savedTimer = null;

function flashSaved() {
  $('saved').hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('saved').hidden = true; }, 1200);
}

async function save(patch) {
  await saveSettings(patch);
  flashSaved();
}

// Speakr sends no CORS headers; the extension reaches it through a host
// permission. speakr.example.com is granted at install, any other address is
// requested here (the click on Test counts as the required user gesture).
async function ensureHostPermission(url) {
  const origins = [`${new URL(url).origin}/*`];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

async function testConnection() {
  const out = $('test-result');
  out.className = '';
  out.textContent = 'Testing…';
  const settings = await getSettings();
  try {
    if (!settings.token) throw new Error('Paste an API token first');
    if (!(await ensureHostPermission(settings.speakrUrl))) throw new Error('Permission to reach that address was refused');
    const r = await fetch(`${speakrBase(settings)}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${settings.token}` },
    });
    if (r.status === 401) throw new Error('Token rejected: create a new one in Speakr');
    if (!r.ok) throw new Error(`Speakr answered HTTP ${r.status}`);
    const me = await r.json();
    out.className = 'good';
    out.textContent = `Connected as ${me.username || me.email || 'you'} ✓`;
  } catch (e) {
    out.className = 'error';
    out.textContent = e.message === 'Failed to fetch'
      ? 'Could not reach Speakr: is Tailscale on?'
      : e.message;
  }
}

async function micState() {
  const p = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
  const state = p?.state || 'unknown';
  $('mic-state').className = state === 'granted' ? 'good' : 'error';
  $('mic-state').textContent = state === 'granted' ? 'Allowed ✓' : state === 'denied'
    ? 'Blocked: click the lock icon in the address bar and allow the microphone'
    : 'Not allowed yet';
  $('allow-mic').hidden = state === 'granted';
  if (state === 'granted') await listMics();
}

async function listMics() {
  const settings = await getSettings();
  const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  const select = $('micDeviceId');
  select.replaceChildren(new Option('System default', ''), ...mics.map((d) => new Option(d.label || 'Microphone', d.deviceId)));
  select.value = mics.some((d) => d.deviceId === settings.micDeviceId) ? settings.micDeviceId : '';
}

async function allowMic() {
  try {
    // A visible extension page is the only place Chrome shows the prompt;
    // the grant then covers the hidden recorder too.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Declined: micState() explains how to undo it.
  }
  await micState();
}

// ---------------------------------------------------------------- helper
async function helperUi() {
  const { os } = await chrome.runtime.getPlatformInfo();
  if (os !== 'win') return;  // the Mac records the whole computer through Chrome itself
  $('helper-section').hidden = false;
  $('helper-state').className = '';
  $('helper-state').textContent = 'Checking…';
  const st = await chrome.runtime.sendMessage({ target: 'background', type: 'helper-status', fresh: true });
  if (st?.ok) {
    $('helper-state').className = 'good';
    $('helper-state').textContent = st.info?.busy
      ? 'Installed ✓ (recording right now)'
      : `Installed ✓ Records ${st.info?.device || 'the default output'}.`;
    $('helper-download').textContent = 'Download installer again';
    $('helper-steps').hidden = true;
  } else {
    $('helper-state').className = 'error';
    $('helper-state').textContent = /not found/i.test(st?.error || '')
      ? 'Not installed yet.'
      : `Not working: ${st?.error || 'no answer'}`;
    $('helper-download').textContent = 'Download installer';
    $('helper-steps').hidden = false;
  }
}

// One self-contained .cmd: a batch header that hands the rest of the file to
// PowerShell, then install.ps1 with the helper embedded as base64.
async function downloadInstaller() {
  const text = (path) => fetch(chrome.runtime.getURL(path)).then((r) => r.text());
  const [py, ps] = await Promise.all([text('helper/windows/speakr_helper.py'), text('helper/windows/install.ps1')]);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(py)));
  const cmd = [
    '@echo off',
    'echo Installing the Speakr Recorder helper...',
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$s=[IO.File]::ReadAllText('%~f0'); $i=$s.LastIndexOf('#'+'PS1-BEGIN'); & ([ScriptBlock]::Create($s.Substring($i)))\"",
    'echo.',
    'pause',
    'exit /b',
    '#PS1-BEGIN',
    `$HelperPy = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
    ps.replace(/\r?\n/g, '\r\n'),
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([cmd], { type: 'application/octet-stream' }));
  a.download = 'Install Speakr Recorder helper.cmd';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

async function init() {
  const s = await getSettings();
  $('speakrUrl').value = s.speakrUrl;
  $('token').value = s.token;
  $('language').value = s.language;
  $('silenceStopMinutes').value = s.silenceStopMinutes;
  $('deleteAfterSend').checked = s.deleteAfterSend;
  document.querySelector(`input[name=afterStop][value=${s.afterStop}]`).checked = true;

  $('speakrUrl').onchange = (e) => save({ speakrUrl: e.target.value.trim() || 'https://speakr.example.com' });
  $('token').onchange = (e) => save({ token: e.target.value.trim() });
  $('token').onfocus = (e) => { e.target.type = 'text'; };
  $('token').onblur = (e) => { e.target.type = 'password'; };
  $('language').onchange = (e) => save({ language: e.target.value });
  $('silenceStopMinutes').onchange = (e) => save({ silenceStopMinutes: Math.max(0, Number(e.target.value) || 0) });
  $('deleteAfterSend').onchange = (e) => save({ deleteAfterSend: e.target.checked });
  document.querySelectorAll('input[name=afterStop]').forEach((r) => {
    r.onchange = (e) => save({ afterStop: e.target.value });
  });
  $('micDeviceId').onchange = (e) => save({ micDeviceId: e.target.value });

  $('test').onclick = async () => {
    // Commit whatever is typed before testing it.
    await saveSettings({ speakrUrl: $('speakrUrl').value.trim() || s.speakrUrl, token: $('token').value.trim() });
    testConnection();
  };
  $('allow-mic').onclick = allowMic;
  $('shortcuts').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };

  const [cmd] = await chrome.commands.getAll();
  if (cmd?.shortcut) $('shortcut').textContent = cmd.shortcut;

  $('helper-download').onclick = downloadInstaller;
  $('helper-check').onclick = helperUi;

  await micState();
  if (s.token) testConnection();
  helperUi();
  if (location.hash === '#helper') $('helper-section').scrollIntoView();
}

init();
