from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageChops
except ModuleNotFoundError as error:
    raise SystemExit(
        "Pillow is required for TUI evidence capture. Run: python -m pip install Pillow"
    ) from error


SCENARIOS = (
    "wide-live",
    "standard-live",
    "narrow-live",
    "blocked",
    "failed",
    "complete",
    "reduced-motion",
)
ANIMATION_FRAMES = tuple(f"animation-{index}" for index in range(10))

# Capture pages paint a single solid background so screenshots can be cropped
# tightly to content, then quantized to a small palette. This keeps committed
# PNG/GIF evidence well under the review upload budget without losing detail.
SOLID_BG = (5, 8, 13)
PAD = 16
MAX_WIDTH_PNG = 1200
MAX_WIDTH_GIF = 620
PNG_COLORS = 64
GIF_COLORS = 128
WINDOW = "1120,760"


def validate_execution_manifest(directory: Path) -> None:
    manifest_path = directory / "execution-manifest.json"
    if not manifest_path.is_file():
        raise SystemExit("TUI evidence is missing execution-manifest.json.")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        raise SystemExit(f"TUI evidence manifest is invalid: {error}") from error

    expected_assets = set((*SCENARIOS, *ANIMATION_FRAMES))
    actual_assets = {
        asset.get("id")
        for asset in manifest.get("assets", [])
        if isinstance(asset, dict)
    }
    if actual_assets != expected_assets:
        missing = sorted(expected_assets - actual_assets)
        extra = sorted(actual_assets - expected_assets)
        raise SystemExit(
            f"TUI evidence manifest asset mismatch; missing={missing}, extra={extra}"
        )
    if manifest.get("onboardingCommand") != "npm run dev -- --sandbox happy-path":
        raise SystemExit("TUI evidence manifest is not bound to the onboarding command.")
    if not re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("sourceSha", ""))):
        raise SystemExit("TUI evidence manifest has an invalid source SHA.")
    executed_scenarios = {
        execution.get("scenarioId")
        for execution in manifest.get("executions", [])
        if isinstance(execution, dict)
    }
    required_scenarios = {
        "happy-path",
        "apply-happy-path",
        "github-lookup-failure",
    }
    if not required_scenarios.issubset(executed_scenarios):
        raise SystemExit("TUI evidence manifest is missing required executed scenarios.")


def browser_path() -> Path:
    candidates = [
        shutil.which("msedge"),
        shutil.which("microsoft-edge"),
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise SystemExit(
        "A Chromium browser is required for TUI evidence capture "
        "(Edge, Chrome, or Chromium)."
    )


def capture(
    browser: Path, profile_directory: Path, html_path: Path, png_path: Path
) -> None:
    subprocess.run(
        [
            str(browser),
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--disable-extensions",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-component-update",
            "--disable-sync",
            "--metrics-recording-only",
            "--no-pings",
            "--disable-features=Translate,MediaRouter",
            f"--user-data-dir={profile_directory}",
            f"--window-size={WINDOW}",
            f"--screenshot={png_path}",
            html_path.resolve().as_uri(),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=120,
    )
    if not png_path.is_file() or png_path.stat().st_size == 0:
        raise SystemExit(f"Browser did not create screenshot: {png_path}")


def content_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    background = Image.new("RGB", image.size, SOLID_BG)
    bbox = ImageChops.difference(image.convert("RGB"), background).getbbox()
    if bbox is None:
        raise SystemExit("Capture produced an empty frame with no visible content.")
    return bbox


def union_bbox(
    a: tuple[int, int, int, int], b: tuple[int, int, int, int]
) -> tuple[int, int, int, int]:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def frame_on_canvas(image: Image.Image, bbox: tuple[int, int, int, int]) -> Image.Image:
    cropped = image.convert("RGB").crop(bbox)
    canvas = Image.new(
        "RGB", (cropped.width + 2 * PAD, cropped.height + 2 * PAD), SOLID_BG
    )
    canvas.paste(cropped, (PAD, PAD))
    return canvas


def downscale(image: Image.Image, max_width: int) -> Image.Image:
    if image.width <= max_width:
        return image
    height = round(image.height * max_width / image.width)
    return image.resize((max_width, height), Image.Resampling.LANCZOS)


def write_scenario(directory: Path, name: str) -> None:
    source = directory / f"{name}.png"
    with Image.open(source) as raw:
        framed = downscale(frame_on_canvas(raw, content_bbox(raw)), MAX_WIDTH_PNG)
    quantized = framed.quantize(
        colors=PNG_COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    quantized.save(source, optimize=True)


def write_animation(directory: Path) -> None:
    frame_paths = [directory / f"{name}.png" for name in ANIMATION_FRAMES]
    originals = [Image.open(path).convert("RGB") for path in frame_paths]
    bbox = content_bbox(originals[0])
    for frame in originals[1:]:
        bbox = union_bbox(bbox, content_bbox(frame))
    framed = [
        downscale(frame_on_canvas(frame, bbox), MAX_WIDTH_GIF) for frame in originals
    ]
    palette_source = Image.new(
        "RGB",
        (max(frame.width for frame in framed), sum(frame.height for frame in framed)),
        SOLID_BG,
    )
    offset = 0
    for frame in framed:
        palette_source.paste(frame, (0, offset))
        offset += frame.height
    palette = palette_source.quantize(
        colors=GIF_COLORS, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE
    )
    quantized = [
        frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in framed
    ]
    quantized[0].save(
        directory / "live-progress.gif",
        save_all=True,
        append_images=quantized[1:],
        duration=90,
        loop=0,
        optimize=True,
        disposal=2,
    )
    for frame in originals:
        frame.close()
    for frame_path in frame_paths:
        frame_path.unlink()


def main() -> None:
    directory = Path(
        sys.argv[1] if len(sys.argv) > 1 else "test/bdd/features/evidence/tui"
    ).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    validate_execution_manifest(directory)
    browser = browser_path()

    with tempfile.TemporaryDirectory(prefix="tui-evidence-") as profile:
        profile_directory = Path(profile)
        for name in (*SCENARIOS, *ANIMATION_FRAMES):
            capture(
                browser,
                profile_directory,
                directory / f"{name}.html",
                directory / f"{name}.png",
            )

    for name in SCENARIOS:
        write_scenario(directory, name)
    write_animation(directory)
    for html_path in directory.glob("*.html"):
        html_path.unlink()

    for evidence_path in sorted(directory.iterdir()):
        size_kb = evidence_path.stat().st_size / 1024
        print(f"{evidence_path.name:<24} {size_kb:8.1f} KB")


if __name__ == "__main__":
    main()
