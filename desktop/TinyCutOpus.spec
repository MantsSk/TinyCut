# PyInstaller spec for TinyCutOpus on macOS, Windows and Linux. Run via desktop/build.py.
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).parent
VERSION = (ROOT / "desktop" / "VERSION").read_text().strip()
IS_MAC, IS_WIN = sys.platform == "darwin", sys.platform == "win32"
EXE_SUFFIX = ".exe" if IS_WIN else ""

# The webview backend each platform uses (see desktop/app.py).
if IS_MAC:
    gui_imports = ["webview.platforms.cocoa"]
elif IS_WIN:
    gui_imports = ["webview.platforms.edgechromium", "webview.platforms.winforms", "clr"]
else:
    gui_imports = ["webview.platforms.qt", "qtpy", "PyQt6.QtWebEngineWidgets", "PyQt6.QtWebChannel"]

# Qt 6's X11 plugin needs libxcb-cursor, which several distros don't install by default.
extra_binaries = []
if sys.platform.startswith("linux"):
    for lib in ("/usr/lib/x86_64-linux-gnu/libxcb-cursor.so.0",):
        if Path(lib).exists():
            extra_binaries.append((lib, "PyQt6/Qt6/lib"))

a = Analysis(
    [str(ROOT / "desktop" / "app.py")],
    pathex=[str(ROOT)],
    binaries=[(str(ROOT / "vendor" / "bin" / f"{b}{EXE_SUFFIX}"), "bin") for b in ("ffmpeg", "ffprobe", "whisper-cli")]
    + extra_binaries,
    datas=[(str(ROOT / "static"), "static")],
    hiddenimports=["server", *collect_submodules("uvicorn"), *gui_imports],
    excludes=["tkinter", "PyInstaller", "pytest", "uvloop", "httptools", "watchfiles",
              "PySide2", "PySide6", "PyQt5"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="TinyCutOpus",
    console=False,
    icon=str(ROOT / "desktop" / ("icon.ico" if IS_WIN else "icon.icns")) if not sys.platform.startswith("linux") else None,
    target_arch="arm64" if IS_MAC else None,
    codesign_identity=None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="TinyCutOpus")

if IS_MAC:
    app = BUNDLE(
        coll,
        name="TinyCutOpus.app",
        icon=str(ROOT / "desktop" / "icon.icns"),
        bundle_identifier="com.tinycutopus.app",
        version=VERSION,
        info_plist={
            "CFBundleName": "TinyCutOpus",
            "CFBundleDisplayName": "TinyCutOpus",
            "CFBundleShortVersionString": VERSION,
            "CFBundleVersion": VERSION,
            "LSMinimumSystemVersion": "13.0",
            "LSApplicationCategoryType": "public.app-category.video",
            "NSHighResolutionCapable": True,
            "NSMicrophoneUsageDescription": "TinyCutOpus records voiceovers from your microphone.",
            # The editor UI is served from a local server on 127.0.0.1.
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        },
    )
