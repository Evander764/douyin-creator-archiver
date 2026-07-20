# 抖音博主归档代码：快速开始

这是 macOS 源码工具，不是桌面应用。它可以读取公开视频的标题、发布时间、点赞、收藏、评论、分享、封面，下载视频或音频，并可用本地 Whisper 生成人声逐字稿。

## 1. 安装依赖

需要：

- Node.js 22.5+
- Google Chrome
- `ffmpeg`
- 逐字稿可选：`whisper-cli` 和一个 whisper.cpp 模型文件

```bash
brew install node ffmpeg whisper-cpp
npm test
npm link
dyca doctor
```

## 2. 登录抖音

```bash
dyca login
```

在打开的独立 Chrome 窗口完成登录或人工验证。代码不会输出 Cookie，也不会绕过验证码。

## 3. 先列出视频和指标

```bash
dyca list \
  --creator-url "https://www.douyin.com/user/..." \
  --out ./output \
  --limit 50
```

查看：

- `output/creator-videos.jsonl`
- `output/logs/list-report.json`

只有同时满足以下条件才会写入 `complete: true`：代码监听到了主页自己的分页响应、分页明确返回 `has_more=false`，并且没有先撞到 `--limit`。`complete: false` 表示当前只确认抓到了这些视频，不能宣称已经穷尽博主全部作品。

## 4. 下载封面、音频并生成逐字稿

```bash
dyca archive \
  --creator-url "https://www.douyin.com/user/..." \
  --out ./output \
  --limit 50 \
  --mode audio \
  --transcribe true \
  --whisper-model "/绝对路径/ggml-small-q5_1.bin"
```

结果目录：

```text
output/
  creator-videos.json
  creator-videos.jsonl
  audio/
  covers/
  transcripts/
  logs/list-report.json
  logs/archive-report.json
```

`archive-report.json` 中每条内容都有独立成功/失败状态。人声逐字稿不包含画面中没有念出来的文字；这类文字需要另做 OCR。

## 5. 安全边界

- 只处理自己拥有、得到授权或依法可以处理的公开内容。
- 默认串行运行，不并发控制抖音页面。
- 遇到登录、验证码或安全验证时停止，由人完成验证。
- 压缩包不含 Cookie、Chrome profile、抓取数据或 Whisper 模型。
