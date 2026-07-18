#!/usr/bin/env node
// 把舊 mkdocs 課程遷入本系統框架:
//   node pipeline/ingest-mkdocs.js <srcDir> <slug> [--dry]
// 轉換:admonition→blockquote、實作(記錄)→Lab、SELF-CHECK/INTERVIEW→自答題 keywords、
//       index.md→DIAGNOSTIC.md+AGENDA.md、labs/ 複製、meta.json 產生(relations 留空,手動補)
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [srcDir, slug] = process.argv.slice(2);
const DRY = process.argv.includes('--dry');
if (!srcDir || !slug) { console.error('usage: ingest-mkdocs.js <srcDir> <slug> [--dry]'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'courses', slug);

// ---------- admonition → blockquote ----------
const EMOJI = { tip: '💡', warning: '⚠️', danger: '🔥', note: '📝', info: 'ℹ️', example: '🧪', question: '❓' };

function convertAdmonitions(md) {
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(!!!|\?\?\?\+?)\s+(\w+)(?:\s+"([^"]*)")?\s*$/);
    if (!m) { out.push(lines[i]); continue; }
    const [, , type, title] = m;
    const label = title || type;
    const emoji = EMOJI[type] || '';
    out.push(`> **${emoji ? emoji + ' ' : ''}${label}**`);
    out.push('>');
    i++;
    // 收 4 空白縮排的 body(空行允許)
    while (i < lines.length && (lines[i] === '' || /^ {4}/.test(lines[i]))) {
      out.push(lines[i] === '' ? '>' : '> ' + lines[i].slice(4));
      i++;
    }
    i--;
    // 去掉結尾多餘的 '>'
    while (out.length && out[out.length - 1] === '>') out.pop();
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------- SELF-CHECK / INTERVIEW 解析 ----------
function parseQuestionBank(dir) {
  const bank = {};
  for (const name of ['SELF-CHECK.md', 'INTERVIEW.md']) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const md = fs.readFileSync(p, 'utf8');
    const sections = md.split(/^## /m).slice(1);
    for (const sec of sections) {
      const un = sec.match(/^Unit\s+(\d+)/);
      if (!un) continue;
      const q = sec.match(/\*\*Q[::]?\s*([\s\S]*?)\*\*/);
      if (!q) continue;
      const hint = sec.match(/必含\s*([^)()]+)[))]/);
      const keywords = hint
        ? hint[1].split(/[/>、,+]/).map(s => s.trim()).filter(Boolean)
        : [];
      bank[Number(un[1])] = { question: q[1].trim().replace(/\s+/g, ' '), keywords };
    }
    break; // 找到一個題庫就夠
  }
  return bank;
}

// ---------- 單元轉換 ----------
function transformUnit(md, unitNo, bank, report) {
  let out = convertAdmonitions(md);
  out = out.replace(/^## 實作(?:記錄)?([::][^\n]*)?\s*$/m, (m, suffix) => '## Lab' + (suffix || ''));

  const entry = bank[unitNo];
  const hasSection = /^## 自答題/m.test(out);
  const qBlock = entry
    ? `<!-- q1 keywords: ${entry.keywords.join(', ')} -->\n**Q1:${entry.question}**\n`
    : null;

  if (qBlock && entry.keywords.length) {
    if (hasSection) {
      // 插在既有自答題標題後(原本的練習題保留在下方)
      out = out.replace(/^(## 自答題[^\n]*\n)/m, `$1\n${qBlock}\n`);
    } else {
      out = out.trimEnd() + `\n\n## 自答題\n\n${qBlock}`;
    }
  } else {
    report.push(`unit ${unitNo}: ${entry ? '題庫沒標必含關鍵詞' : '題庫沒有這單元的題目'} → 需手動補自答題`);
    if (!hasSection) out = out.trimEnd() + `\n\n## 自答題\n\n<!-- q1 keywords: TODO -->\n**Q1:TODO(手動補)**\n`;
    else out = out.replace(/^(## 自答題[^\n]*\n)/m, `$1\n<!-- q1 keywords: TODO -->\n**Q1:TODO(手動補,原練習題在下方)**\n\n`);
  }
  if (!/^## Lab/m.test(out)) report.push(`unit ${unitNo}: 找不到 Lab/實作 區段`);
  return out;
}

// ---------- index.md → DIAGNOSTIC / AGENDA ----------
function extractSection(md, titleRe) {
  const re = new RegExp(`^## (${titleRe})[^\\n]*\\n([\\s\\S]*?)(?=^## |\\Z)`, 'm');
  const m = md.match(re);
  return m ? `## ${m[1]}\n${m[2]}`.trimEnd() : '';
}

// ---------- main ----------
const src = path.resolve(srcDir);
const indexMd = fs.readFileSync(path.join(src, 'docs', 'index.md'), 'utf8');
const bank = parseQuestionBank(src);
const report = [];

const unitsDir = path.join(src, 'docs', 'units');
const unitFiles = fs.readdirSync(unitsDir).filter(f => f.endsWith('.md') && !f.startsWith('_')).sort();

const outputs = {};
for (const f of unitFiles) {
  const unitNo = Number((f.match(/^(\d+)/) || [])[1]);
  const md = fs.readFileSync(path.join(unitsDir, f), 'utf8');
  outputs[`units/${f}`] = transformUnit(md, unitNo, bank, report);
}

const title = (indexMd.match(/^# (.+)$/m) || [, slug])[1].trim();
const created = fs.statSync(path.join(src, 'docs', 'index.md')).mtime.toISOString().slice(0, 10);
outputs['meta.json'] = JSON.stringify({
  title, status: 'active', created, tags: [], concepts: [], relations: [],
  migratedFrom: src,
}, null, 2) + '\n';

const diag = extractSection(indexMd, '診斷摘要.*?');
outputs['DIAGNOSTIC.md'] = `# 診斷(自 ${src} 遷入)\n\n` +
  (diag || '(原 index.md 無診斷摘要區段,以下為完整 index.md)\n\n' + indexMd) + '\n';

const agendaParts = ['課程地圖', '單元詳情', '主教材購書清單', '教材'].map(t => extractSection(indexMd, t)).filter(Boolean);
outputs['AGENDA.md'] = `# 課綱:${title}\n\n` + (agendaParts.join('\n\n') || indexMd) + '\n';

// 寫出
if (DRY) {
  console.log(Object.keys(outputs).join('\n'));
} else {
  fs.mkdirSync(path.join(OUT, 'units'), { recursive: true });
  for (const [rel, content] of Object.entries(outputs)) {
    fs.writeFileSync(path.join(OUT, rel), content);
  }
  const srcLabs = path.join(src, 'labs');
  if (fs.existsSync(srcLabs)) fs.cpSync(srcLabs, path.join(OUT, 'labs'), { recursive: true });
}

console.log(`${slug}: ${unitFiles.length} units, 題庫 ${Object.keys(bank).length} 題`);
for (const r of report) console.log('  ⚠ ' + r);
