#!/usr/bin/env bash
# 重新生成 s02 tool round-trip 动图。
set -euo pipefail
cd "$(dirname "$0")"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
for i in $(seq 4 119); do
  n=$(printf '%03d' "$i")
  playwright screenshot --channel=chrome --viewport-size="1280,720" --wait-for-timeout=100 \
    "file://$PWD/s02-tools.html?capture=1&frame=$i" "$out/frame_$n.png" >/dev/null
done
gifski --fps 10 --width 1120 --quality 92 --repeat 0 -o s02-tools.gif "$out"/frame_*.png
ffmpeg -y -loglevel error -framerate 10 -i "$out/frame_%03d.png" \
  -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart s02-tools.mp4
cp "$out/frame_070.png" s02-tools-poster.png
printf 'wrote s02-tools.gif, s02-tools.mp4, s02-tools-poster.png\n'
