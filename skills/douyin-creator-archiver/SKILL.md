---
name: douyin-creator-archiver
description: Use when a Mac user asks an AI agent to search public Douyin videos by keyword or archive creator metadata, media, audio, or voice transcripts using a local Chrome login profile.
---

# Douyin Creator Archiver Skill

Use this skill when the user needs keyword search, video metadata, audio, or voice transcripts from Douyin on macOS.

## Safety

- Only process content the user owns, is authorized to archive, or may lawfully process.
- Do not bypass CAPTCHA, paywalls, DRM, login challenges, or platform restrictions.
- Keep cookies and browser profiles local. Never print cookie values.
- Default to serial, stable runs. Do not parallelize Douyin page control unless the user explicitly accepts the reliability risk.

## Required Local Tool

Repository:

```bash
git clone https://github.com/Evander764/douyin-creator-archiver.git
cd douyin-creator-archiver
npm test
npm link
dyca doctor
```

## Workflow

1. Run:

```bash
dyca doctor
```

2. If Douyin login is needed, run:

```bash
dyca login
```

Ask the user to finish login or verification in the opened Chrome window.

3. For keyword search, use the visible search-box workflow:

```bash
dyca search-keywords --keywords-file ./presets/business-keywords.txt --out ./douyin-keyword-search --target-per-keyword 1 --max-scanned-per-keyword 200 --min-red-hearts 1000 --within-days 60
```

The command must reuse one Douyin window, select and delete the previous query, verify the box is empty, type `#keyword`, and click the visible search button. It must not construct a search-result URL. Qualify only `statistics.digg_count > 1000` plus publication inside the rolling 60-day window. Switch after the first qualified row or 200 scanned rows. Keep the Douyin page open to preserve the session, disconnect control on exit, and restore the previously frontmost application.

When the workflow requires immediate ingestion, pass `--qualified-hook <absolute-script.mjs>`. The hook must finish and verify one item before the browser goes Back to the same search result and continues. Stop on hook or Back failure. Never submit the current keyword again after an item has been ingested.

4. List creator videos first:

```bash
dyca list --creator-url "<creator profile URL>" --out ./douyin-archive --limit 50 --min-red-hearts 1000
```

5. Archive metadata, media, and optional voice transcripts from a creator:

```bash
dyca archive --creator-url "<creator profile URL>" --out ./douyin-archive --limit 50 --min-red-hearts 1000 --mode audio --covers false --transcribe true --whisper-model /absolute/model.bin
```

Use `--mode both` when the user explicitly wants video files and audio files.

For `--mode audio`, prefer structured `music.play_url`. Validate the downloaded stream with `ffprobe`; it must contain at least one audio stream, zero video streams, and match the target video's structured duration within 3 seconds. If the field is absent or invalid, only a separately verified audio-only format may be used. Never download muxed video as a fallback.

6. If an upstream ingest queue already has exact video URLs, archive those rows directly:

```bash
dyca archive-urls --input "<pending-ingest-items.jsonl>" --out ./douyin-archive-urls --limit 20 --mode audio
```

Default JSONL fields are `source_url` and `title`. Use `--url-field` or `--title-field` only when the upstream rows use different keys.

7. Report:

- `creator-videos.json` count.
- `logs/list-report.json` completeness boundary and stop reason.
- `logs/archive-report.json` succeeded/failed counts.
- Failed item titles and errors.
- Output folder path.
- Keyword search: `qualified-content.jsonl`, `keyword-report.json`, and each keyword's stop reason.
- Never report `observed_count` as the creator's authoritative total while `complete` is false.

## Defaults

- Chrome profile: `~/Library/Application Support/Douyin Creator Archiver/chrome-profile`
- CDP port: `9533`
- Chrome path: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Output folder: `./douyin-archive`
- Run style: serial stable mode
- Qualification: `statistics.digg_count > 1000`; exact 1000 and missing values are excluded
- Keyword time window: rolling 60 days; missing timestamps are excluded
- Cover downloads: off by default

## Troubleshooting

- `Douyin requires login`: run `dyca login`.
- `Douyin requires verification`: finish verification in the dedicated Chrome window.
- `No playable media URL captured`: the video may be unavailable, hidden, region-limited, or not fully loaded.
- Large media timeout: rerun the same command; downloads resume from `.partial` files.
