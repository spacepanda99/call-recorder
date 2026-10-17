# Call Recorder

https://spacepanda99.github.io/call-recorder/

A web page for a voice call between two phones. Each phone records its own microphone as a 48 kHz, 16-bit mono WAV file.

## How to use it
1. Both of you wear **wired** earphones. Bluetooth earbud mics are low quality, and without earphones the other voice leaks into your mic.
2. Both phones open the page in Chrome, type a name, and allow the microphone.
3. Run **Mic check** once (10 s). It measures room noise and your voice, then tells you how far to hold the phone. Tap "Use … from now on" to save that distance.
4. One person taps **Start a new call** and texts the 4-letter code. The other types it and taps **Join call**. Both screens say "Connected", and the friend card shows the other person's name.
5. Either of you taps **Start recording**. Both phones count down 3-2-1. The friend card shows that their phone is recording too.
6. While recording, the coach box gives distance advice ("move closer, to about 12 cm"). **Mark moment** drops a marker on both recordings.
7. Either of you taps **Stop & save**. Each phone saves its file, lists it under **Recordings**, and downloads, shares or saves it the way you chose in settings.
8. Upload both files to Boomie.

Try **Record solo** to see the recording screen without a friend.

## Features
- **Distance coach:** the mic check and the live advice use the level of your loud words (target about −4 dB peak) and the inverse-square rule (each time you halve the distance, the level goes up 6 dB). They also warn about background noise, clipping and Bluetooth mics.
- **Crash-safe recording:** each phone writes audio straight to its own storage (OPFS) every second. If the page crashes or closes, reopening it recovers the recording.
- **History:** every recording stays under Recordings until you delete it, with Play, Download, Share, Rename and Delete. You can also see how much storage is left.
- **File names:** a pattern you set, by default `{date}_{time}_{me}_with_{friend}`, e.g. `2026-10-17_14-05-33_Mike_with_Alex.wav`.
- **Where files go:** Downloads, the Share menu (Google Drive, Files app, email), a folder you pick (desktop Chrome only), or only in the app. Android Chrome doesn't let web pages pick folders. To choose a folder each time, turn on Chrome ⋮ › Settings › Downloads › "Ask where to download files".
- **Auto-level** (on by default): after recording, it raises a quiet file so its loudest peak is −3 dB. It applies the same gain to the whole file, never lowers or clips, and adds at most 20 dB.
- **Dropped calls:** if the call drops, recording keeps going and the joining phone reconnects by itself. If the friend's phone stopped recording, it restarts it.
- **Other:** mute (affects the live call only, not your recording), call quality (delay and packet loss), screen kept awake, low-battery warning.

## Disk space
- A recording takes **346 MB per hour** (5.8 MB per minute): 48,000 samples a second × 2 bytes, mono.
- The Storage card on the home screen shows roughly how much space is free and how many hours of recording that covers. During a recording, a "Space left" line updates every 15 s, and the friend card shows your friend's space left too.
- If less than 30 min of space is left, the app asks before it starts recording. It warns when about 10 min are left, and it stops and saves when space runs out (about 4 min left), so the file is never cut off half-written.
- Downloading or sharing makes a second copy. After uploading, delete the recording in the app to free space.

## Screen off and installing as an app
- **Timer:** the big HH:MM:SS clock on the call screen counts recorded time, and the friend card shows the other phone's timer.
- **Screen off:** audio goes from the audio thread straight to the disk writer, so a slow or paused page doesn't drop audio. (Tested by freezing the page for 4 s: no audio was lost.) Android Chrome normally keeps a live call and mic running with the screen off. Android can still pause Chrome to save battery, though, and that hasn't been tried on your phones. Do a 2-minute screen-off test first. **Keep the screen on** (in settings) is on by default and is the safest choice; turn the brightness down. Set Chrome's battery use to Unrestricted (Settings › Apps › Chrome › Battery).
- **Install as an app:** Chrome ⋮ › Add to Home screen › Install, or the Install button on the page. It opens full screen with its own icon, loads without signal, and keeps your recordings. It runs on the same Chrome engine, so screen-off behaviour doesn't change. A native Android app would be needed to guarantee background recording.

## If it won't connect
Put both phones on Wi-Fi. Calls use direct connections with Google STUN and no relay server, so some mobile networks block them. Check the code, and keep the first phone on the call screen.

## Boomie upload rules (from the uploader's own checks, app.boomie.ai, 2026-10-17)
- Accepted: mono or stereo, 8 to 192 kHz, at least 1 second long. WAV, FLAC, MP3, M4A, Opus or OGG; lossless is preferred.
- Warnings: sample rate under 44.1 kHz, quiet audio (loudest peak under −6 dB), clipping on more than 1% of samples, and stereo files with a silent or duplicated channel.
- These files are 48 kHz, 16-bit, mono WAV, one per speaker, and auto-level keeps peaks at −3 dB.

## Files
- `index.html`: the layout. `app.js`: the call, recording, coach and history. `rec-worker.js`: writes WAV files to OPFS. `peerjs.min.js`: PeerJS 1.5.4 (signaling uses the free PeerJS cloud server).
