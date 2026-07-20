# 抖音博主归档代码：快速开始

这是 macOS 源码工具，不是桌面应用。红心字段固定取抖音结构化数据里的 `statistics.digg_count`；默认要求严格大于 `1000`，正好 `1000` 不算。字段缺失不会按 0 处理。

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
  --limit 50 \
  --min-red-hearts 1000
```

查看：

- `output/creator-videos.jsonl`
- `output/logs/list-report.json`

`list-report.json.red_heart_standard` 会记录观察数量、达标数量、等于或低于 1000 的数量和红心字段缺失数量。`creator-videos.jsonl` 只保留达标视频。

只有同时满足以下条件才会写入 `complete: true`：代码监听到了主页自己的分页响应、分页明确返回 `has_more=false`，并且没有先撞到 `--limit`。`complete: false` 表示当前只确认抓到了这些视频，不能宣称已经穷尽博主全部作品。

## 4. 按关键词搜索

项目已经包含本次的 17 个关键词：

```bash
dyca search-keywords \
  --keywords-file ./presets/business-keywords.txt \
  --out ./douyin-keyword-search \
  --target-per-keyword 10 \
  --max-scanned-per-keyword 200 \
  --min-red-hearts 1000 \
  --within-days 14
```

程序只复用一个抖音搜索窗口：在搜索框里逐字填入 `#关键词`，读回确认后点击“搜索”；切词时先全选、删除旧词并确认输入框为空，再输入新词。每个词找到 10 条合格内容后切换；扫描到 200 条仍不足 10 条也切换。合格内容必须同时满足：`statistics.digg_count > 1000`，并且 `create_time` 位于运行时点往前 14×24 小时内。运行结束后保留抖音窗口，避免反复开关引起风控，同时把前台焦点恢复到运行前的应用。

需要“发现一条就入库一条”时，加 `--qualified-hook /绝对路径/入库脚本.mjs`。程序会在同一标签页打开合格视频，等待入库脚本以成功状态退出，然后调用浏览器回退，核对已经回到原来的 `#关键词` 结果页并恢复滚动位置，才继续往后扫。入库失败或回退校验失败都会立即停止；入库后不会重新搜索当前关键词。

结果位于：

- `qualified-content.jsonl`：达标内容。
- `keyword-report.json`：每个词的扫描数、达标数和切换原因。
- `logs/scanned-content.jsonl`：实际检查过的内容，便于复核。

## 5. 下载音频并生成逐字稿

```bash
dyca archive \
  --creator-url "https://www.douyin.com/user/..." \
  --out ./output \
  --limit 50 \
  --min-red-hearts 1000 \
  --mode audio \
  --covers false \
  --transcribe true \
  --whisper-model "/绝对路径/ggml-small-q5_1.bin"
```

结果目录：

```text
output/
  creator-videos.json
  creator-videos.jsonl
  audio/
  transcripts/
  logs/list-report.json
  logs/archive-report.json
```

`archive-report.json` 中每条内容都有独立成功/失败状态。人声逐字稿不包含画面中没有念出来的文字；这类文字需要另做 OCR。默认不下载封面，只有明确传入 `--covers true` 才会下载。

## 6. 安全边界

- 只处理自己拥有、得到授权或依法可以处理的公开内容。
- 默认串行运行，不并发控制抖音页面。
- 遇到登录、验证码或安全验证时停止，由人完成验证。
- 压缩包不含 Cookie、Chrome profile、抓取数据或 Whisper 模型。
