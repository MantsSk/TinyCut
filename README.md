# TinyCutOpus ✂

A tiny local CapCut-style editor: multi-track timeline, cutting & rearranging, audio, and
auto-transcribed animated subtitles. Runs entirely on your computer — nothing is uploaded anywhere.

It ships as a **desktop app for macOS, Windows and Linux**, and can also run in the browser for development.

## Install (for people you share it with)

Download the file for your system from the project's **GitHub Releases** page (or wherever you were sent it):

| System | File | Requirements |
|---|---|---|
| macOS | `TinyCutOpus-<version>-mac-arm64.dmg` | Apple Silicon (M1 or newer), macOS 13+ |
| Windows | `TinyCutOpus-<version>-windows-x64-setup.exe` (or the `-portable.zip`) | Windows 10/11, 64-bit |
| Linux | `TinyCutOpus-<version>-linux-x86_64.AppImage` | 64-bit, glibc 2.35+ (Ubuntu 22.04, Debian 12, Fedora 36 or newer) |

**macOS** — open the DMG and drag **TinyCutOpus** into **Applications**. The app isn't signed with an
Apple Developer ID, so the first launch is blocked: double-click it, click **Done**, then open
**System Settings → Privacy & Security** and click **Open Anyway** (or run
`xattr -dr com.apple.quarantine /Applications/TinyCutOpus.app`).

**Windows** — run the setup file. Because it isn't code-signed, SmartScreen may say *“Windows protected
your PC”*: click **More info → Run anyway**. The installer adds Microsoft Edge WebView2 if the PC
doesn't have it (Windows 11 already does). No admin rights needed. Uninstall from *Settings → Apps*.
The portable zip runs without installing — unzip and start `TinyCutOpus.exe`.

**Linux** — make it executable and run it:
```bash
chmod +x TinyCutOpus-*.AppImage && ./TinyCutOpus-*.AppImage
```
If it complains about FUSE, install it (`sudo apt install libfuse2`, or `libfuse2t64` on Ubuntu 24.04)
or run it with `--appimage-extract-and-run`.

**First captions.** The first time you click **Generate captions**, the app downloads a speech model
once (**Accurate** ~490 MB or **Fast** ~150 MB). On Macs transcription uses the GPU; on Windows and
Linux it runs on the CPU (needs AVX2, any CPU from ~2013 on) — pick **Fast** there if it feels slow.

Where things go:
| | macOS | Windows | Linux |
|---|---|---|---|
| Exported videos | `~/Movies/TinyCutOpus` | `Videos\TinyCutOpus` | `~/Videos/TinyCutOpus` |
| Project, media, speech model | `~/Library/Application Support/TinyCutOpus` | `%LOCALAPPDATA%\TinyCutOpus` | `~/.local/share/TinyCutOpus` |

The export dialog also has *Show in Finder/folder* and *Save a copy…*. To uninstall completely,
remove the app and those two folders.

## Build the installers

**All three at once (recommended): GitHub Actions.** Push the repo to GitHub, then either run the
**Desktop builds** workflow from the *Actions* tab, or bump `desktop/VERSION`, commit, and push a
matching tag:
```bash
git tag v1.0.0 && git push origin v1.0.0
```
`.github/workflows/desktop.yml` builds on real macOS, Windows and Linux machines, launches every
packaged app to run `desktop/smoketest.py` (import a clip → download model → captions → export), and
for tags publishes the DMG, setup.exe, portable zip and AppImage to a GitHub Release.

**One platform, locally.** PyInstaller can't cross-compile, so this builds for the OS you run it on:
```bash
python3 desktop/build.py     # Python 3.11–3.13
```
| On | Output in `dist/` | Also needs |
|---|---|---|
| macOS (Apple Silicon) | `TinyCutOpus-<v>-mac-arm64.dmg` | Xcode Command Line Tools |
| Windows | `…-windows-x64-setup.exe` + `…-portable.zip` | Visual Studio Build Tools (C++), CMake, Git, [Inno Setup 6](https://jrsoftware.org/isinfo.php) |
| Linux | `…-linux-x86_64.AppImage` | `cmake`, `g++`, `libxcb-cursor0` (see the apt list in the workflow) |

The script creates an isolated `.venv-build`, downloads static **FFmpeg 6.0** (checksum-pinned),
compiles **whisper.cpp** into one static binary (Metal on macOS, AVX2 CPU on Windows/Linux), refuses
to bundle anything that depends on libraries users won't have, runs PyInstaller
(`desktop/TinyCutOpus.spec`) and packages the result (DMG · Inno Setup installer · AppImage).

To smoke-test a build yourself:
```bash
TINYCUT_SELFTEST=$PWD/desktop/smoketest.py SMOKE_RESULT=/tmp/smoke.json TINYCUT_DATA=/tmp/tc \
  dist/TinyCutOpus.app/Contents/MacOS/TinyCutOpus      # or dist/TinyCutOpus/TinyCutOpus(.exe)
```

**Removing the security warnings** needs paid certificates: an Apple Developer ID for macOS
(`SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" NOTARY_PROFILE=<notarytool profile> python3 desktop/build.py`
signs, notarizes and staples the DMG) and a Windows code-signing certificate for the installer.

**Run the desktop shell without packaging** (uses `vendor/bin` if present, otherwise your PATH):
```bash
.venv/bin/pip install -r requirements-desktop.txt
.venv/bin/python desktop/app.py
```

### Why this stack
- **pywebview + PyInstaller.** The editor is a Python (FastAPI) backend with an HTML/JS UI. pywebview
  shows that UI in a native window using the system's web engine — WebKit on macOS, Edge WebView2 on
  Windows — and Qt WebEngine on Linux (bundled, so it doesn't depend on the distro). PyInstaller packs
  Python, the server and the UI per OS. Electron or Tauri would still have to ship the Python backend
  as a sidecar, only adding size and complexity.
- **Bundled static binaries** for ffmpeg and whisper.cpp, so nothing needs to be installed separately.
- **Speech model downloaded on first use** instead of bundled, keeping installers small.
- **Fonts bundled** (`static/fonts/`, SIL Open Font License), so captions render identically everywhere.

Limitations: macOS build is Apple Silicon only, Windows/Linux builds are x86-64 only; unsigned
builds show the one-time warnings above; no auto-update — publish a new release instead.

## Run in the browser (development)

```bash
./run.sh            # → http://localhost:8747
```
Needs Python 3.10+ and `ffmpeg` + `whisper-cli` on PATH (macOS: `brew install ffmpeg whisper-cpp`;
Linux: `apt install ffmpeg` and build [whisper.cpp](https://github.com/ggml-org/whisper.cpp)). The speech
model is downloaded by the app on first use into `data/models`; to use one you already have, put the
`ggml-*.bin` in `./models` or set `WHISPER_MODEL=/path/to/ggml-small.bin`. `TINYCUT_DATA` /
`TINYCUT_EXPORTS` override where projects and exports are stored.

## Features
- **Projects** — as many as you like (▤ Projects: new, open, duplicate, delete), each with its own
  timeline and media bin. Everything autosaves.
- **Timeline** — magnetic MAIN track (drag clips to reorder, gaps close automatically), free overlay
  tracks above it (picture-in-picture, B-roll), audio tracks below. Trim by dragging clip edges,
  split with `S`, snapping, zoom, undo/redo. Select several clips/captions with Shift/⌘-click, by
  dragging a box on an empty part of the timeline, or ⌘A — then move, split or delete them together.
- **Audio** — import music / sound files, record a voiceover over the playing timeline (🎙),
  per-clip volume (up to 200%), fade in/out, *Extract audio* from a video clip, track mute.
- **Captions** — *Generate captions* transcribes all speech on the timeline word-by-word (local
  whisper.cpp). 10 styles (Karaoke, Highlight box, One word, Classic, Bubble, Neon, Comic,
  Typewriter, Minimal, Marker), every property tweakable, placed top / middle / bottom. Multiple
  caption tracks with different styles can be stacked. Edit text inline, drag/trim captions, export `.srt`.
- **Export** — MP4 (H.264/AAC) in 16:9, 9:16, 1:1 or 4:5 at 720p–4K.

## How it works
- `server.py` (FastAPI): media ingest (ffprobe, filmstrip + waveform thumbnails), transcription via
  `whisper-cli`, speech-model download, project persistence, and export via one ffmpeg `filter_complex`.
- `static/js/`: vanilla ES modules. `captions.js` holds the caption renderer; the *same* canvas code
  draws the live preview and the export frames (uploaded as PNGs and overlaid by ffmpeg), so the
  export matches the preview exactly and ffmpeg doesn't need libass/drawtext.
- `desktop/app.py`: starts the server on a free local port and opens it in a native window, with
  native Save / Show-in-folder dialogs exposed to the page. `desktop/build.py` packages it per OS.
