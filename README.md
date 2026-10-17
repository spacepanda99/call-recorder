# Call Recorder

A web page for a voice call between two phones. Each phone records its own microphone as a 48 kHz, 16-bit mono WAV file.

## How to use it
1. Both of you put in earbuds or headphones. Without them the other person's voice leaks into your mic and recording.
2. Both phones open the page in Chrome. Allow the microphone when asked.
3. One person taps **Start a new call** and reads out the 4-letter code.
4. The other types the code and taps **Join call**. Wait for "Connected. You can talk."
5. Either of you taps **Start recording**. Both phones start recording.
6. Keep the page open and on screen. Don't switch apps or lock the phone.
7. Either of you taps **Stop recording & save**. Each phone saves its own file to Downloads, named `call-host-…wav` or `call-guest-…wav`.
8. Upload both files.

Keep the level meter mostly green. If "CLIPPING" shows up, hold the phone a bit farther away.

If the page or Chrome crashes mid-recording, open the page again. It will offer to save what it recorded up to that point.

If the call won't connect, put both phones on Wi-Fi. There's no relay server, so a few mobile networks block direct connections.

## How it works
- `index.html` is the whole app. `peerjs.min.js` is PeerJS 1.5.4, stored locally.
- The live call uses WebRTC. Calls find each other through the free public PeerJS server and Google's free STUN servers.
- Each phone records its own raw mic (echo cancellation, noise suppression and auto gain turned off) through an AudioWorklet running at 48000 Hz. It saves a 1-second chunk to IndexedDB every second, and writes a PCM WAV when you stop.
- The live call uses compressed Opus audio, but that doesn't affect the recordings.
- Hosting needs HTTPS because phones won't allow the mic otherwise.

## Boomie upload rules (from the uploader's own checks, app.boomie.ai, 2026-10-17)
- Accepted: mono or stereo, 8 to 192 kHz, at least 1 second long. WAV, FLAC, MP3, M4A, Opus or OGG; lossless is preferred.
- Warnings: sample rate under 44.1 kHz, quiet audio (loudest peak under −6 dB), clipping on more than 1% of samples, and stereo files with a silent or duplicated channel.
- These files are 48 kHz, 16-bit, mono WAV, one per speaker, so they pass. The page shows "Loudest so far". Keep it between −6 and −1 dB.
