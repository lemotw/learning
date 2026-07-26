#!/usr/bin/env node
// docs/*.md → docs/*.html。用 app/web/vendor 已經有的 markdown-it,不裝新依賴。
// 用法:node app/scripts/md2html.js docs/foo.md [more.md ...]
//      不給參數就轉 docs/ 底下全部 .md
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');

// vendor 的 markdown-it 是 UMD bundle,塞個假的 module 進去就能在 node 取到
function loadMarkdownIt() {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'web', 'vendor', 'markdown-it.min.js'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'window', src)(mod, mod.exports, undefined);
  return mod.exports.default || mod.exports;
}

// 配色沿用 app/web/style.css 的 :root,報告跟 app 看起來是同一套東西
const CSS = `
:root { --bg:#0f1117; --bg2:#161a23; --bg3:#1e2430; --fg:#d8dee9; --fg-dim:#8b93a7;
  --accent:#7c6ff0; --accent2:#4fb3bf; --ok:#4caf7d; --warn:#e0a458; --err:#e06c75;
  --border:#2a3140; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.75 -apple-system,"PingFang TC","Noto Sans TC",sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 40px 22px 100px; }
h1 { font-size:26px; line-height:1.35; margin:0 0 24px; }
h2 { font-size:20px; margin:44px 0 14px; padding-bottom:8px; border-bottom:1px solid var(--border); }
h3 { font-size:16px; margin:28px 0 10px; color:var(--accent2); }
p, ul, ol { margin: 0 0 14px; }
li { margin-bottom: 5px; }
a { color: var(--accent2); }
code { background:var(--bg3); padding:1.5px 5px; border-radius:4px; font-size:12.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background:#11151c; border:1px solid var(--border); border-radius:8px;
  padding:12px 14px; overflow-x:auto; font-size:12.5px; line-height:1.6; }
pre code { background:none; padding:0; font-size:inherit; }
blockquote { margin:0 0 16px; padding:10px 16px; border-left:3px solid var(--accent);
  background:var(--bg2); color:var(--fg-dim); border-radius:0 6px 6px 0; }
blockquote p:last-child { margin-bottom: 0; }
/* 寬表格自己捲,不要讓整頁橫向捲動 */
.tw { overflow-x:auto; margin:0 0 18px; }
table { border-collapse:collapse; width:100%; font-size:13.5px; }
th, td { border:1px solid var(--border); padding:7px 10px; text-align:left; vertical-align:top; }
th { background:var(--bg3); font-weight:650; white-space:nowrap; }
tr:nth-child(even) td { background:rgba(255,255,255,.015); }
hr { border:0; border-top:1px solid var(--border); margin:36px 0; }
strong { color:#fff; }
.meta { color:var(--fg-dim); font-size:12.5px; margin:-14px 0 30px; }
@media (max-width:600px) { main { padding:26px 14px 70px; } h1 { font-size:22px; } }
`;

function render(mdFile) {
  const mdi = loadMarkdownIt()({ html: false, linkify: true, typographer: false });
  const src = fs.readFileSync(mdFile, 'utf8');
  let body = mdi.render(src);
  // markdown-it 的 table 沒有外層容器,包一層才能單獨橫向捲動
  body = body.replace(/<table>/g, '<div class="tw"><table>').replace(/<\/table>/g, '</table></div>');

  const title = (src.match(/^#\s+(.+)$/m) || [, path.basename(mdFile, '.md')])[1].trim();
  const stamp = fs.statSync(mdFile).mtime.toISOString().slice(0, 16).replace('T', ' ');
  const out = mdFile.replace(/\.md$/, '.html');

  fs.writeFileSync(out, `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}<p class="meta">來源:${path.relative(ROOT, mdFile)} · 產出:${stamp}</p>
</main>
</body>
</html>
`);
  return out;
}

const args = process.argv.slice(2);
const files = args.length
  ? args.map(a => path.resolve(a))
  : fs.readdirSync(DOCS).filter(f => f.endsWith('.md')).map(f => path.join(DOCS, f));

if (!files.length) { console.error('沒有 .md 可以轉'); process.exit(1); }
for (const f of files) console.log('→', path.relative(ROOT, render(f)));
