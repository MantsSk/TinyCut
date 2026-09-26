"""End-to-end smoke test run *inside* the desktop app (any OS). Not bundled into the app.

    TINYCUT_SELFTEST=desktop/smoketest.py SMOKE_RESULT=result.json TINYCUT_DATA=<tmp> <app binary>

Imports a test clip, generates captions (downloading the Fast model on first run), exports,
then writes {"ok": bool, "log": [...]} to SMOKE_RESULT and closes the window.
"""

import json
import os
import time
import traceback
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(window):
    log, ok = [], False
    js = window.evaluate_js

    def note(*a):
        line = " ".join(str(x) for x in a)
        log.append(line)
        print("[smoke]", line, flush=True)

    def wait(expr, timeout, every=1.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                v = js(expr)
                if v:
                    return v
            except Exception:
                pass
            time.sleep(every)
        raise TimeoutError(f"timed out waiting for {expr}")

    try:
        wait("document.readyState === 'complete' && !!document.querySelector('#timeline .tl-inner')", 60)
        base = window.get_current_url()
        note("page loaded", base)
        note("native bridge:", wait("!!(window.pywebview && window.pywebview.api && window.pywebview.api.save_export)", 30))

        video = Path(os.getenv("SMOKE_VIDEO", HERE / "testdata" / "speech.mp4"))
        b = uuid.uuid4().hex
        body = (f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{video.name}"\r\n'
                f"Content-Type: video/mp4\r\n\r\n").encode() + video.read_bytes() + f"\r\n--{b}--\r\n".encode()
        req = urllib.request.Request(base + "api/media", data=body,
                                     headers={"Content-Type": f"multipart/form-data; boundary={b}"})
        note("import:", json.loads(urllib.request.urlopen(req).read())["kind"])

        js("location.reload()")
        time.sleep(2)
        wait("!!document.querySelector('.media-item .add')", 30)
        js("document.querySelector('.media-item .add').click()")
        note("clips on timeline:", wait("document.querySelectorAll('.tl-row.main .clip').length", 10))

        js("document.querySelector('.tabs button[data-tab=captions]').click()")
        js("document.querySelector('#genCaps').click()")
        wait("document.querySelector('[data-model=base]') || document.querySelectorAll('.tl-row.caption .seg').length", 30)
        js("document.querySelector('[data-model=base]') && document.querySelector('[data-model=base]').click()")
        t0 = time.time()
        segs = wait("document.querySelectorAll('.tl-row.caption .seg').length", 900, every=2)
        note(f"captions: {segs} in {time.time() - t0:.0f}s:",
             js("[...document.querySelectorAll('.tl-row.caption .seg')].map(s => s.textContent.trim()).join(' | ')"))

        js("document.querySelector('#exportBtn').click()")
        result = wait("(t => /ready|failed/.test(t) && t)(document.querySelector('#modalCard').innerText)", 600)
        note("export:", result.replace("\n", " ").strip()[:200])
        ok = "ready" in result and segs > 0
    except Exception:
        note("ERROR", traceback.format_exc())
    finally:
        out = os.getenv("SMOKE_RESULT")
        if out:
            Path(out).write_text(json.dumps({"ok": ok, "log": log}, indent=1), encoding="utf-8")
        window.destroy()
