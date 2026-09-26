"""TinyCutOpus desktop app: runs the local server and shows the editor in a native window.

Dev:      .venv/bin/python desktop/app.py
Packaged: built for macOS, Windows and Linux by desktop/build.py (PyInstaller).
"""

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

APP_NAME = "TinyCutOpus"
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
IS_MAC, IS_WIN = sys.platform == "darwin", sys.platform == "win32"
EXE = ".exe" if IS_WIN else ""


def user_dirs() -> tuple[Path, Path]:
    """(app data folder, exports folder) following each OS's conventions."""
    home = Path.home()
    if IS_MAC:
        return home / "Library" / "Application Support" / APP_NAME, home / "Movies" / APP_NAME
    if IS_WIN:
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        return local / APP_NAME, home / "Videos" / APP_NAME
    data = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    videos = home / "Videos"
    try:  # honour a localised XDG videos folder when available
        out = subprocess.run(["xdg-user-dir", "VIDEOS"], capture_output=True, text=True, timeout=2).stdout.strip()
        if out and out != str(home):
            videos = Path(out)
    except Exception:
        pass
    return data / APP_NAME, videos / APP_NAME


def configure_env():
    """Point the server at per-user folders and the bundled ffmpeg/whisper binaries."""
    data, exports = user_dirs()
    os.environ.setdefault("TINYCUT_DATA", str(data))
    os.environ.setdefault("TINYCUT_EXPORTS", str(exports))
    os.environ["TINYCUT_DESKTOP"] = "1"
    # Bundled binaries live in <bundle>/bin (packaged) or vendor/bin (dev, after build.py).
    for bindir in (ROOT / "bin", ROOT / "vendor" / "bin"):
        for exe, var in (("ffmpeg", "FFMPEG_PATH"), ("ffprobe", "FFPROBE_PATH"), ("whisper-cli", "WHISPER_CLI")):
            if (bindir / f"{exe}{EXE}").exists():
                os.environ.setdefault(var, str(bindir / f"{exe}{EXE}"))
    if sys.platform.startswith("linux") and getattr(sys, "frozen", False):
        # Chromium's sandbox can't initialise inside an AppImage / on locked-down user namespaces.
        os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(port: int):
    import uvicorn
    from server import app  # imported after configure_env() so it sees the paths

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                            loop="asyncio", http="h11", lifespan="off")
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(200):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=0.5)
            return
        except Exception:
            time.sleep(0.05)
    raise RuntimeError("Local server did not start")


class Api:
    """Native helpers exposed to the page as window.pywebview.api.*"""

    def __init__(self):
        self.window = None

    def _save_dialog(self, name: str):
        import webview
        exports = os.environ["TINYCUT_EXPORTS"]
        res = self.window.create_file_dialog(webview.SAVE_DIALOG, directory=exports, save_filename=name)
        if not res:
            return None
        return res if isinstance(res, str) else res[0]

    def save_export(self, filename: str):
        """Copy a finished export somewhere the user picks."""
        src = Path(os.environ["TINYCUT_EXPORTS"]) / Path(filename).name
        dest = self._save_dialog(src.name)
        if not dest:
            return None
        shutil.copyfile(src, dest)
        return dest

    def save_text(self, name: str, content: str):
        dest = self._save_dialog(name)
        if not dest:
            return None
        Path(dest).write_text(content, encoding="utf-8")
        return dest

    def reveal_export(self, filename: str):
        path = Path(os.environ["TINYCUT_EXPORTS"]) / Path(filename).name
        if IS_MAC:
            subprocess.run(["open", "-R", str(path)])
        elif IS_WIN:
            subprocess.run(["explorer", f"/select,{path}"])
        else:
            subprocess.run(["xdg-open", str(path.parent)])

    def open_url(self, url: str):
        if url.startswith(("https://", "http://")):
            import webbrowser
            webbrowser.open(url)


def patch_cmd_shortcuts():
    """pywebview swallows ⌘Z / ⌘A natively; hand ⌘Z / ⇧⌘Z / ⌘Y / ⌘E / ⌘A to the page so the editor's
    undo and select-all work (the page selects text itself when a text field is focused)."""
    try:
        import AppKit
        import objc
        from webview.platforms import cocoa
    except ImportError:
        return
    host = cocoa.BrowserView.WebKitHost
    original = host.keyDown_

    def keyDown_(self, event):
        if event.modifierFlags() & AppKit.NSCommandKeyMask:
            key = (event.charactersIgnoringModifiers() or "").lower()
            if key in ("z", "y", "e", "a"):
                objc.super(host, self).keyDown_(event)
                return
        original(self, event)

    host.keyDown_ = keyDown_


def main():
    configure_env()
    sys.path.insert(0, str(ROOT))
    import webview

    port = free_port()
    start_server(port)
    if IS_MAC:
        patch_cmd_shortcuts()
    api = Api()
    window = webview.create_window(
        APP_NAME, f"http://127.0.0.1:{port}/", js_api=api,
        width=1480, height=920, min_size=(1100, 700), background_color="#101114",
    )
    api.window = window
    # macOS: system WebKit · Windows: Edge WebView2 · Linux: Qt WebEngine (bundled Chromium).
    gui = os.getenv("PYWEBVIEW_GUI") or ("qt" if sys.platform.startswith("linux") else None)
    icon = str(ROOT / "static" / "icon.png")
    selftest = os.getenv("TINYCUT_SELFTEST")
    if selftest:  # dev only: path to a script defining run(window)
        import runpy
        webview.start(runpy.run_path(selftest)["run"], (window,), gui=gui, icon=icon, private_mode=False)
    else:
        webview.start(gui=gui, icon=icon, private_mode=False)


if __name__ == "__main__":
    main()
