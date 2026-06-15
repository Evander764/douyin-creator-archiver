# Douyin Creator Archiver

Mac-first toolkit for AI agents that need to archive public Douyin videos from one creator profile.

It provides:

- A zero-dependency Node.js CLI.
- A dedicated Chrome profile for Douyin login.
- Serial, stable browser automation through Chrome DevTools Protocol.
- Creator-page video discovery.
- Video download plus optional audio extraction.
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
  --mode both
```

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
  logs/
```

## Agent Workflow

1. Run `dyca doctor`.
2. Run `dyca login` if the profile is not logged into Douyin.
3. Run `dyca list --creator-url ... --limit ...` to inspect discovered videos.
4. Run `dyca archive --creator-url ... --mode audio|video|both`.
5. Summarize `creator-videos.json` and report failed items from `logs/archive-report.json`.

## CLI Reference

```bash
dyca doctor
dyca login [--profile-dir PATH] [--port 9533]
dyca list --creator-url URL [--out DIR] [--limit N] [--scroll-rounds N]
dyca archive --creator-url URL [--out DIR] [--limit N] [--mode audio|video|both]
```

Important options:

- `--profile-dir`: Chrome user data directory. Defaults to app-owned profile under Application Support.
- `--chrome-path`: Chrome executable path. Defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- `--port`: CDP port. Defaults to `9533`.
- `--delay-ms`: delay between videos. Defaults to `2500`.
- `--visible false`: run Chrome without `--new-window` visibility hints. Login still requires visible Chrome.

## Known Limits

- Douyin may require login or verification at any time.
- Some creator pages lazy-load slowly or hide older posts.
- Some media URLs expire quickly.
- Large videos may take several minutes; downloads use resume and retries.
- The default workflow is serial for stability, not speed.

## Codex Skill

Copy or symlink the skill folder:

```bash
mkdir -p ~/.codex/skills
ln -s "$(pwd)/skills/douyin-creator-archiver" ~/.codex/skills/douyin-creator-archiver
```

Then ask Codex to use the Douyin Creator Archiver skill.
