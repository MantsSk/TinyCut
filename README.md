# TinyCutOpus ✂

A tiny local CapCut-style editor: multi-track timeline, cutting & rearranging, audio, and
auto-transcribed animated subtitles. Runs entirely on your Mac.

```bash
./run.sh            # → http://localhost:8747
```

Needs `ffmpeg`, and `whisper-cli` (brew `whisper-cpp`) + a `ggml-*.bin` model for captions.
The model is auto-found in `./models`, `~/.cache/whisper`, or set `WHISPER_MODEL=/path/to/ggml-small.bin`.

## Features
- **Timeline** — magnetic MAIN track (drag clips to reorder, gaps close automatically), free overlay
  tracks above it (picture-in-picture, B-roll), audio tracks below. Trim by dragging clip edges,
  split with `S`, snapping, zoom, undo/redo, autosave.
- **Audio** — import music / sound files, record a voiceover over the playing timeline (🎙),
  per-clip volume (up to 200%), fade in/out, *Extract audio* from a video clip, track mute.
- **Captions** — *Generate captions* transcribes all speech on the timeline word-by-word (local
  whisper.cpp). 10 styles (Karaoke, Highlight box, One word, Classic, Bubble, Neon, Comic,
  Typewriter, Minimal, Marker), every property tweakable. Multiple caption tracks with different
  styles can be stacked. Edit text inline, drag/trim captions, export `.srt`.
- **Export** — MP4 (H.264/AAC) in 16:9, 9:16, 1:1 or 4:5 at 720p–4K.

## How it works
- `server.py` (FastAPI): media ingest (ffprobe, filmstrip + waveform thumbnails), transcription via
  `whisper-cli`, project persistence in `data/`, and export via one ffmpeg `filter_complex`.
- `static/js/`: vanilla ES modules. `captions.js` holds the caption renderer; the *same* canvas code
  draws the live preview and the export frames (uploaded as PNGs and overlaid by ffmpeg), so the
  export matches the preview exactly and ffmpeg doesn't need libass/drawtext.
