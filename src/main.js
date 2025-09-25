
import { Actor, Dataset, KeyValueStore, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const START_URL = 'https://www.bioladen.de/bio-haendler-suche';

async function acceptCookies(page) {
  const candidates = [
    'button:has-text("Akzeptieren")',
    'button:has-text("Einverstanden")',
    'button:has-text("Zustimmen")',
    'button:has-text("Alle akzeptieren")',
    '[aria-label*="akzeptieren" i]',
  ];
  for (const sel of candidates) {
    const b = page.locator(sel);
    if (await b.count()) { await b.first().click({ timeout: 1500 }).catch(()=>{}); }
  }
  for (const frame of page.frames()) {
    try {
      const fb = frame.locator('button:has-text("Akzeptieren"), button:has-text("Alle akzeptieren")');
      if (await fb.count()) { await fb.first().click({ timeout: 1500 }).catch(()=>{}); }
    } catch {}
  }
}

const SEL = {
  inputZip: 'input[name="tx_biohandel_plg[searchplz]"], input[placeholder*="Postleitzahl" i], input[aria-label*="Postleitzahl" i], input[placeholder*="PLZ" i]',
};

function normalizeSpace(s) { return (s || '').replace(/[\s\u00A0]+/g, ' ').trim(); }

function dedupKey(item, mode) {
  if (mode === 'detailUrl') return (item.detailUrl || '').toLowerCase().trim();
  return `${(item.name||'').toLowerCase().trim()}|${(item.street||'').toLowerCase().trim()}|${(item.zip||'').trim()}`;
}

// -------- PLZ sources ----------
function* genRange(prefixes) {
  let list = [];
  if (prefixes.includes('all')) {
    list = Array.from({length: 99}, (_,i)=>String(i+1).padStart(2,'0'));
  } else {
    list = prefixes.map(p => String(p).padStart(2,'0'));
  }
  for (const p2 of list) {
    for (let n=0; n<=999; n++) {
      const tail = String(n).padStart(3,'0');
      const code = `${p2}${tail}`;
      // skip obviously invalid 00000..00999 ranges
      if (/^00/.test(code)) continue;
      yield code;
    }
  }
}

async function loadPostalCodes(input) {
  const { postalCodesMode='range', postalCodes=[], rangePrefixes=['01','02','03','04','05','06','07','08','09','10','20','30','40','50','60','70','80','90'] } = input;
  if (postalCodesMode === 'input' && postalCodes.length) return postalCodes.map(String);
  if (postalCodesMode === 'kv') {
    const store = await KeyValueStore.open();
    const txt = await store.getValue('de_plz.txt', { buffer: true }).catch(()=>null);
    if (txt && txt.toString) {
      return txt.toString('utf-8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    }
    log.warning('postalCodesMode=kv gewählt, aber de_plz.txt nicht gefunden. Fallback auf range.');
  }
  // range mode
  const arr = [];
  for (const code of genRange(rangePrefixes)) arr.push(code);
  return arr;
}

// ---------- page helpers ----------
async function selectRadius(page, radiusKm) {
  const selByName = page.locator('select[name*="distance" i], select[name*="radius" i]');
  if (await selByName.count()) {
    try {
      const first = selByName.first();
      const options = await first.locator('option').allTextContents();
      let idx = options.findIndex(t => (t||'').includes(`${radiusKm}`));
      if (idx < 0) idx = 0;
      await first.selectOption({ index: Math.max(0, idx) });
      return;
    } catch {}
  }
  const sel = page.locator('select');
  if (await sel.count()) {
    const options = await sel.first().locator('option').allTextContents();
    let idx = options.findIndex(t => (t||'').includes(`${radiusKm}`));
    if (idx < 0) idx = 0;
    await sel.first().selectOption({ index: Math.max(0, idx) });
    return;
  }
}

async function fillZip(page, postalCode) {
  const loc = page.locator(SEL.inputZip).first();
  try {
    await loc.scrollIntoViewIfNeeded();
    await loc.waitFor({ state: 'attached', timeout: 10000 });
    await loc.focus({ timeout: 2000 }).catch(()=>{});
    if (await loc.isVisible()) {
      await loc.fill('');
      await loc.type(String(postalCode), { delay: 30 });
    } else {
      throw new Error('input not visible');
    }
  } catch {
    await page.evaluate(({ value, sel }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('ZIP input not found');
      el.removeAttribute('disabled');
      el.style.display = 'block';
      el.style.visibility = 'visible';
      el.style.opacity = '1';
      el.value = String(value);
      ['input','change','keyup'].forEach(e => el.dispatchEvent(new Event(e, { bubbles: true })));
    }, { value: String(postalCode), sel: SEL.inputZip });
  }
}

async function triggerSearch(page) {
  const input = page.locator(SEL.inputZip).first();
  try { await input.focus({ timeout: 500 }); } catch {}
  try { await page.keyboard.press('Enter'); } catch {}

  const btn = page.locator(
    'form:has(input[name="tx_biohandel_plg[searchplz]"]) button[type="submit"], button:has-text("Händler finden"), button:has-text("BIO-HÄNDLER FINDEN"), button:has-text("Suchen")'
  ).first();
  if (await btn.count()) { await btn.click().catch(()=>{}); return; }

  await page.evaluate((sel) => {
    const input = document.querySelector(sel) || document.querySelector('input[placeholder*="PLZ" i]');
    const form = input ? input.form : document.querySelector('form');
    if (form && form.requestSubmit) form.requestSubmit();
    else if (form) form.submit();
  }, SEL.inputZip);
}

async function waitForResults(page) {
  const startUrl = page.url();
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  for (let i=0;i<40;i++) {
    const any = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const sels = [
        '.dealer, .dealer-item, .bh-dealer, .result, .entry, .store, [data-dealer]',
        'a:has-text("DETAILS"), a:has-text("Details")',
        '.list, .results, [data-results]',
      ];
      const foundSel = sels.some(s => {
        try { return document.querySelector(s) != null; } catch { return false; }
      });
      return foundSel || /(Bio-?Händ(ler|ler)|Ergebnisse|Treffer)/i.test(text);
    });
    const urlChanged = page.url() !== startUrl;
    if (any || urlChanged) break;
    await page.waitForTimeout(500);
  }
}

async function autoScroll(page, maxSteps=20) {
  for (let i=0;i<maxSteps;i++) {
    const before = await page.evaluate(()=>document.body.scrollHeight);
    await page.mouse.wheel(0,1200);
    await page.waitForTimeout(300);
    const after = await page.evaluate(()=>document.body.scrollHeight);
    if (after <= before) break;
  }
}

// Network sniffing for JSON endpoints (debug)
function attachNetworkSniffer(page) {
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const ct = resp.headers()['content-type'] || '';
      if (/json/i.test(ct) && /biohandel|haendl|dealer|search|plg/i.test(url)) {
        const json = await resp.json().catch(()=>null);
        if (json) {
          const store = await KeyValueStore.open();
          await store.setValue('last_api.json', { url, json });
        }
      }
    } catch {}
  });
}

async function extractItems(page) {
  // Try DOM first
  const items = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/[\s\u00A0]+/g, ' ').trim();
    const results = [];
    const candidates = Array.from(document.querySelectorAll('article, li, .card, .result, .dealer, .entry, .store'));
    for (const n of candidates) {
      const t = n.textContent || '';
      if (!/Bioladen|Markt|Lieferservice|DETAILS|Adresse|\\d{5}\\s+[A-Za-zÄÖÜäöüß-]+/.test(t)) continue;
      const nameEl = n.querySelector('h3, h2, .title, .name, [class*="title"]');
      const name = norm(nameEl ? nameEl.textContent : '');
      const detA = n.querySelector('a[href*="http"]:not([href*="facebook.com"]):not([href*="instagram.com"])') || n.querySelector('a[href^="/"]');
      const detailUrl = detA ? detA.href : null;
      const addrText = (()=>{
        const cand = Array.from(n.querySelectorAll('p, .address, address, .addr, .contact')).map(e=>norm(e.textContent)).filter(Boolean);
        const a = cand.find(x => /\\b\\d{5}\\b/.test(x)) || cand[0] || '';
        return a;
      })();
      let street=null, zip=null, city=null;
      const parts = addrText.split(/\\n|·|\\|/).map(norm).filter(Boolean);
      if (parts.length>=2) {
        street = parts[0];
        const m = parts[1].match(/(\\d{5})\\s+(.+)/);
        if (m) { zip=m[1]; city=m[2]; } else { city=parts[1]; }
      }
      const phone = (t.match(/\\+?\\d[\\d\\s\\-\\(\\)]{6,}/) || [null])[0];
      const website = (()=>{
        const link = n.querySelector('a[href^="http"]'); return link ? link.href : null;
      })();
      results.push({
        name, street, zip, city, country: 'DE',
        lat: null, lng: null,
        phone: phone && norm(phone),
        email: null,
        website,
        openingHours: null,
        detailUrl,
        source: 'bioladen.de',
        scrapedAt: new Date().toISOString(),
        distanceKm: null,
        category: null
      });
    }
    return results.filter(x=>x.name || x.street || x.detailUrl);
  });

  // If still empty, try iframe extraction
  if (items.length === 0) {
    for (const frame of page.frames()) {
      try {
        const sub = await frame.evaluate(() => {
          const norm = (s) => (s || '').replace(/[\s\\u00A0]+/g, ' ').trim();
          const out = [];
          const candidates = Array.from(document.querySelectorAll('article, li, .card, .result, .dealer, .entry, .store'));
          for (const n of candidates) {
            const t = n.textContent || '';
            if (!/\\d{5}\\s+[A-Za-zÄÖÜäöüß-]+/.test(t)) continue;
            const nameEl = n.querySelector('h3, h2, .title, .name, [class*="title"]');
            const name = norm(nameEl ? nameEl.textContent : '');
            const addrCand = Array.from(n.querySelectorAll('p, .address, address, .addr, .contact')).map(e=>norm(e.textContent)).filter(Boolean);
            const addr = addrCand.find(x => /\\b\\d{5}\\b/.test(x)) || addrCand[0] || '';
            let street=null, zip=null, city=null;
            const parts = addr.split(/\\n|·|\\|/).map(norm).filter(Boolean);
            if (parts.length>=2) {
              street = parts[0];
              const m = parts[1].match(/(\\d{5})\\s+(.+)/);
              if (m) { zip=m[1]; city=m[2]; } else { city=parts[1]; }
            }
            out.push({ name, street, zip, city, country:'DE', lat:null, lng:null, phone:null, email:null, website:null, openingHours:null, detailUrl:null, source:'bioladen.de', scrapedAt: new Date().toISOString(), distanceKm:null, category:null });
          }
          return out;
        });
        if (sub && sub.length) return sub;
      } catch {}
    }
  }

  return items;
}

await Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const { radiusKm=25, deduplicateBy='detailUrl', maxConcurrency=1 } = input;

  log.setLevel(log.LEVELS.INFO);
  log.info('Bioladen.de Händlersuche – Run startet…');
  log.info(`Config: radius=${radiusKm}km, concurrency=${maxConcurrency}`);

  // resolve PLZ list
  const postalCodes = await loadPostalCodes(input);
  if (!postalCodes.length) throw new Error('Keine PLZ gefunden (prüfe postalCodesMode / Input).');

  const seen = new Set();

  const crawler = new PlaywrightCrawler({
    maxConcurrency,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 240,
    useSessionPool: true,
    headless: true,
    launchContext: { launchOptions: { args: ['--disable-dev-shm-usage'] } },
    requestHandler: async ({ page, request }) => {
      const { postalCode } = request.userData;
      log.info(`>> ${postalCode}: öffne Seite…`);
      await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
      attachNetworkSniffer(page);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);

      try { await acceptCookies(page); } catch {}

      try { await fillZip(page, postalCode); }
      catch (e) {
        await page.screenshot({ path: `screenshot_${postalCode}_fill_error.png`, fullPage: true }).catch(()=>{});
        throw e;
      }

      await selectRadius(page, radiusKm);
      await triggerSearch(page);
      await waitForResults(page);
      await autoScroll(page, 20);

      const items = await extractItems(page);

      if (items.length === 0) {
        try { await page.screenshot({ path: `debug_${postalCode}.png`, fullPage: true }); } catch {}
        try {
          const html = await page.content();
          const store = await KeyValueStore.open();
          await store.setValue(`debug_${postalCode}.html`, html, { contentType: 'text/html; charset=utf-8' });
        } catch {}
      }

      let kept=0, dropped=0;
      for (const it of items) {
        const key = dedupKey(it, deduplicateBy);
        if (key && seen.has(key)) { dropped++; continue; }
        if (key) seen.add(key);
        await Dataset.pushData(it);
        kept++;
      }
      log.info(`<< ${postalCode}: saved=${kept}, dedup_dropped=${dropped}`);
      await page.close();
    },
  });

  // seed requests
  const requests = postalCodes.map(pc => ({ url: START_URL, userData: { postalCode: String(pc) } }));
  await crawler.run(requests);

  log.info('Fertig.');
});
