import { Actor, Dataset, KeyValueStore, log } from 'apify';
import { PlaywrightCrawler, sleep } from 'crawlee';

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
    if (await b.count()) {
      await b.first().click({ timeout: 2000 }).catch(() => {});
    }
  }
  // Iframe-based banners
  for (const frame of page.frames()) {
    try {
      const fb = frame.locator('button:has-text("Akzeptieren"), button:has-text("Alle akzeptieren")');
      if (await fb.count()) {
        await fb.first().click({ timeout: 2000 }).catch(() => {});
      }
    } catch {}
  }
}

const SEL = {
  inputZip: 'input[name="tx_biohandel_plg[searchplz]"], input[placeholder*="Postleitzahl" i], input[aria-label*="Postleitzahl" i], input[placeholder*="PLZ" i]',
};

function normalizeSpace(s) {
  return (s || '').replace(/[\s\u00A0]+/g, ' ').trim();
}

function dedupKey(item, mode) {
  if (mode === 'detailUrl') return (item.detailUrl || '').toLowerCase().trim();
  return `${(item.name||'').toLowerCase().trim()}|${(item.street||'').toLowerCase().trim()}|${(item.zip||'').trim()}`;
}

async function selectRadius(page, radiusKm) {
  const selByName = page.locator('select[name*="distance" i], select[name*="radius" i]');
  if (await selByName.count()) {
    try {
      const first = selByName.first();
      const options = await first.locator('option').allTextContents();
      let idx = options.findIndex(t => (t || '').includes(`${radiusKm}`));
      if (idx < 0) idx = 0;
      await first.selectOption({ index: Math.max(0, idx) });
      return;
    } catch {}
  }
  const sel = page.locator('select');
  if (await sel.count()) {
    const options = await sel.first().locator('option').allTextContents();
    let idx = options.findIndex(t => (t || '').includes(`${radiusKm}`));
    if (idx < 0) idx = 0;
    await sel.first().selectOption({ index: Math.max(0, idx) });
    return;
  }
  const combo = page.locator('[role="combobox"], [data-radius]');
  if (await combo.count()) {
    await combo.first().click().catch(() => {});
    const opt = page.locator(`text=/^\s*${radiusKm}\s*km\s*$/i`);
    if (await opt.count()) await opt.first().click().catch(() => {});
  }
}

async function fillZip(page, postalCode) {
  const loc = page.locator(SEL.inputZip);
  try {
    await loc.first().scrollIntoViewIfNeeded();
    await loc.first().waitFor({ state: 'attached', timeout: 10000 });
    await loc.first().focus({ timeout: 2000 }).catch(() => {});
    if (await loc.first().isVisible()) {
      await loc.first().fill('');
      await loc.first().type(String(postalCode), { delay: 50 });
      return;
    }
  } catch {}
  // Fallback: set via JS with a single object argument
  await page.evaluate(({ value, sel }) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('ZIP input not found');
    el.removeAttribute('disabled');
    el.style.display = 'block';
    el.style.visibility = 'visible';
    el.style.opacity = '1';
    el.value = String(value);
    ['input', 'change', 'keyup'].forEach(e => el.dispatchEvent(new Event(e, { bubbles: true })));
  }, { value: String(postalCode), sel: SEL.inputZip });
}

async function triggerSearch(page) {
  // Focus input then press Enter
  const input = page.locator(SEL.inputZip).first();
  try { await input.focus({ timeout: 1000 }); } catch {}
  try { await page.keyboard.press('Enter'); } catch {}

  // Try native submit button
  const btn = page.locator(
    'form:has(input[name="tx_biohandel_plg[searchplz]"]) button[type="submit"], ' +
    'button:has-text("Händler finden"), button:has-text("BIO-HÄNDLER FINDEN"), button:has-text("Suchen")'
  ).first();
  if (await btn.count()) {
    await btn.click().catch(() => {});
    return;
  }
  // Fallback: submit via JS
  await page.evaluate((sel) => {
    const input = document.querySelector(sel) || document.querySelector('input[placeholder*="PLZ" i]');
    const form = input ? input.form : document.querySelector('form');
    if (form && form.requestSubmit) form.requestSubmit();
    else if (form) form.submit();
  }, SEL.inputZip);
}

async function waitForResults(page) {
  const startUrl = page.url();
  try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
  for (let i = 0; i < 40; i++) {
    const any = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const selectors = [
        'a:has-text("DETAILS")',
        '.dealer, .dealer-item, .bh-dealer, .result, .entry, .store, [data-dealer]',
        '.list, .results, [data-results]',
      ];
      const foundSel = selectors.some(s => {
        try { return document.querySelector(s) != null; } catch { return false; }
      });
      return foundSel || /(Bio-?Händ(ler|ler)|Ergebnisse|Treffer)/i.test(text);
    });
    const urlChanged = page.url() !== startUrl;
    if (any || urlChanged) break;
    await page.waitForTimeout(500);
  }
}

async function autoScroll(page, maxSteps = 20) {
  for (let i = 0; i < maxSteps; i++) {
    const before = await page.evaluate(() => document.body.scrollHeight);
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.body.scrollHeight);
    if (after <= before) break;
  }
}

async function extractItems(page) {
  const items = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/[\s\u00A0]+/g, ' ').trim();
    const blocks = [];
    const candidates = Array.from(
      document.querySelectorAll('article, li, .card, .result, .dealer, .entry, .store')
    ).filter(n => {
      const t = n.textContent || '';
      return /DETAILS/i.test(t) || /\(\s*\d+[\.,]\d+\s*km\s*\)/i.test(t) || /Bioladen|Hof|Markt|Lieferservice/i.test(t);
    });
    const unique = [...new Set(candidates.map(n => n.closest('article, li, .card, .result, .dealer, .entry, .store') || n))];
    unique.forEach(n => {
      const nameEl = n.querySelector('h3, h2, .title, .name, [class*="title"]');
      const name = norm(nameEl ? nameEl.textContent : '');
      const detA = n.querySelector('a[href*="http"]:not([href*="facebook.com"]):not([href*="instagram.com"])') || n.querySelector('a[href^="/"]');
      const detailUrl = detA ? detA.href : null;
      const addrCand = Array.from(n.querySelectorAll('p, .address, address, .addr')).map(e => norm(e.textContent)).filter(x => x.length >= 6);
      const addr = addrCand.find(x => /\b\d{5}\b/.test(x)) || addrCand[0] || '';
      let street = null, zip = null, city = null;
      const parts = addr.split(/\n|·|\|/).map(norm).filter(Boolean);
      if (parts.length >= 2) {
        street = parts[0];
        const m = parts[1].match(/(\d{5})\s+(.+)/);
        if (m) { zip = m[1]; city = m[2]; } else { city = parts[1]; }
      }
      const phone = (n.textContent.match(/\+?\d[\d\s\-\(\)]{6,}/) || [null])[0];
      const distance = (n.textContent.match(/\((\s*\d+[\.,]\d+)\s*km\)/i) || [null, null])[1];
      const opening = (() => {
        const m = (n.textContent || '').match(/(Mo|Di|Mi|Do|Fr|Sa|So)[^\n]{0,40}\d{1,2}[:\.]\d{2}/i);
        return m ? m[0] : null;
      })();
      blocks.push({
        name, street, zip, city, country: 'DE',
        lat: null, lng: null,
        phone: phone && norm(phone),
        email: null,
        website: null,
        openingHours: opening,
        detailUrl,
        source: 'bioladen.de',
        scrapedAt: new Date().toISOString(),
        distanceKm: distance ? Number(distance.replace(',', '.')) : null,
        category: null
      });
    });
    return blocks.filter(b => b.name || b.street || b.detailUrl);
  });
  return items;
}

await Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const {
    postalCodes = ['20095'],
    radiusKm = 25,
    filters = { biolaeden: true, marktstaende: true, lieferservice: true },
    deduplicateBy = 'detailUrl',
    maxConcurrency = 1
  } = input;

  log.setLevel(log.LEVELS.INFO);
  log.info('Bioladen.de Händlersuche – Run startet…');
  log.info(`Config: radius=${radiusKm}km, filters=${JSON.stringify(filters)}, concurrency=${maxConcurrency}`);

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
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      try { await acceptCookies(page); } catch {}

      try { await fillZip(page, postalCode); }
      catch (e) {
        await page.screenshot({ path: `screenshot_${postalCode}_fill_error.png`, fullPage: true }).catch(() => {});
        throw e;
      }

      await selectRadius(page, radiusKm);

      // Optional toggles if vorhanden
      for (const label of ['Bioläden', 'Marktstände', 'Lieferservice']) {
        try { await page.locator(`text=${label}`).first().click({ timeout: 500 }); } catch {}
      }

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

      let kept = 0, dropped = 0;
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

  const requests = postalCodes.map(pc => ({ url: START_URL, userData: { postalCode: String(pc) } }));
  await crawler.run(requests);

  log.info('Fertig.');
});
