# Chrome Web Store listing: copy/paste source

## Store listing tab

**Name:** Speakr Recorder

**Summary (132 chars max):**
Record a meeting tab or your whole computer, plus your mic, and send it to your own Speakr server for transcripts and summaries.

**Category:** Productivity → Tools

**Language:** English

**Description:**
Speakr Recorder is a companion to Speakr (https://github.com/murtaza-nasir/speakr), a self-hosted transcription server. It needs your own Speakr server and API token; it does nothing without one.

• Record this tab: one click records a Google Meet, Zoom or Teams meeting running in Chrome, plus your microphone. You keep hearing the meeting.
• Record whole computer: records everything the computer plays, plus your microphone: calls answered on the computer, desktop apps. It uses Chrome's screen-share dialog (sound only, the picture is never saved), or, on Windows, an optional local helper you install from the settings page.
• After stopping, the recording is uploaded to your Speakr server automatically, or kept in the extension's list until you press Send.
• Audio is saved locally every 10 seconds, so a crash loses little; a silence timeout stops forgotten recordings.
• Nothing is sent anywhere except the Speakr server address you configure.

**Icon:** icons/icon128.png
**Screenshot (1280x800):** store/screenshot-1280x800.png
**Small promo tile (440x280):** store/promo-440x280.png

## Privacy practices tab

**Single purpose:**
Record meeting or computer audio together with the user's microphone and upload it to the user's own self-hosted Speakr transcription server.

**Permission justifications:**
- `tabCapture`: records the audio of the meeting tab the user chooses ("Record this tab").
- `desktopCapture`: shows Chrome's share dialog so the user can record the computer's sound ("Record whole computer"). Only the audio is recorded.
- `offscreen`: holds the recording in a hidden document so no window has to stay open while recording a tab.
- `nativeMessaging`: talks to the optional Windows helper, which the user installs from the settings page. The helper streams the computer's sound when Chrome's own capture cannot (for example 7.1 surround headsets).
- `storage`: saves the user's settings (server address, API token, preferences).
- `notifications`: tells the user when a recording started, stopped or was sent, or when sending failed.
- `activeTab`: identifies the tab the user asked to record.
- Host permission `https://speakr.example.com/*` (and optional hosts): uploads recordings to the user's Speakr server. A different server address is only allowed after the user grants it in the settings.

**Remote code:** No, I am not using remote code.

**Data usage:** check **Personal communications** (audio recordings) and **Authentication information** (the user's Speakr API token, stored locally).
Certify all three: not sold to third parties; not used for purposes unrelated to the single purpose; not used for creditworthiness or lending.

**Privacy policy URL:** the public URL of store/privacy-policy.md (see README → Publishing).

## Distribution tab

**Visibility:** Private → Trusted testers (add your Google account under Account → Trusted testers).

## Test instructions (for the reviewer)

The extension uploads to a self-hosted Speakr server on a private network, so it cannot reach a server from the review environment. Without a server, the recording features still work: "Record this tab" on any tab with audio, then Stop. The recording appears in the popup list, and "⬇" downloads it. Sending fails with a clear message and keeps the recording in the list.
