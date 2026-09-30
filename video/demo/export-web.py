"""
Derives the web and README assets from the final render.

    python3 export-web.py [renders/anythingmcp-demo-lumen-clay-en.mp4]

Writes renders/web/:
  demo.mp4 / demo.webm           full film with sound, for the theatre player
  demo-preview.mp4 / .webm       silent 23 s highlight loop for the page background (product footage only)
  demo-poster.jpg                poster frame
  demo.gif                       README loop (under 10 MB)
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "renders/anythingmcp-demo-lumen-clay-en.mp4"
OUT = HERE / "renders/web"
OUT.mkdir(parents=True, exist_ok=True)

# Highlight loop: (start, end, speed) in seconds of the final render.
HIGHLIGHTS = [
    (2.9, 7.1, 1.0),      # chips snap onto the hub: "Connect anything. In minutes."
    (9.6, 13.2, 1.5),     # Etsy: Marketplace, search
    (28.6, 31.0, 1.0),    # Etsy: 9 tools
    (44.9, 48.0, 1.0),    # SAP: test connection, 42 services
    (63.4, 66.2, 1.0),    # OpenAPI: 12 tools on the server
    (78.2, 81.0, 1.0),    # Claude: approve access
    (96.6, 100.6, 1.0),   # Claude: Etsy answer table
    (136.3, 139.4, 1.0),  # finale: tool chips light up
    (140.0, 145.0, 1.0),  # finale: the answer table
    (156.6, 159.8, 1.0),  # logo lockup
]
XFADE = 0.35
POSTER_AT = 142.5   # the finale answer table
# The site plays the loop behind its own headline, so it keeps to product
# footage: no title card or logo lockup to compete with the page's type.
BACKGROUND = HIGHLIGHTS[1:-1]


def run(*args: str) -> None:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *args], check=True)


def size(p: Path) -> str:
    return f"{p.stat().st_size / 1e6:.1f} MB"


# Full film, with sound.
run("-i", str(SRC), "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(OUT / "demo.mp4"))
run("-i", str(SRC), "-c:v", "libsvtav1", "-preset", "6", "-crf", "36", "-pix_fmt", "yuv420p",
    "-c:a", "libopus", "-b:a", "96k", str(OUT / "demo.webm"))

# Highlight loops, silent: trim, retime, crossfade.
def loop(cuts, out: Path) -> Path:
    inputs: list[str] = []
    chains: list[str] = []
    lengths: list[float] = []
    for i, (a, b, speed) in enumerate(cuts):
        inputs += ["-ss", str(a), "-t", str(b - a), "-i", str(SRC)]
        chains.append(f"[{i}:v]setpts=(PTS-STARTPTS)/{speed},fps=30,format=yuv420p[s{i}]")
        lengths.append((b - a) / speed)
    graph = ";".join(chains)
    prev, offset = "s0", lengths[0]
    for i in range(1, len(cuts)):
        offset -= XFADE
        graph += f";[{prev}][s{i}]xfade=transition=fade:duration={XFADE}:offset={offset:.3f}[x{i}]"
        prev, offset = f"x{i}", offset + lengths[i]
    run(*inputs, "-filter_complex", graph, "-map", f"[{prev}]", "-an", "-c:v", "libx264", "-crf", "14", "-preset", "medium", str(out))
    return out


highlight = loop(HIGHLIGHTS, OUT / "highlight-master.mp4")
background = loop(BACKGROUND, OUT / "background-master.mp4")

run("-i", str(background), "-vf", "scale=1280:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-maxrate", "700k",
    "-bufsize", "1400k", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", str(OUT / "demo-preview.mp4"))
run("-i", str(background), "-vf", "scale=1280:-2", "-c:v", "libsvtav1", "-preset", "6", "-crf", "42", "-pix_fmt", "yuv420p",
    "-an", str(OUT / "demo-preview.webm"))

# Poster.
run("-ss", str(POSTER_AT), "-i", str(SRC), "-frames:v", "1", "-q:v", "3", str(OUT / "demo-poster.jpg"))

# README GIF: gifski from PNG frames, shrinking until it fits under 10 MB.
frames = OUT / "gif-frames"
for width, fps, quality in [(960, 12, 70), (880, 12, 65), (800, 10, 60), (720, 10, 55)]:
    subprocess.run(["rm", "-rf", str(frames)], check=True)
    frames.mkdir()
    run("-i", str(highlight), "-vf", f"fps={fps},scale={width}:-2:flags=lanczos", str(frames / "f%04d.png"))
    gif = OUT / "demo.gif"
    subprocess.run(["gifski", "--quiet", "--fps", str(fps), "--width", str(width), "--quality", str(quality),
                    "-o", str(gif), *sorted(str(p) for p in frames.glob("f*.png"))], check=True)
    if gif.stat().st_size < 9.5e6:
        break
subprocess.run(["rm", "-rf", str(frames)], check=True)

for p in sorted(OUT.iterdir()):
    print(f"{p.name:28s} {size(p)}")
