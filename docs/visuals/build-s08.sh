#!/usr/bin/env bash
# 重新生成 s08 inbox / steering 动图。
set -euo pipefail
cd "$(dirname "$0")"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
for i in $(seq 4 119); do
  n=$(printf '%03d' "$i")
  playwright screenshot --channel=chrome --viewport-size="1280,720" --wait-for-timeout=100 \
    "file://$PWD/s08-inbox.html?capture=1&frame=$i" "$out/frame_$n.png" >/dev/null
done
gifski --fps 10 --width 1120 --quality 92 --repeat 0 -o s08-inbox.gif "$out"/frame_*.png
ffmpeg -y -loglevel error -framerate 10 -i "$out/frame_%03d.png" \
  -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart s08-inbox.mp4
cp "$out/frame_080.png" s08-inbox-poster.png
printf 'wrote s08-inbox.gif, s08-inbox.mp4, s08-inbox-poster.png\n'
