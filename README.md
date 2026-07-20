# Douyin Creator Archiver

Mac-first source-code toolkit for searching public Douyin videos and archiving creator metadata, media, and voice transcripts.

It provides:

- A zero-dependency Node.js CLI.
- A dedicated Chrome profile for Douyin login.
- Serial, stable browser automation through Chrome DevTools Protocol.
- Creator-page video discovery.
- Keyword search through the visible Douyin search box and search button, never by guessing a search URL.
- Per-video structured metadata including `statistics.digg_count` as `red_heart_count`.
- Keyword rules: `red_heart_count > 1000`, publication within 14 days, 10 qualified rows per keyword, or switch after scanning 200 rows.
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
- `--mode audio` first uses the structured `music.play_url` stream. The downloaded source is checked with `ffprobe` and accepted only when it contains audio, has no video stream, and matches the target video's duration within 3 seconds. If `music.play_url` is absent or invalid, `yt-dlp` may be used only after it identifies a genuine audio-only format. Muxed video + audio is always rejected.

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
  --min-red-hearts 1000 \
  --mode both \
  --transcribe true \
  --whisper-model /absolute/path/to/ggml-small-q5_1.bin
```

## Search the Included Business Keywords

```bash
dyca search-keywords \
  --keywords-file ./presets/business-keywords.txt \
  --out ./douyin-keyword-search \
  --target-per-keyword 10 \
  --max-scanned-per-keyword 200 \
  --min-red-hearts 1000 \
  --within-days 14
```

The browser types `#` before each keyword, clicks the visible search button, and processes keywords serially in one reused Douyin window. Before the next keyword it selects and deletes the old query, verifies that the input is empty, and then types the new query. A video qualifies only when the structured `statistics.digg_count` is strictly greater than 1000 and `create_time` falls inside the rolling 14-day window. Exact 1000, missing metrics, and missing publication times are excluded. The tool keeps the Douyin window open to preserve the session and restores the application that was in front before the run.

For item-at-a-time ingestion, pass `--qualified-hook /absolute/path/to/hook.mjs`. Each newly qualified video is opened in the same tab, written to `transactions/<video_id>/qualified-item.json`, and passed to the hook as `--item-json ... --transaction-dir ...`. Only a zero-exit hook is treated as a confirmed ingest. The browser then calls Back, verifies the original `#keyword` results page and restores its scroll position before scanning continues. Hook failure or Back verification failure stops the run; the current keyword is never re-searched after an ingest.

Outputs:

```text
douyin-keyword-search/
  qualified-content.json
  qualified-content.jsonl
  keyword-report.json
  logs/scanned-content.jsonl
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
dyca search-keywords --keywords-file FILE [--out DIR] [--target-per-keyword 10] [--max-scanned-per-keyword 200] [--min-red-hearts 1000] [--within-days 14] [--qualified-hook SCRIPT]
dyca list --creator-url URL [--out DIR] [--limit N] [--min-red-hearts N] [--scroll-rounds N]
dyca archive --creator-url URL [--out DIR] [--limit N] [--min-red-hearts N] [--mode audio|video|both]
dyca archive-urls --input ROWS.jsonl [--out DIR] [--limit N] [--min-red-hearts N] [--mode audio|video|both]
```

Important options:

- `--profile-dir`: Chrome user data directory. Defaults to app-owned profile under Application Support.
- `--chrome-path`: Chrome executable path. Defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- `--port`: CDP port. Defaults to `9533`.
- `--delay-ms`: delay between videos. Defaults to `2500`.
- `--min-red-hearts`: `statistics.digg_count` threshold. Defaults to `1000` and is strict (`>`). Missing values are excluded.
- `--visible false`: run Chrome without `--new-window` visibility hints. Login still requires visible Chrome.
- `--covers true`: explicitly opt in to cover downloads. Covers are skipped by default.
- `--transcribe true`: generate voice transcripts with local `whisper-cli`.
- `--whisper-model PATH`: absolute path to a whisper.cpp model. Can also use `DYCA_WHISPER_MODEL`.
- `--yt-dlp-path PATH`: optional explicit `yt-dlp` binary path for reliable audio-only extraction. Can also use `DYCA_YT_DLP`.
- Audio mode never falls back to a muxed video stream. `music.play_url` and any fallback must pass a zero-video `ffprobe` gate; `music.play_url` must also match the target video's duration within 3 seconds.

Each `creator-videos.jsonl` row can include:

```json
{
  "id": "7597073908935789850",
  "title": "...",
  "publish_time": "...",
  "red_heart_count": 1641,
  "favorite_count": 76,
  "comment_count": 11,
  "share_count": 122,
  "cover_url": "...",
  "audio_url": "...",
  "audio_source": "music.play_url",
  "download_url": "...",
  "metadata_status": "structured"
}
```

## Completeness Boundary

`logs/list-report.json` records how creator discovery stopped. The collector watches the creator page's own `aweme/post` responses while scrolling and records `cursor` plus `has_more`. It sets `complete: true` only when pagination was observed, `has_more=false`, and the requested `--limit` did not stop the run first. Otherwise `observed_count` remains non-authoritative.

The final `creator-videos.jsonl` contains only videos meeting `red_heart_count > --min-red-hearts`. `logs/list-report.json.red_heart_standard` records observed, qualified, at-or-below-threshold, and missing-metric counts. Account completeness and threshold qualification are separate: a threshold result is authoritative for the full account only when `complete=true`.

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
