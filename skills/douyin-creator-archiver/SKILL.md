---
name: douyin-creator-archiver
description: Use when a Mac user asks an AI agent to archive or download public Douyin videos or audio from a creator profile using a local Chrome login profile. Provides a safe serial CLI workflow with doctor, login, list, and archive commands.
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
dyca list --creator-url "<creator profile URL>" --out ./douyin-archive --limit 50
```

4. Archive videos or audio:

```bash
dyca archive --creator-url "<creator profile URL>" --out ./douyin-archive --limit 50 --mode audio
```

Use `--mode both` when the user explicitly wants video files and audio files.

5. Report:

- `creator-videos.json` count.
- `logs/archive-report.json` succeeded/failed counts.
- Failed item titles and errors.
- Output folder path.

## Defaults

- Chrome profile: `~/Library/Application Support/Douyin Creator Archiver/chrome-profile`
- CDP port: `9533`
- Chrome path: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Output folder: `./douyin-archive`
- Run style: serial stable mode

## Troubleshooting

- `Douyin requires login`: run `dyca login`.
- `Douyin requires verification`: finish verification in the dedicated Chrome window.
- `No playable media URL captured`: the video may be unavailable, hidden, region-limited, or not fully loaded.
- Large media timeout: rerun the same command; downloads resume from `.partial` files.

