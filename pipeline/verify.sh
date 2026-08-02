#!/bin/bash
# 驗收一門課:./pipeline/verify.sh <slug>
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLUG="${1:?usage: verify.sh <course-slug>}"
if [ -n "${COURSE_CONTENT_DIR:-}" ]; then
  DIR="$COURSE_CONTENT_DIR"
else
  DIR="$(COURSES_ROOT="${COURSES_ROOT:-$ROOT/courses}" node -e '
  const b = require(process.argv[1]).locate(process.argv[2]);
  if (!b) process.exit(2);
  process.stdout.write(b.contentDir);
  ' "$ROOT/app/lib/course-bundles.js" "$SLUG")" || { echo "✗ 找不到課程 $SLUG"; exit 1; }
fi
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

# Activity / View capability 都是 optional；存在就必須通過契約與 reference 驗證。
if [ -f "$DIR/activities.json" ]; then
  node "$ROOT/pipeline/activity-tool.js" validate "$DIR" || FAIL=1
fi
if [ -f "$DIR/views.json" ]; then
  COURSE_CONTENT_DIR="$DIR" ROOT_DIR="$ROOT" node <<'NODE' || FAIL=1
const fs = require('fs'), path = require('path');
const V = require(path.join(process.env.ROOT_DIR, 'pipeline/lib/view-manifest'));
const dir = process.env.COURSE_CONTENT_DIR;
try {
  const manifest = V.loadManifest(dir);
  V.assertValid(manifest, { contentDir: dir });
  const ids = new Set(manifest.views.map(v => v.id));
  for (const file of fs.readdirSync(path.join(dir, 'units')).filter(x => x.endsWith('.md'))) {
    const md = fs.readFileSync(path.join(dir, 'units', file), 'utf8');
    for (const match of md.matchAll(/```view\s*\n([\s\S]*?)```/g)) {
      const { id } = V.parseDirective(match[1]);
      if (!ids.has(id)) throw new Error(`${file}: view directive 找不到 views.json 的 ${id}`);
    }
  }
  console.log(`OK ${path.join(dir, 'views.json')}: ${manifest.views.length} views`);
} catch (e) { console.error('✗ ' + e.message); process.exit(1); }
NODE
fi

# 用 server 同一套解析器驗證每題都解得出來
COURSES_ROOT="${COURSES_ROOT:-$ROOT/courses}" node -e '
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
