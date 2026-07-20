#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$project_dir/package.json').version")"
dist_dir="$project_dir/dist"
stage_root="$(mktemp -d /tmp/dyca-package.XXXXXX)"
stage_dir="$stage_root/douyin-creator-archiver-v$version"
archive="$dist_dir/douyin-creator-archiver-v$version-source.zip"
temp_archive="$stage_root/douyin-creator-archiver-v$version-source.zip"

cleanup() {
  rm -rf "$stage_root"
}
trap cleanup EXIT

mkdir -p "$stage_dir" "$dist_dir"
rsync -a \
  --exclude '.git' \
  --exclude 'dist' \
  --exclude 'node_modules' \
  --exclude 'douyin-archive*' \
  --exclude '*.partial' \
  "$project_dir/" "$stage_dir/"

(cd "$stage_root" && /usr/bin/zip -qry "$temp_archive" "$(basename "$stage_dir")")
mv "$temp_archive" "$archive"
/usr/bin/shasum -a 256 "$archive" > "$archive.sha256"
echo "$archive"
