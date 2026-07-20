# Douyin Creator Archiver

Mac-first source-code toolkit for archiving public Douyin creator metadata, covers, media, and voice transcripts.

It provides:

- A zero-dependency Node.js CLI.
- A dedicated Chrome profile for Douyin login.
- Serial, stable browser automation through Chrome DevTools Protocol.
- Creator-page video discovery.
- Per-video structured metadata: title, publish time, likes, favorites, comments, shares, cover URL, and duration.
- A default qualification standard of `like_count >= 1000`; missing like counts are excluded rather than treated as zero.
- Known video URL archiving for upstream ingest queues.
- Cover download, video download, and optional audio extraction.
- Optional local Whisper voice transcription.
- A Codex-compatible skill under `skills/douyin-creator-archiver/`.

## Responsible Use

Use this only for content you own, are authorized to archive, or may lawfully process. The tool does not bypass paywalls, DRM, login challenges, CAPTCHA, rate limits, or platform restrictions. It stores browser cookies locally in your chosen Chrome profile and never prints cookie values.

## Mac Requirements

- macOS with Google Chrome installed.
- Node.js 22.5 or newer.
- `ffmpeg` for audio extraction.
- `curl`, included with macOS.

Optional bootstrap check:

```bash
./scripts/bootstrap-mac.sh
```

## Install

```bash
git clone https://github.com/Evander764/douyin-creator-archiver.git
cd douyin-creator-archiver
npm test
npm link
dyca doctor
```

## Login Once

The tool uses its own Chrome profile by default:

`~/Library/Application Support/Douyin Creator Archiver/chrome-profile`

Open Douyin and log in:

```bash
dyca login
```

Finish login or verification in the Chrome window, then return to the terminal.

## Archive a Creator

```bash
dyca archive \
  --creator-url "https://www.douyin.com/user/..." \
  --out ./douyin-archive \
  --limit 50 \
  --min-likes 1000 \
  --mode both \
  --transcribe true \
  --whisper-model /absolute/path/to/ggml-small-q5_1.bin
```

## Archive Known Video URLs

When another ingest tool has already found exact Douyin video URLs, skip creator-page discovery and archive those rows directly:

```bash
dyca archive-urls \
  --input ./pending-ingest-items.jsonl \
  --out ./douyin-archive-urls \
  --limit 20 \
  --mode audio
```

The input is JSONL and defaults to `source_url` for the URL and `title` for the title. Use `--url-field` or `--title-field` if your rows use different keys.

Modes:

- `video`: save video files only.
- `audio`: save extracted `.m4a` audio only.
- `both`: save video and audio.

Outputs:

```text
douyin-archive/
  creator-videos.json
  creator-videos.jsonl
  videos/
  audio/
  covers/
  transcripts/
  logs/
```

## Agent Workflow

1. Run `dyca doctor`.
2. Run `dyca login` if the profile is not logged into Douyin.
3. Run `dyca list --creator-url ... --limit ...` to inspect discovered videos.
4. Run `dyca archive --creator-url ... --mode audio|video|both`.
5. For an upstream queue, run `dyca archive-urls --input pending-ingest-items.jsonl --mode audio`.
6. Summarize `creator-videos.json` and report failed items from `logs/archive-report.json`.

## CLI Reference

```bash
dyca doctor
dyca login [--profile-dir PATH] [--port 9533]
dyca list --creator-url URL [--out DIR] [--limit N] [--min-likes N] [--scroll-rounds N]
dyca archive --creator-url URL [--out DIR] [--limit N] [--min-likes N] [--mode audio|video|both]
dyca archive-urls --input ROWS.jsonl [--out DIR] [--limit N] [--min-likes N] [--mode audio|video|both]
```

Important options:

- `--profile-dir`: Chrome user data directory. Defaults to app-owned profile under Application Support.
- `--chrome-path`: Chrome executable path. Defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- `--port`: CDP port. Defaults to `9533`.
- `--delay-ms`: delay between videos. Defaults to `2500`.
- `--min-likes`: minimum red-heart/like count. Defaults to `1000` and is inclusive. Missing values are excluded.
- `--visible false`: run Chrome without `--new-window` visibility hints. Login still requires visible Chrome.
- `--covers false`: skip cover downloads. Covers are downloaded by default.
- `--transcribe true`: generate voice transcripts with local `whisper-cli`.
- `--whisper-model PATH`: absolute path to a whisper.cpp model. Can also use `DYCA_WHISPER_MODEL`.

Each `creator-videos.jsonl` row can include:

```json
{
  "id": "7597073908935789850",
  "title": "...",
  "publish_time": "...",
  "like_count": 641,
  "favorite_count": 76,
  "comment_count": 11,
  "share_count": 122,
  "cover_url": "...",
  "download_url": "...",
  "metadata_status": "structured"
}
```

## Completeness Boundary

`logs/list-report.json` records how creator discovery stopped. The collector watches the creator page's own `aweme/post` responses while scrolling and records `cursor` plus `has_more`. It sets `complete: true` only when pagination was observed, `has_more=false`, and the requested `--limit` did not stop the run first. Otherwise `observed_count` remains non-authoritative.

The final `creator-videos.jsonl` contains only videos meeting `like_count >= --min-likes`. `logs/list-report.json.like_standard` records observed, qualified, below-threshold, and missing-metric counts. Account completeness and threshold qualification are separate: a threshold result is authoritative for the full account only when `complete=true`.

Voice transcripts cover spoken audio only. Text visible in silent frames, slides, or burned-in subtitles requires a separate OCR pass.

## Known Limits

- Douyin may require login or verification at any time.
- Some creator pages lazy-load slowly or hide older posts.
- Some media URLs expire quickly.
- Large videos may take several minutes; downloads use resume and retries.
- The default workflow is serial for stability, not speed.
- Metrics are a capture-time snapshot and can change later.

## Codex Skill

Copy or symlink the skill folder:

```bash
mkdir -p ~/.codex/skills
ln -s "$(pwd)/skills/douyin-creator-archiver" ~/.codex/skills/douyin-creator-archiver
```

Then ask Codex to use the Douyin Creator Archiver skill.
