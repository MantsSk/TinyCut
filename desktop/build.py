#!/usr/bin/env python3
"""Build the TinyCutOpus desktop app for the OS this runs on.

    python3 desktop/build.py

    macOS (Apple Silicon) → dist/TinyCutOpus-<v>-mac-arm64.dmg
    Windows (x64)         → dist/TinyCutOpus-<v>-windows-x64-setup.exe  (+ portable .zip)
    Linux (x86_64)        → dist/TinyCutOpus-<v>-linux-x86_64.AppImage

PyInstaller can't cross-compile, so each installer is built on its own OS
(locally, or all three at once by .github/workflows/desktop.yml).

Optional macOS signing/notarization (Apple Developer account):
    SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" NOTARY_PROFILE=<notarytool profile>
"""

import gzip
import hashlib
import os
import platform
import shutil
import ssl
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "desktop"
VENDOR = ROOT / "vendor" / "bin"
DIST = ROOT / "dist"
BUILD = ROOT / "build"
VENV = ROOT / ".venv-build"
VERSION = (DESKTOP / "VERSION").read_text().strip()

OS = {"darwin": "mac", "win32": "windows"}.get(sys.platform, "linux")
ARCH = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}[platform.machine().lower()]
EXE = ".exe" if OS == "windows" else ""

# Static FFmpeg 6.0 builds from github.com/eugeneware/ffmpeg-static (release b6.1.1), checksum-pinned.
FFMPEG_URL = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/{name}.gz"
FFMPEG = {
    ("mac", "arm64"): {
        "ffmpeg": ("ffmpeg-darwin-arm64", "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa"),
        "ffprobe": ("ffprobe-darwin-arm64", "d986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be"),
    },
    ("windows", "x64"): {
        "ffmpeg": ("ffmpeg-win32-x64", "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77"),
        "ffprobe": ("ffprobe-win32-x64", "f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d"),
    },
    ("linux", "x64"): {
        "ffmpeg": ("ffmpeg-linux-x64", "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa"),
        "ffprobe": ("ffprobe-linux-x64", "25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067"),
    },
}
WHISPER_REPO = "https://github.com/ggml-org/whisper.cpp"
WHISPER_REF = "398997ed68095e39a6a0df3bc05c7dd880d0c607"
APPIMAGETOOL = ("https://github.com/AppImage/appimagetool/releases/download/1.9.0/appimagetool-x86_64.AppImage",
                "46fdd785094c7f6e545b61afcfb0f3d98d8eab243f644b4b17698c01d06083d1")
WEBVIEW2_BOOTSTRAPPER = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"


def step(msg):
    print(f"\n→ {msg}", flush=True)


def sh(*cmd, **kw):
    print("  $", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def download(url, dest: Path, sha256=None):
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "TinyCutOpus-build"})
    with urllib.request.urlopen(req, context=ctx) as r:
        data = r.read()
    if sha256 and hashlib.sha256(data).hexdigest() != sha256:
        sys.exit(f"Checksum mismatch for {url}")
    dest.write_bytes(data)
    return dest


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if OS == "windows" else "bin/python")


def ensure_build_venv():
    """Re-run this script inside an isolated venv with the desktop requirements."""
    if Path(sys.prefix).resolve() == VENV.resolve():
        return
    step("Preparing build environment (.venv-build)")
    if not venv_python().exists():
        sh(sys.executable, "-m", "venv", VENV)
    sh(venv_python(), "-m", "pip", "install", "-q", "--upgrade", "pip")
    sh(venv_python(), "-m", "pip", "install", "-q", "-r", ROOT / "requirements-desktop.txt")
    sys.exit(subprocess.run([str(venv_python()), __file__, *sys.argv[1:]]).returncode)


# ---------------------------------------------------------------- bundled binaries

def fetch_ffmpeg():
    table = FFMPEG.get((OS, ARCH))
    if not table:
        sys.exit(f"No FFmpeg build configured for {OS}-{ARCH}")
    for exe, (name, sha) in table.items():
        dest = VENDOR / f"{exe}{EXE}"
        if dest.exists():
            continue
        step(f"Downloading {exe}")
        gz = download(FFMPEG_URL.format(name=name), VENDOR / f"{name}.gz", sha)
        dest.write_bytes(gzip.decompress(gz.read_bytes()))
        gz.unlink()
        dest.chmod(0o755)


def build_whisper():
    dest = VENDOR / f"whisper-cli{EXE}"
    if dest.exists():
        return
    step("Building whisper.cpp (static)")
    cmake = shutil.which("cmake")
    if not cmake:
        sh(sys.executable, "-m", "pip", "install", "-q", "cmake")
        cmake = str(Path(sys.executable).parent / f"cmake{EXE}")
    src = Path(tempfile.mkdtemp()) / "whisper.cpp"
    sh("git", "init", "-q", src)
    sh("git", "-C", src, "fetch", "-q", "--depth", "1", WHISPER_REPO, WHISPER_REF)
    sh("git", "-C", src, "checkout", "-q", "FETCH_HEAD")
    flags = ["-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF",
             "-DWHISPER_BUILD_SERVER=OFF", "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF"]
    if OS == "mac":
        # GPU via Metal, shaders embedded in the binary.
        flags += ["-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON",
                  "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0"]
    else:
        # Portable x86-64 with AVX2 (any CPU from ~2013 on), CPU inference.
        flags += ["-DGGML_AVX=ON", "-DGGML_AVX2=ON", "-DGGML_FMA=ON", "-DGGML_F16C=ON"]
    if OS == "windows":
        flags += ["-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"]  # static CRT: no VC++ redist needed
    if OS == "linux":
        flags += ["-DCMAKE_EXE_LINKER_FLAGS=-static-libgcc -static-libstdc++"]
    sh(cmake, "-S", src, "-B", src / "build", *flags)
    sh(cmake, "--build", src / "build", "--config", "Release", "--target", "whisper-cli", "-j", str(os.cpu_count() or 4))
    built = next(p for p in (src / "build" / "bin" / f"whisper-cli{EXE}",
                             src / "build" / "bin" / "Release" / f"whisper-cli{EXE}") if p.exists())
    shutil.copy2(built, dest)
    shutil.rmtree(src.parent, ignore_errors=True)


def check_portable():
    """Refuse to ship binaries that depend on libraries users won't have."""
    for b in ("ffmpeg", "ffprobe", "whisper-cli"):
        path = VENDOR / f"{b}{EXE}"
        if OS == "mac":
            deps = subprocess.run(["otool", "-L", path], capture_output=True, text=True).stdout
            bad = [line for line in deps.splitlines()[1:] if "/opt/homebrew" in line or "/usr/local" in line]
        elif OS == "linux":
            deps = subprocess.run(["ldd", path], capture_output=True, text=True).stdout
            ok = ("linux-vdso", "libc.so", "libm.so", "libpthread", "libdl.so", "ld-linux", "librt.so",
                  "statically linked", "not a dynamic executable")
            bad = [line for line in deps.splitlines() if line.strip() and not any(k in line for k in ok)]
        else:
            bad = []
        if bad:
            sys.exit(f"{b} links to non-system libraries:\n" + "\n".join(bad))


# ---------------------------------------------------------------- packaging

def pyinstaller():
    step("Running PyInstaller")
    shutil.rmtree(DIST / "TinyCutOpus", ignore_errors=True)
    shutil.rmtree(DIST / "TinyCutOpus.app", ignore_errors=True)
    sh(sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--log-level", "WARN",
       "--workpath", BUILD / "pyinstaller", "--distpath", DIST, DESKTOP / "TinyCutOpus.spec")


def package_mac():
    app = DIST / "TinyCutOpus.app"
    identity = os.getenv("SIGN_IDENTITY")
    step("Signing " + ("with " + identity if identity else "ad-hoc"))
    if identity:
        sh("codesign", "--force", "--deep", "--timestamp", "--options", "runtime",
           "--entitlements", DESKTOP / "entitlements.plist", "--sign", identity, app)
    else:
        sh("codesign", "--force", "--deep", "--sign", "-", app)
    sh("codesign", "--verify", "--deep", "--strict", app)

    step("Creating DMG")
    dmg = DIST / f"TinyCutOpus-{VERSION}-mac-arm64.dmg"
    stage = Path(tempfile.mkdtemp())
    shutil.copytree(app, stage / app.name, symlinks=True)
    (stage / "Applications").symlink_to("/Applications")
    dmg.unlink(missing_ok=True)
    sh("hdiutil", "create", "-quiet", "-volname", "TinyCutOpus", "-srcfolder", stage,
       "-fs", "HFS+", "-format", "UDZO", "-ov", dmg)
    shutil.rmtree(stage)
    if identity and os.getenv("NOTARY_PROFILE"):
        step("Notarizing")
        sh("codesign", "--sign", identity, "--timestamp", dmg)
        sh("xcrun", "notarytool", "submit", dmg, "--keychain-profile", os.environ["NOTARY_PROFILE"], "--wait")
        sh("xcrun", "stapler", "staple", dmg)
    return [dmg]


def package_windows():
    folder = DIST / "TinyCutOpus"
    step("Creating portable zip")
    portable = DIST / f"TinyCutOpus-{VERSION}-windows-x64-portable.zip"
    with zipfile.ZipFile(portable, "w", zipfile.ZIP_DEFLATED) as z:
        for f in folder.rglob("*"):
            z.write(f, Path("TinyCutOpus") / f.relative_to(folder))

    step("Creating installer (Inno Setup)")
    iscc = shutil.which("iscc") or r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
    if not Path(iscc).exists():
        print("  Inno Setup not found — install it (choco install innosetup) for the setup.exe; portable zip is ready.")
        return [portable]
    BUILD.mkdir(exist_ok=True)
    download(WEBVIEW2_BOOTSTRAPPER, BUILD / "MicrosoftEdgeWebview2Setup.exe")
    sh(iscc, f"/DAppVersion={VERSION}", f"/DRoot={ROOT}", DESKTOP / "windows" / "TinyCutOpus.iss")
    return [DIST / f"TinyCutOpus-{VERSION}-windows-x64-setup.exe", portable]


def package_linux():
    step("Creating AppImage")
    appdir = BUILD / "AppDir"
    shutil.rmtree(appdir, ignore_errors=True)
    shutil.copytree(DIST / "TinyCutOpus", appdir / "usr" / "lib" / "tinycutopus", symlinks=True)
    shutil.copy(DESKTOP / "linux" / "tinycutopus.desktop", appdir / "tinycutopus.desktop")
    shutil.copy(DESKTOP / "icon-512.png", appdir / "tinycutopus.png")
    icons = appdir / "usr" / "share" / "icons" / "hicolor" / "512x512" / "apps"
    icons.mkdir(parents=True)
    shutil.copy(DESKTOP / "icon-512.png", icons / "tinycutopus.png")
    apprun = appdir / "AppRun"
    apprun.write_text('#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\n'
                      'exec "$HERE/usr/lib/tinycutopus/TinyCutOpus" "$@"\n')
    apprun.chmod(0o755)
    tool = BUILD / "appimagetool.AppImage"
    if not tool.exists():
        download(*APPIMAGETOOL[:1], tool, APPIMAGETOOL[1])
        tool.chmod(0o755)
    out = DIST / f"TinyCutOpus-{VERSION}-linux-x86_64.AppImage"
    sh(tool, "--appimage-extract-and-run", "--no-appstream", appdir, out, env={**os.environ, "ARCH": "x86_64"})
    return [out]


def main():
    ensure_build_venv()
    print(f"TinyCutOpus {VERSION} · {OS}-{ARCH}")
    VENDOR.mkdir(parents=True, exist_ok=True)
    DIST.mkdir(exist_ok=True)
    fetch_ffmpeg()
    build_whisper()
    check_portable()
    pyinstaller()
    outputs = {"mac": package_mac, "windows": package_windows, "linux": package_linux}[OS]()
    print()
    for o in outputs:
        print(f"✓ {o.relative_to(ROOT)}  ({o.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
