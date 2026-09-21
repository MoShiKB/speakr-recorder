# Speakr Recorder

A Chrome extension that records a meeting or a call with one click and sends it
to [Speakr](https://speakr.example.com), which turns it into a Hebrew transcript
with speakers, a summary and action items. It works the same way on Windows and
on the Mac.

| Button | Records | Use it for |
|---|---|---|
| **Record this tab** | The current tab + your mic. One click, no dialog. | Google Meet, Zoom or Teams **in Chrome** |
| **Record whole computer** | Everything the computer plays + your mic, through Chrome's share dialog | Phone calls answered on the computer, FaceTime, WhatsApp Desktop, the Zoom app, anything |

**Phone calls:** answer them on the computer, then press *Record whole
computer*. On Windows, **Phone Link** rings for your iPhone. On the Mac,
FaceTime/Phone does it through Continuity. Calls answered on the iPhone itself
can't be recorded by the computer; use the iPhone's own recorder and the "Send
to Speakr" Shortcut for those.

`Alt+Shift+R` starts or stops a recording in the mode you used last.

## Install (Windows and Mac, same steps)

Needs Chrome 141 or newer. On the Mac it also needs macOS 14.2 or newer, for
whole-computer sound.

1. Get the folder:
   `git clone https://github.com/BaruchOrg/speakr-recorder.git`
   (on Windows it lives in `%USERPROFILE%\speakr-recorder`).
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked**, and choose that folder. Pin the red dot to the toolbar.
3. The settings page opens by itself:
   - **API token:** in Speakr, go to **Account → API Tokens → create**, paste it here, then click **Test connection**. It should say "Connected as moshik ✓". Tailscale must be on.
   - **Allow microphone:** click it and allow. Without it, only the other side is recorded.
   - **After a recording stops:** send automatically, or keep it in the list until you press Send.
4. **Mac only:** the first time you record the whole computer, macOS asks to let
   Chrome record the screen and system audio. Allow it in
   **System Settings → Privacy & Security → Screen & System Audio Recording**,
   then quit and reopen Chrome.

Updating: `git pull` in the folder, then click ↻ on the extension in
`chrome://extensions`.

## Using it

**Meeting in Chrome:** join the meeting, click the red dot → **Record this tab**.
You keep hearing everything. Stop from the popup, or just close the tab.

**Everything else:** click the red dot → **Record whole computer**. Chrome's
share dialog opens:

1. Click your screen under **Entire screen**.
2. Keep **Share with system audio** on. Without it there is no sound, and a notification tells you so.
3. Press **Share with Audio**.

Nothing else stays on screen. Stop from the popup, with `Alt+Shift+R`, or with
Chrome's "Stop sharing" bar. The screen image is never saved, only the sound.
If Chrome ever refuses to show the dialog directly, a small window asks
instead, and it minimizes itself once you've chosen.

**The icon** is grey when idle, and red with a **REC** badge while recording.

**After Stop**, depending on the setting:

- **Send automatically:** it uploads right away, and a notification opens the recording in Speakr when you click it. If the upload fails (Tailscale off, Speakr down), it stays in the list with a **Send** button.
- **Send when I click:** it waits in the list until you press **Send**.

The list in the popup shows every recording with its state: *Not sent*,
*Sending…*, *In Speakr*, *Transcribing…*, *Summarizing…* and *Ready ✓*. Each
entry has **Send**, **Open** (in Speakr), **⬇** (download the audio) and **🗑**.

**Safety nets:**
- Audio is saved to disk every 10 seconds, so a crash or a closed browser loses at most the last few seconds. The next time Chrome starts, the recording shows up in the list.
- A recording stops by itself after 5 minutes of silence (changeable in the settings).
- Nothing leaves the computer except the upload to your own Speakr.

Headphones give the cleanest recording. With speakers, your mic also picks up
the other side a second time.

## How it works

```
popup / Alt+Shift+R
   │
   ▼
background.js ── this tab ─────────► offscreen.html (hidden)
   │             tabCapture stream     tab audio + mic ───────┐
   │                                                          ├─► recorder-core.js
   └──────────── whole computer ───► offscreen.html (hidden)  │
                 getDisplayMedia       system audio + mic ────┘
                 (fallback: recorder.html window)
                                            │ Opus/WebM, 10 s chunks
                                            ▼
                                  IndexedDB (db.js)
                                            │ Stop
                                            ▼
             POST /api/v1/recordings/upload  (Bearer token, language=he)
```

- **Tab mode:** Chrome mutes a captured tab for the user, so the recorder plays it back through an AudioContext. That's why you still hear the meeting.
- **Whole-computer mode:** asks for the share dialog from the same hidden document (offscreen reason `DISPLAY_MEDIA`). If Chrome won't show it from there, it falls back to `recorder.html`, a visible window. The dialog's mandatory video track runs at 1 fps and is never recorded.
- **Speakr address:** `speakr.example.com` is allowed at install. Any other address asks for permission when you click Test connection.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not reach Speakr" | Tailscale is off, or the address is wrong |
| "Token rejected" | The token was revoked: create a new one in Speakr |
| Only the other side is in the recording | Settings → **Allow microphone**. If it says *blocked*, allow the microphone for the extension from the lock icon on the settings page. |
| Whole computer: "No sound was shared" | In the share dialog, choose **Entire screen** and turn on **Share system audio** |
| Mac: no system audio option | Chrome is older than 141, or it lacks the Screen & System Audio Recording permission (see Install step 4) |
| "Switch to the meeting tab first" | *Record this tab* records the tab you're looking at; open the meeting tab, then click the red dot |

## Test checklist (new computer)

1. Settings: Test connection shows **Connected as moshik ✓**, and the microphone shows **Allowed ✓**.
2. Open a YouTube video, then **Record this tab** for 30 s while talking. Stop. It reaches **Ready ✓**, and the transcript has both the video and your voice.
3. **Record whole computer**: Entire screen + Share system audio. Play something from another app and talk. Stop, and check the same way.
4. Record again and close Chrome mid-recording. Reopen it; the recording is in the list, marked recovered, and Send works.
5. Settings → *Send when I click* → record → it waits in the list → **Send** works.
