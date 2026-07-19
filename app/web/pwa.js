// PWA 共用:SW 註冊、離線判定、課程內容預下載。index 與 reader 皆載入。
'use strict';
window.PWA = (() => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // SW 在 cache fallback 時加 X-Sw-Cache: hit;有這個標頭 = 連不上 Mac
  const fromCache = r => r.headers.get('X-Sw-Cache') === 'hit';

  // 首次造訪時 SW 裝完才接管(clients.claim),等 controllerchange 讓第一次就能同步
  async function swControlled() {
    if (navigator.serviceWorker.controller) return true;
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return true;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(!!navigator.serviceWorker.controller), 5000);
      navigator.serviceWorker.addEventListener('controllerchange',
        () => { clearTimeout(timer); resolve(true); }, { once: true });
    });
  }

  // 在線時把所有單元(講義 + 自答歷史 + 助教對話)抓一輪,SW 順手寫進快取。
  // 30 分鐘節流;課程單元數變動時跳過節流,新單元不用等。
  async function syncContent(courses) {
    if (!('serviceWorker' in navigator)) return;
    if (!await swControlled()) return;
    const totalUnits = courses.reduce((n, c) => n + c.units.length, 0);
    const last = JSON.parse(localStorage.getItem('pwaSync') || '{}');
    if (last.units === totalUnits && Date.now() - (last.at || 0) < 30 * 60e3) return;

    // index 三支 API 也入列:首次造訪時頁面自己的 fetch 發生在 SW 接管前,不會進快取
    const urls = ['api/courses', 'api/redo', 'api/graph'];
    for (const c of courses) {
      for (const u of c.units) {
        const q = `course=${encodeURIComponent(c.slug)}&unit=${encodeURIComponent(u.file)}`;
        urls.push(`api/unit?${q}`, `api/selfcheck?${q}`, `api/chat/history?${q}`);
      }
    }
    // 併發 4 的簡單 queue;個別失敗不擋整體
    let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const url = urls[i++];
        try { await fetch(url); } catch { return; } // 網路斷了就收工
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    localStorage.setItem('pwaSync', JSON.stringify({ at: Date.now(), units: totalUnits }));
  }

  return { fromCache, syncContent };
})();
