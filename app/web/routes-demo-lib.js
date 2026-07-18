// 三路線 demo 共用渲染:1D 分布圖 + 配對表
'use strict';

const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c]));

function shortName(slug) {
  return { 'fundamental-analysis': '基本面', 'technical-analysis': '技術面',
    'db_scale': 'DB擴展', 'k8s': 'k8s', 'linux-sysadmin': 'Linux' }[slug] || slug;
}

// pairs: [{a,b,score,isTrue}] 已排序;stats: {spread,gap,gapAfterRank}
function renderStrip(container, { pairs, stats }, title) {
  const min = pairs[pairs.length - 1].score, max = pairs[0].score;
  const pos = s => ((s - min) / (max - min || 1)) * 100;
  const gapMid = (pairs[stats.gapAfterRank - 1].score + pairs[stats.gapAfterRank].score) / 2;

  const el = document.createElement('div');
  el.className = 'strip-wrap';
  el.innerHTML = `
    <div class="strip-label"><span>${esc(title)}</span><span>值域寬度 ${stats.spread.toFixed(3)}</span></div>
    <div class="strip">
      ${stats.gapAfterRank < pairs.length ? `<span class="gapline" style="left:${pos(gapMid)}%"></span>` : ''}
      ${pairs.map(p => `<span class="dot ${p.isTrue ? 't' : 'f'}" style="left:${pos(p.score)}%"
        title="${esc(shortName(p.a))} ↔ ${esc(shortName(p.b))}:${p.score.toFixed(3)}${p.isTrue ? '(人工基準:相關)' : ''}"></span>`).join('')}
    </div>
    <div class="strip-stats">← ${min.toFixed(3)} ⋯ ${max.toFixed(3)} →
      · 最大空隙 ${stats.gap.toFixed(3)}(第 ${stats.gapAfterRank} 名之後)
      · <span style="color:var(--done)">●</span> 人工基準的真關聯 <span style="color:var(--muted)">●</span> 其他配對</div>`;
  container.appendChild(el);
}

function renderTable(container, { pairs }, opts = {}) {
  const t = document.createElement('table');
  t.className = 'pairs';
  t.innerHTML = pairs.map((p, i) => `<tr>
    <td class="small">#${i + 1}</td>
    <td class="${p.isTrue ? 't-lab' : 'f-lab'}">${esc(shortName(p.a))} ↔ ${esc(shortName(p.b))}${p.isTrue ? ' ✓' : ''}</td>
    <td class="num">${p.score.toFixed(3)}</td>
    ${opts.extra ? `<td class="small">${opts.extra(p)}</td>` : ''}
  </tr>`).join('');
  container.appendChild(t);
}

async function loadData() {
  const d = await fetch('/routes-demo.json').then(r => r.json());
  document.querySelectorAll('.gen-time').forEach(e =>
    e.textContent = new Date(d.generatedAt).toLocaleString('zh-TW'));
  return d;
}
