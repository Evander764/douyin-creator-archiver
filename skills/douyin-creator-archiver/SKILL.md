---
name: douyin-creator-archiver
description: Use when a Mac user asks an AI agent to archive public Douyin creator metadata, covers, videos, audio, or voice transcripts from a creator profile or known video URL queue using a local Chrome login profile.
---

# Douyin Creator Archiver Skill

Use this skill when the user needs to archive videos or audio from a Douyin creator profile on macOS.

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

3. List videos first:

```bash
dyca list --creator-url "<creator profile URL>" --out ./douyin-archive --limit 50 --min-likes 1000
```

4. Archive metadata, covers, media, and optional voice transcripts from a creator:

```bash
dyca archive --creator-url "<creator profile URL>" --out ./douyin-archive --limit 50 --min-likes 1000 --mode audio --transcribe true --whisper-model /absolute/model.bin
```

Use `--mode both` when the user explicitly wants video files and audio files.

5. If an upstream ingest queue already has exact video URLs, archive those rows directly:

```bash
dyca archive-urls --input "<pending-ingest-items.jsonl>" --out ./douyin-archive-urls --limit 20 --mode audio
```

Default JSONL fields are `source_url` and `title`. Use `--url-field` or `--title-field` only when the upstream rows use different keys.

6. Report:

- `creator-videos.json` count.
- `logs/list-report.json` completeness boundary and stop reason.
- `logs/archive-report.json` succeeded/failed counts.
- Failed item titles and errors.
- Output folder path.
- Never report `observed_count` as the creator's authoritative total while `complete` is false.

## Defaults

- Chrome profile: `~/Library/Application Support/Douyin Creator Archiver/chrome-profile`
- CDP port: `9533`
- Chrome path: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Output folder: `./douyin-archive`
- Run style: serial stable mode
- Qualification: `like_count >= 1000`; missing like counts are excluded

## Troubleshooting

- `Douyin requires login`: run `dyca login`.
- `Douyin requires verification`: finish verification in the dedicated Chrome window.
- `No playable media URL captured`: the video may be unavailable, hidden, region-limited, or not fully loaded.
- Large media timeout: rerun the same command; downloads resume from `.partial` files.
