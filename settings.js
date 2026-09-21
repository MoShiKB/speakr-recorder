export const DEFAULTS = {
  speakrUrl: 'https://speakr.example.com',
  token: '',
  language: 'he',
  // 'auto': send when the recording stops; if that fails it waits in the list.
  // 'manual': keep it in the list until Send is pressed.
  afterStop: 'auto',
  // Sent recordings are already in Speakr; keep only the list entry and link.
  deleteAfterSend: true,
  // Stops a recording nobody remembered to stop. 0 turns it off.
  silenceStopMinutes: 5,
  // 'tab' = the current tab (Meet/Zoom/Teams in Chrome), 'screen' = the whole
  // computer through Chrome's share dialog with system audio.
  mode: 'tab',
  micDeviceId: '',
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

export const saveSettings = (patch) => chrome.storage.local.set(patch);

export const speakrBase = (s) => s.speakrUrl.replace(/\/+$/, '');
