"""TinyCutOpus — a tiny local CapCut-style editor.

Backend: media ingest (ffprobe + thumbnails), local transcription (whisper.cpp),
project persistence, and multi-track export with ffmpeg.

Captions are rendered in the browser (same canvas renderer used for preview) and
uploaded as PNG "states"; ffmpeg overlays them, so no libass/drawtext is needed.
"""

import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import urlsplit
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

FROZEN = getattr(sys, "frozen", False)  # running inside the packaged desktop app
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
DATA = Path(os.getenv("TINYCUT_DATA", BASE / "data"))
MEDIA_DIR = DATA / "media"
EXPORT_DIR = Path(os.getenv("TINYCUT_EXPORTS", DATA / "exports"))
WORK_DIR = DATA / "work"
MODELS_DIR = DATA / "models"
PROJECTS_DIR = DATA / "projects"
for d in (MEDIA_DIR, EXPORT_DIR, WORK_DIR, MODELS_DIR, PROJECTS_DIR):
    d.mkdir(parents=True, exist_ok=True)

MEDIA_INDEX = DATA / "media.json"
SESSION_FILE = DATA / "session.json"
PROJECT_FILE = DATA / "project.json"  # pre-projects single project, migrated on start

FFMPEG = os.getenv("FFMPEG_PATH", "ffmpeg")
FFPROBE = os.getenv("FFPROBE_PATH", "ffprobe")
WHISPER_CLI = os.getenv("WHISPER_CLI", shutil.which("whisper-cli") or "whisper-cli")

BROWSER_VIDEO_CODECS = {"h264", "hevc", "vp8", "vp9", "av1"}
BROWSER_CONTAINERS = {".mp4", ".mov", ".m4v", ".webm"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

app = FastAPI(title="TinyCutOpus")
_lock = threading.Lock()

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


@app.middleware("http")
async def local_only(request: Request, call_next):
    """Only this app's own pages may use the server: other websites open in the same browser can't
    send it requests (cross-site requests) or reach it through a rebound domain name (DNS rebinding)."""
    host = urlsplit("//" + request.headers.get("host", "")).hostname
    origin = request.headers.get("origin")
    if host not in LOCAL_HOSTS or (origin and urlsplit(origin).hostname not in LOCAL_HOSTS):
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    return await call_next(request)
jobs: dict[str, dict] = {}


# ---------------------------------------------------------------- helpers

def find_whisper_model() -> str | None:
    env = os.getenv("WHISPER_MODEL")
    if env and Path(env).exists():
        return env
    # Only the app's own folders: anything else would make it depend on this particular machine.
    candidates = [MODELS_DIR] if FROZEN else [MODELS_DIR, BASE / "models"]
    prefs = ["ggml-large-v3-turbo", "ggml-medium", "ggml-small", "ggml-base", "ggml-tiny"]
    found = []
    for c in candidates:
        if c.is_dir():
            found += [f for f in c.glob("ggml-*.bin") if f.stat().st_size > 1_000_000]
    for p in prefs:
        for f in found:
            if f.name.startswith(p):
                return str(f)
    return str(found[0]) if found else None


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    tmp.replace(path)


def media_index() -> dict:
    return load_json(MEDIA_INDEX, {})


# Don't flash a console window for every ffmpeg call in the Windows app.
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


MISSING_TOOL_HINT = {
    "ffmpeg": "Install FFmpeg (macOS: brew install ffmpeg · Linux: apt install ffmpeg · Windows: winget install ffmpeg) or set FFMPEG_PATH.",
    "ffprobe": "Install FFmpeg (it includes ffprobe) or set FFPROBE_PATH.",
    "whisper-cli": "Install whisper.cpp (macOS: brew install whisper-cpp) or set WHISPER_CLI. The desktop app bundles it.",
}


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **NO_WINDOW)
    except FileNotFoundError:
        tool = Path(cmd[0]).stem
        raise HTTPException(500, f"{tool} was not found. {MISSING_TOOL_HINT.get(tool, '')}".strip())


def probe(path: Path) -> dict:
    r = run([FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)])
    data = json.loads(r.stdout or "{}")
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    dur = float(data.get("format", {}).get("duration", 0) or 0)
    info = {"duration": dur, "has_audio": a is not None, "has_video": v is not None}
    if v:
        w, h = int(v.get("width", 0)), int(v.get("height", 0))
        rot = 0
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rot = int(sd["rotation"])
        rot = int(v.get("tags", {}).get("rotate", rot))
        if abs(rot) % 180 == 90:
            w, h = h, w
        num, den = (v.get("avg_frame_rate") or "30/1").split("/")
        fps = float(num) / float(den) if float(den) else 30.0
        info.update(width=w, height=h, fps=round(fps, 3), vcodec=v.get("codec_name"))
    return info


# ---------------------------------------------------------------- media

@app.post("/api/media")
async def upload_media(file: UploadFile = File(...), project: str = ""):
    ext = Path(file.filename or "clip.mp4").suffix.lower() or ".mp4"
    mid = uuid.uuid4().hex[:10]
    folder = MEDIA_DIR / mid
    folder.mkdir()
    src = folder / f"source{ext}"
    with open(src, "wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)

    try:
        info = probe(src)
    except HTTPException:  # e.g. ffprobe missing: don't leave an orphan folder behind
        shutil.rmtree(folder, ignore_errors=True)
        raise
    if ext in IMAGE_EXTS:
        kind = "image"
        info["duration"] = 5.0
    elif not info.get("has_video") or ext in AUDIO_EXTS:
        kind = "audio"
    else:
        kind = "video"
    if kind == "audio" and (ext in {".webm", ".ogg", ".opus"} or info["duration"] <= 0):
        # Browser recordings (MediaRecorder) often lack a duration header: normalise to m4a.
        fixed = folder / "source.m4a"
        r = run([FFMPEG, "-y", "-i", str(src), "-vn", "-c:a", "aac", "-b:a", "192k", str(fixed)])
        if r.returncode == 0:
            src.unlink()
            src = fixed
            info = probe(src)
    if kind != "image" and info["duration"] <= 0:
        shutil.rmtree(folder)
        raise HTTPException(400, "Could not read that file (no duration).")

    item = {
        "id": mid,
        "name": file.filename,
        "kind": kind,
        "source": str(src),
        "play": f"/files/media/{mid}/{src.name}",
        "projects": [project or current_project_id()],
        **info,
    }

    # Browser-playable proxy only when needed (e.g. AVI, MKV, ProRes).
    if kind == "video" and (ext not in BROWSER_CONTAINERS or info.get("vcodec") not in BROWSER_VIDEO_CODECS):
        proxy = folder / "proxy.mp4"
        r = run([FFMPEG, "-y", "-i", str(src), "-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264",
                 "-preset", "ultrafast", "-crf", "26", "-c:a", "aac", "-b:a", "128k", str(proxy)])
        if r.returncode == 0:
            item["play"] = f"/files/media/{mid}/proxy.mp4"

    # Timeline visuals.
    if kind == "video":
        n = max(4, min(60, int(info["duration"] / 2) + 1))
        rate = n / max(info["duration"], 0.1)
        r = run([FFMPEG, "-y", "-i", str(src), "-vf",
                 f"fps={rate},scale=-2:72,tile={n}x1", "-frames:v", "1", "-q:v", "5",
                 str(folder / "strip.jpg")])
        if r.returncode == 0:
            item["strip"] = f"/files/media/{mid}/strip.jpg"
            item["strip_n"] = n
        run([FFMPEG, "-y", "-ss", str(min(1.0, info["duration"] / 3)), "-i", str(src),
             "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", str(folder / "thumb.jpg")])
        item["thumb"] = f"/files/media/{mid}/thumb.jpg"
    elif kind == "image":
        item["thumb"] = item["play"]
        item["strip"] = item["play"]
        item["strip_n"] = 1
    if info.get("has_audio"):
        r = run([FFMPEG, "-y", "-i", str(src), "-filter_complex",
                 "aformat=channel_layouts=mono,showwavespic=s=2000x80:colors=white:scale=sqrt",
                 "-frames:v", "1", str(folder / "wave.png")])
        if r.returncode == 0:
            item["wave"] = f"/files/media/{mid}/wave.png"

    with _lock:
        idx = media_index()
        idx[mid] = item
        save_json(MEDIA_INDEX, idx)
    return item


@app.get("/api/media")
def list_media(project: str = ""):
    items = media_index().values()
    return [m for m in items if not project or project in m.get("projects", [])]


@app.delete("/api/media/{mid}")
def delete_media(mid: str, project: str = ""):
    """Remove media from a project's bin; the files go once no project uses it (or when no project is given)."""
    with _lock:
        idx = media_index()
        item = idx.get(mid)
        if not item:
            raise HTTPException(404)
        owners = item.get("projects", [])
        if project in owners:
            owners.remove(project)
        orphan = not project or not owners
        if orphan:
            del idx[mid]
        save_json(MEDIA_INDEX, idx)
    if orphan:
        delete_media_files(mid)
    return {"ok": True}


_proxy_locks: dict[str, threading.Lock] = {}


@app.api_route("/api/media/{mid}/preview-audio", methods=["GET", "HEAD"])
def preview_audio(mid: str):
    """Small mono WAV of a clip's sound for the editor's Web Audio playback (export uses the original)."""
    item = media_index().get(mid)
    if not item or not item.get("has_audio"):
        raise HTTPException(404)
    wav = MEDIA_DIR / mid / "preview_audio.wav"
    with _proxy_locks.setdefault(f"{mid}:audio", threading.Lock()):
        if not wav.exists():
            tmp = wav.with_suffix(".tmp.wav")
            r = run([FFMPEG, "-y", "-i", item["source"], "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(tmp)])
            if r.returncode != 0:
                raise HTTPException(500, "Could not extract audio")
            tmp.replace(wav)
    return FileResponse(wav, media_type="audio/wav")


@app.api_route("/api/media/{mid}/preview-webm", methods=["GET", "HEAD"])
def preview_webm(mid: str):
    """VP9 WebM copy (≤720p, no audio) for editors whose engine can't decode the original codec:
    Qt WebEngine on Linux has no H.264/HEVC, Edge WebView2 on Windows usually has no HEVC."""
    item = media_index().get(mid)
    if not item or item.get("kind") != "video":
        raise HTTPException(404)
    out = MEDIA_DIR / mid / "preview.webm"
    with _proxy_locks.setdefault(mid, threading.Lock()):
        if not out.exists():
            tmp = out.with_suffix(".tmp.webm")
            r = run([FFMPEG, "-y", "-i", item["source"], "-an", "-vf", "scale=-2:'min(720,ih)'",
                     "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1",
                     "-b:v", "2M", str(tmp)])
            if r.returncode != 0:
                raise HTTPException(500, "Could not create preview video")
            tmp.replace(out)
    return FileResponse(out, media_type="video/webm")


# ---------------------------------------------------------------- transcription

def parse_whisper_words(data: dict) -> list[dict]:
    words: list[dict] = []
    for seg in data.get("transcription", []):
        raw = seg.get("text", "")
        text = raw.strip()
        if not text or re.fullmatch(r"\[.*\]|\(.*\)", text):
            continue
        t0 = seg["offsets"]["from"] / 1000
        t1 = seg["offsets"]["to"] / 1000
        # Tokens that don't start with a space glue onto the previous word ("don" + "'t").
        if words and not raw.startswith(" ") and t0 - words[-1]["t1"] < 0.05:
            words[-1]["text"] += text
            words[-1]["t1"] = t1
        else:
            words.append({"t0": round(t0, 3), "t1": round(t1, 3), "text": text})
    return words


@app.post("/api/media/{mid}/transcribe")
def transcribe(mid: str, language: str = "auto", force: bool = False):
    idx = media_index()
    item = idx.get(mid)
    if not item:
        raise HTTPException(404, "Unknown media")
    if not item.get("has_audio"):
        return {"words": []}
    folder = MEDIA_DIR / mid
    cache = folder / f"words.{language}.json"
    if cache.exists() and not force:
        return {"words": load_json(cache, [])}

    model = find_whisper_model()
    if not model:
        raise HTTPException(409, "no_model")
    wav = folder / "audio16k.wav"
    r = run([FFMPEG, "-y", "-i", item["source"], "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)])
    if r.returncode != 0:
        raise HTTPException(500, "Audio extraction failed")
    out_base = folder / "whisper"
    r = run([WHISPER_CLI, "-m", model, "-f", str(wav), "-l", language, "-ml", "1", "-sow",
             "-oj", "-of", str(out_base), "-np"])
    wav.unlink(missing_ok=True)
    if r.returncode != 0:
        raise HTTPException(500, f"whisper-cli failed: {r.stderr[-400:]}")
    words = parse_whisper_words(load_json(out_base.with_suffix(".json"), {}))
    save_json(cache, words)
    return {"words": words}


# ---------------------------------------------------------------- projects
# Each project is projects/<id>.json; session.json remembers which one is open.
# Media is stored once and lists the projects whose media bin it is in ("projects": [ids]).

def project_path(pid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{6,32}", pid or ""):
        raise HTTPException(400, "Bad project id")
    return PROJECTS_DIR / f"{pid}.json"


def load_project(pid: str | None) -> dict | None:
    if not pid:
        return None
    try:
        return load_json(project_path(pid), None)
    except HTTPException:
        return None


def current_project_id() -> str | None:
    pid = load_json(SESSION_FILE, {}).get("current")
    if load_project(pid):
        return pid
    # The open project is gone: fall back to the most recently edited one.
    newest = max(PROJECTS_DIR.glob("*.json"), key=lambda f: f.stat().st_mtime, default=None)
    return newest.stem if newest else None


def set_current_project(pid: str):
    save_json(SESSION_FILE, {"current": pid})


def new_project_id() -> str:
    return uuid.uuid4().hex[:10]


def migrate_single_project():
    """Older versions kept one project in project.json and one shared media bin."""
    if not PROJECT_FILE.exists() or any(PROJECTS_DIR.glob("*.json")):
        return
    project = load_json(PROJECT_FILE, None)
    if not project:
        return
    pid = project.get("id") or new_project_id()
    project["id"] = pid
    save_json(PROJECTS_DIR / f"{pid}.json", project)
    with _lock:
        idx = media_index()
        for item in idx.values():
            item.setdefault("projects", [pid])
        save_json(MEDIA_INDEX, idx)
    set_current_project(pid)
    PROJECT_FILE.replace(PROJECT_FILE.with_name("project.before-projects.json"))


def delete_media_files(mid: str):
    shutil.rmtree(MEDIA_DIR / Path(mid).name, ignore_errors=True)


def project_summary(pid: str, project: dict, idx: dict) -> dict:
    clips = [c for t in project.get("tracks", []) for c in t.get("clips", [])]
    ends = [c["start"] + c["out"] - c["in"] for c in clips]
    first = next((idx.get(c["mediaId"]) for t in project.get("tracks", []) if t.get("main")
                  for c in sorted(t.get("clips", []), key=lambda c: c["start"])), None)
    return {
        "id": pid,
        "name": project.get("name") or "Untitled",
        "updated": (PROJECTS_DIR / f"{pid}.json").stat().st_mtime,
        "duration": max(ends, default=0),
        "aspect": project.get("settings", {}).get("aspect"),
        "thumb": (first or {}).get("thumb"),
    }


@app.get("/api/project")
def get_project():
    """The open project (with its "id"), or null when there are none yet."""
    pid = current_project_id()
    project = load_project(pid)
    if project:
        project["id"] = pid
    return project


@app.put("/api/project")
async def put_project(request: Request):
    project = await request.json()
    path = project_path(project.get("id", ""))
    if not path.exists():
        raise HTTPException(404, "Project was deleted")
    save_json(path, project)
    return {"ok": True}


@app.get("/api/projects")
def list_projects():
    idx = media_index()
    out = []
    for f in PROJECTS_DIR.glob("*.json"):
        project = load_json(f, None)
        if project:
            out.append(project_summary(f.stem, project, idx))
    return {"current": current_project_id(), "projects": sorted(out, key=lambda p: -p["updated"])}


@app.post("/api/projects")
async def create_project(request: Request):
    """Body: a fresh project (the client owns the default layout). Becomes the open project."""
    project = await request.json()
    pid = new_project_id()
    project["id"] = pid
    save_json(PROJECTS_DIR / f"{pid}.json", project)
    set_current_project(pid)
    return project


@app.post("/api/projects/{pid}/open")
def open_project(pid: str):
    if not load_project(pid):
        raise HTTPException(404, "Unknown project")
    set_current_project(pid)
    return {"ok": True}


@app.post("/api/projects/{pid}/duplicate")
def duplicate_project(pid: str):
    project = load_project(pid)
    if not project:
        raise HTTPException(404, "Unknown project")
    new = new_project_id()
    project.update(id=new, name=f"{project.get('name') or 'Untitled'} copy")
    save_json(PROJECTS_DIR / f"{new}.json", project)
    with _lock:
        idx = media_index()
        for item in idx.values():
            if pid in item.get("projects", []):
                item["projects"].append(new)
        save_json(MEDIA_INDEX, idx)
    return project_summary(new, project, idx)


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    path = project_path(pid)
    if not path.exists():
        raise HTTPException(404, "Unknown project")
    path.unlink()
    # Media that no other project uses goes too.
    orphans = []
    with _lock:
        idx = media_index()
        for mid, item in list(idx.items()):
            if pid in item.get("projects", []):
                item["projects"].remove(pid)
                if not item["projects"]:
                    orphans.append(mid)
                    del idx[mid]
        save_json(MEDIA_INDEX, idx)
    for mid in orphans:
        delete_media_files(mid)
    return {"ok": True, "current": current_project_id()}


# ---------------------------------------------------------------- export

def fmt(x: float) -> str:
    return f"{x:.4f}"


def build_export_cmd(project: dict, caption_list: Path | None, out: Path) -> tuple[list[str], float]:
    idx = media_index()
    S = project["settings"]
    W, H, FPS = int(S["width"]), int(S["height"]), int(S.get("fps", 30))
    W -= W % 2
    H -= H % 2

    clips = []  # (draw_order, track, clip, media)
    tracks = project["tracks"]
    # tracks[0] is drawn on top; draw from the bottom up.
    for order, tr in enumerate(reversed(tracks)):
        for c in tr["clips"]:
            m = idx.get(c["mediaId"])
            if m:
                clips.append((order, tr, c, m))
    ends = [c["start"] + (c["out"] - c["in"]) for _, _, c, _ in clips]
    for ct in project.get("captionTracks", []):
        ends += [s["end"] for s in ct.get("segments", [])]
    D = max(ends) if ends else 0
    if D <= 0:
        raise HTTPException(400, "Timeline is empty")

    args = [FFMPEG, "-y", "-hide_banner"]
    fc = [f"color=c=black:s={W}x{H}:r={FPS}:d={fmt(D)},format=yuv420p[base0]"]
    audio_labels = []
    last = "base0"
    n_in = 0
    for i, (_, tr, c, m) in enumerate(sorted(clips, key=lambda x: x[0])):
        dur = c["out"] - c["in"]
        if dur <= 0.01:
            continue
        if m["kind"] == "image":
            args += ["-loop", "1", "-framerate", str(FPS), "-t", fmt(dur), "-i", m["source"]]
        else:
            args += ["-ss", fmt(c["in"]), "-t", fmt(dur), "-i", m["source"]]
        k = n_in
        n_in += 1
        start = c["start"]
        visible = not tr.get("hidden") and not c.get("audioOnly") and m["kind"] in ("video", "image")
        if visible:
            scale = float(c.get("scale", 1))
            sw, sh = max(2, int(W * scale)) // 2 * 2, max(2, int(H * scale)) // 2 * 2
            ox, oy = float(c.get("x", 0)) * W, float(c.get("y", 0)) * H
            fc.append(
                f"[{k}:v]fps={FPS},scale={sw}:{sh}:force_original_aspect_ratio=decrease,setsar=1,"
                f"format=yuva420p,colorchannelmixer=aa={fmt(float(c.get('opacity', 1)))},"
                f"setpts=PTS-STARTPTS+{fmt(start)}/TB[v{k}]"
            )
            nxt = f"ov{k}"
            fc.append(
                f"[{last}][v{k}]overlay=x=(W-w)/2+{fmt(ox)}:y=(H-h)/2+{fmt(oy)}:eof_action=pass:"
                f"enable='between(t,{fmt(start)},{fmt(start + dur)})'[{nxt}]"
            )
            last = nxt
        vol = float(c.get("volume", 1))
        if m.get("has_audio") and not tr.get("muted") and vol > 0:
            delay = int(round(start * 1000))
            fades = ""
            fi = min(float(c.get("fadeIn", 0) or 0), dur)
            fo = min(float(c.get("fadeOut", 0) or 0), dur)
            if fi > 0:
                fades += f",afade=t=in:st=0:d={fmt(fi)}"
            if fo > 0:
                fades += f",afade=t=out:st={fmt(dur - fo)}:d={fmt(fo)}"
            fc.append(
                f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,"
                f"volume={fmt(vol)}{fades},adelay={delay}:all=1[a{k}]"
            )
            audio_labels.append(f"[a{k}]")

    if caption_list:
        args += ["-f", "concat", "-safe", "0", "-i", str(caption_list)]
        k = n_in
        n_in += 1
        fc.append(f"[{k}:v]format=rgba,scale={W}:{H}[cap]")
        fc.append(f"[{last}][cap]overlay=0:0:eof_action=pass:format=auto[capd]")
        last = "capd"
    fc.append(f"[{last}]format=yuv420p[vout]")

    fc.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{fmt(D)}[silence]")
    audio_labels.append("[silence]")
    fc.append(f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:normalize=0:duration=longest,"
              f"atrim=0:{fmt(D)}[aout]")

    args += ["-filter_complex", ";".join(fc), "-map", "[vout]", "-map", "[aout]",
             "-c:v", "libx264", "-preset", project.get("exportPreset", "veryfast"), "-crf", "20",
             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", fmt(D),
             "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(out)]
    return args, D


def run_export(job_id: str, cmd: list[str], duration: float, workdir: Path):
    job = jobs[job_id]
    job["status"] = "rendering"
    (workdir / "cmd.txt").write_text(" ".join(f"'{a}'" if " " in a or ";" in a else a for a in cmd), encoding="utf-8")
    errlog = open(workdir / "ffmpeg.log", "w", encoding="utf-8")
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errlog, text=True, encoding="utf-8",
                         errors="replace", **NO_WINDOW)
    for line in p.stdout:
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                t = int(line.split("=")[1]) / 1_000_000
                job["progress"] = max(0.0, min(0.999, t / duration))
            except ValueError:
                pass
    p.wait()
    errlog.close()
    if p.returncode == 0:
        job.update(status="done", progress=1.0)
        shutil.rmtree(workdir, ignore_errors=True)
    else:
        tail = (workdir / "ffmpeg.log").read_text(encoding="utf-8", errors="replace")[-1500:]
        job.update(status="error", error=tail)


@app.post("/api/export")
async def export(request: Request):
    form = await request.form(max_files=20000, max_fields=20000)
    project = json.loads(form["project"])
    manifest = json.loads(form.get("captions") or "[]")
    job_id = uuid.uuid4().hex[:8]
    workdir = WORK_DIR / job_id
    workdir.mkdir()

    caption_list = None
    if manifest:
        lines = ["ffconcat version 1.0"]
        for i, entry in enumerate(manifest):
            up = form[f"f{entry['file']}"]
            dest = workdir / f"cap{entry['file']:05d}.png"
            if not dest.exists():
                dest.write_bytes(await up.read())
            lines += [f"file '{dest.as_posix()}'", f"duration {entry['dur']:.4f}"]
        # concat demuxer needs the last file repeated for its duration to count.
        lines.append(f"file '{(workdir / ('cap%05d.png' % manifest[-1]['file'])).as_posix()}'")
        caption_list = workdir / "captions.txt"
        caption_list.write_text("\n".join(lines) + "\n", encoding="utf-8")

    name = re.sub(r"[^\w\-]+", "_", project.get("name") or "tinycutopus").strip("_") or "tinycutopus"
    out = EXPORT_DIR / f"{name}_{time.strftime('%Y%m%d-%H%M%S')}.mp4"
    cmd, D = build_export_cmd(project, caption_list, out)
    jobs[job_id] = {"status": "queued", "progress": 0.0, "file": out.name}
    threading.Thread(target=run_export, args=(job_id, cmd, D, workdir), daemon=True).start()
    return {"job": job_id}


@app.get("/api/export/{job_id}")
def export_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404)
    out = dict(job)
    if job["status"] == "done":
        out["url"] = f"/api/exports/{job['file']}"
        out["folder"] = str(EXPORT_DIR).replace(str(Path.home()), "~")
    return out


@app.get("/api/exports/{name}")
def download_export(name: str):
    path = EXPORT_DIR / Path(name).name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="video/mp4", filename=path.name)


# ---------------------------------------------------------------- speech model download

MODELS = {
    "base": {"label": "Fast", "size_mb": 148},
    "small": {"label": "Accurate", "size_mb": 488},
}
MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin"
model_job: dict = {"status": "idle"}


def download_model(name: str):
    dest = MODELS_DIR / f"ggml-{name}.bin"
    part = dest.with_suffix(".part")
    try:
        req = urllib.request.Request(MODEL_URL.format(name=name), headers={"User-Agent": "TinyCutOpus"})
        try:  # python.org / frozen builds ship without system CA roots
            import certifi
            ctx = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=30, context=ctx) as r, open(part, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            while chunk := r.read(1 << 20):
                f.write(chunk)
                done += len(chunk)
                model_job.update(done=done, total=total)
        # urllib doesn't raise when the connection drops early; a truncated model would be picked up forever.
        if total and done != total:
            raise IOError(f"Download interrupted ({done // 1_000_000} of {total // 1_000_000} MB)")
        part.replace(dest)
        model_job.update(status="done")
    except Exception as e:
        part.unlink(missing_ok=True)
        model_job.update(status="error", error=str(e))


@app.post("/api/model/download")
def start_model_download(name: str = "small"):
    if name not in MODELS:
        raise HTTPException(400, "Unknown model")
    if model_job.get("status") == "downloading":
        return model_job
    model_job.clear()
    model_job.update(status="downloading", name=name, done=0, total=MODELS[name]["size_mb"] * 1_000_000)
    threading.Thread(target=download_model, args=(name,), daemon=True).start()
    return model_job


@app.get("/api/model/download")
def model_download_status():
    return model_job


@app.get("/api/status")
def status():
    return {"whisper": bool(shutil.which(WHISPER_CLI)), "model": find_whisper_model(), "models": MODELS,
            "desktop": FROZEN or bool(os.getenv("TINYCUT_DESKTOP")), "exports": str(EXPORT_DIR)}


migrate_single_project()

app.mount("/files", StaticFiles(directory=DATA), name="files")
app.mount("/", StaticFiles(directory=BASE / "static", html=True), name="static")
