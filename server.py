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
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
MEDIA_DIR = DATA / "media"
EXPORT_DIR = DATA / "exports"
WORK_DIR = DATA / "work"
for d in (MEDIA_DIR, EXPORT_DIR, WORK_DIR):
    d.mkdir(parents=True, exist_ok=True)

MEDIA_INDEX = DATA / "media.json"
PROJECT_FILE = DATA / "project.json"

FFMPEG = os.getenv("FFMPEG_PATH", "ffmpeg")
FFPROBE = os.getenv("FFPROBE_PATH", "ffprobe")
WHISPER_CLI = os.getenv("WHISPER_CLI", shutil.which("whisper-cli") or "whisper-cli")

BROWSER_VIDEO_CODECS = {"h264", "hevc", "vp8", "vp9", "av1"}
BROWSER_CONTAINERS = {".mp4", ".mov", ".m4v", ".webm"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

app = FastAPI(title="TinyCutOpus")
_lock = threading.Lock()
jobs: dict[str, dict] = {}


# ---------------------------------------------------------------- helpers

def find_whisper_model() -> str | None:
    env = os.getenv("WHISPER_MODEL")
    if env and Path(env).exists():
        return env
    candidates = [
        BASE / "models",
        Path.home() / ".cache" / "whisper",
        Path.home() / "Desktop" / "NewEssayAutomator" / ".transcription-models",
        Path("/opt/homebrew/share/whisper-cpp"),
    ]
    prefs = ["ggml-large-v3-turbo", "ggml-medium", "ggml-small", "ggml-base", "ggml-tiny"]
    found = []
    for c in candidates:
        if c.is_dir():
            found += list(c.glob("ggml-*.bin"))
    for p in prefs:
        for f in found:
            if f.name.startswith(p):
                return str(f)
    return str(found[0]) if found else None


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def save_json(path: Path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(path)


def media_index() -> dict:
    return load_json(MEDIA_INDEX, {})


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


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
async def upload_media(file: UploadFile = File(...)):
    ext = Path(file.filename or "clip.mp4").suffix.lower() or ".mp4"
    mid = uuid.uuid4().hex[:10]
    folder = MEDIA_DIR / mid
    folder.mkdir()
    src = folder / f"source{ext}"
    with open(src, "wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)

    info = probe(src)
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
def list_media():
    return list(media_index().values())


@app.delete("/api/media/{mid}")
def delete_media(mid: str):
    with _lock:
        idx = media_index()
        if mid not in idx:
            raise HTTPException(404)
        del idx[mid]
        save_json(MEDIA_INDEX, idx)
    shutil.rmtree(MEDIA_DIR / mid, ignore_errors=True)
    return {"ok": True}


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
        raise HTTPException(500, "No whisper.cpp model found. Put a ggml-*.bin in ./models or set WHISPER_MODEL.")
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


# ---------------------------------------------------------------- project

@app.get("/api/project")
def get_project():
    return load_json(PROJECT_FILE, None)


@app.put("/api/project")
async def put_project(request: Request):
    save_json(PROJECT_FILE, await request.json())
    return {"ok": True}


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
    (workdir / "cmd.txt").write_text(" ".join(f"'{a}'" if " " in a or ";" in a else a for a in cmd))
    errlog = open(workdir / "ffmpeg.log", "w")
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errlog, text=True)
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
        tail = (workdir / "ffmpeg.log").read_text()[-1500:]
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
            lines += [f"file '{dest}'", f"duration {entry['dur']:.4f}"]
        # concat demuxer needs the last file repeated for its duration to count.
        lines.append(f"file '{workdir / ('cap%05d.png' % manifest[-1]['file'])}'")
        caption_list = workdir / "captions.txt"
        caption_list.write_text("\n".join(lines) + "\n")

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
    return out


@app.get("/api/exports/{name}")
def download_export(name: str):
    path = EXPORT_DIR / Path(name).name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="video/mp4", filename=path.name)


@app.get("/api/status")
def status():
    return {"whisper": bool(shutil.which(WHISPER_CLI)), "model": find_whisper_model()}


app.mount("/files", StaticFiles(directory=DATA), name="files")
app.mount("/", StaticFiles(directory=BASE / "static", html=True), name="static")
