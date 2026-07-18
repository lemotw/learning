#!/bin/bash
# 驗收一門課:./pipeline/verify.sh <slug>
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLUG="${1:?usage: verify.sh <course-slug>}"
DIR="$ROOT/courses/$SLUG"
FAIL=0

err() { echo "✗ $1"; FAIL=1; }
ok()  { echo "✓ $1"; }

[ -f "$DIR/meta.json" ] || err "meta.json 不存在"
node -e "JSON.parse(require('fs').readFileSync('$DIR/meta.json','utf8'))" 2>/dev/null \
  && ok "meta.json 是合法 JSON" || err "meta.json 解析失敗"
[ -f "$DIR/DIAGNOSTIC.md" ] && ok "DIAGNOSTIC.md 存在" || err "DIAGNOSTIC.md 不存在(診斷留檔是流程必要產物)"
[ -f "$DIR/AGENDA.md" ] && ok "AGENDA.md 存在" || err "AGENDA.md 不存在"

UNITS=("$DIR"/units/*.md)
[ -e "${UNITS[0]}" ] || { err "units/ 沒有任何單元"; exit 1; }

for f in "${UNITS[@]}"; do
  name="$(basename "$f")"
  # 顯式豁免:<!-- verify: skip=lines,lab -->(整合/附錄類特例才用)
  skips="$(grep -oE '<!-- verify: skip=[a-z,]+ -->' "$f" | grep -oE 'skip=[a-z,]+' || true)"
  lines=$(wc -l < "$f")
  if [[ "$skips" != *lines* ]] && { [ "$lines" -lt 100 ] || [ "$lines" -gt 400 ]; }; then
    err "$name 行數 $lines(應在 100-400)"
  fi
  [[ "$skips" == *lab* ]] || grep -q '^## Lab' "$f" || err "$name 缺 ## Lab"
  grep -q '^## 自答題' "$f" || err "$name 缺 ## 自答題"
  grep -qE '<!--\s*q[[:alnum:]_-]*\s+keywords:' "$f" || err "$name 沒有任何 keywords 註解(自答題無法批改)"
  grep -q '^!!!' "$f" && err "$name 用了 mkdocs admonition 語法(reader 不支援)"
done

# 用 server 同一套解析器驗證每題都解得出來
node -e '
const c = require("'"$ROOT"'/app/lib/content.js");
const fs = require("fs"), path = require("path");
const dir = "'"$DIR"'/units";
let bad = 0;
for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".md"))) {
  const md = fs.readFileSync(path.join(dir, f), "utf8");
  const qs = c.parseQuestions(md);
  const marks = (md.match(/<!--\s*q[\w-]*\s+keywords:/g) || []).length;
  if (qs.length !== marks) { console.log("✗ " + f + " keywords 註解 " + marks + " 個但解析出 " + qs.length + " 題(註解要緊貼題目上一行)"); bad = 1; }
}
process.exit(bad);
' || FAIL=1

[ "$FAIL" -eq 0 ] && echo "── 全部通過 ──" || { echo "── 有項目未過,帶評語重派 ──"; exit 1; }
