// Browser check for a page built with the dsb-wayfinding-html skill (Playwright + installed Edge).
//
// Setup once, in a scratch folder (Windows PowerShell blocks npm.ps1, so use npm.cmd):
//   $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"; npm.cmd init -y; npm.cmd i playwright@1
// Run from that folder:
//   node <skill>/scripts/check_page.js C:\path\to\page.html
// Writes desktop.png, mobile.png and print.pdf to the current folder and prints a JSON summary.

const path = require('path');
const { chromium } = require(require.resolve('playwright', { paths: [process.cwd()] }));

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node check_page.js <page.html>'); process.exit(2); }
  const url = 'file:///' + path.resolve(file).replace(/\\/g, '/');
  const browser = await chromium.launch({ channel: 'msedge' });
  const result = { errors: [] };

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => result.errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') result.errors.push('console: ' + m.text()); });
  page.on('request', r => { if (!/^(file|data):/.test(r.url())) result.errors.push('external request: ' + r.url()); });
  await page.goto(url);
  await page.screenshot({ path: 'desktop.png' });

  const copy = page.locator('button.copy');
  result.copyButtons = await copy.count();
  if (result.copyButtons) {
    const target = await copy.first().getAttribute('data-copy');
    await copy.first().click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const code = await page.evaluate(id => document.getElementById(id)?.textContent ?? '', target);
    result.copyMatchesCode = clip.replace(/\r\n/g, '\n') === code.replace(/\r\n/g, '\n');
  }

  const sections = await page.evaluate(() => [...document.querySelectorAll('main section[id]')].map(s => s.id));
  result.sections = sections.length;
  result.scrollHighlight = [];
  for (const id of sections) {
    await page.evaluate(i => { const e = document.getElementById(i); window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 80); }, id);
    await page.waitForTimeout(250);
    const active = await page.evaluate(() => document.querySelector('nav.line [aria-current]')?.getAttribute('href'));
    if (active !== '#' + id) result.scrollHighlight.push(`${id} -> ${active}`);
  }
  result.scrollHighlightOk = result.scrollHighlight.length === 0;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  result.mobileOverflowPx = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.screenshot({ path: 'mobile.png' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ media: 'print' });
  result.hiddenInPrint = await page.evaluate(() => [...document.querySelectorAll('button, nav.line')].every(e => getComputedStyle(e).display === 'none'));
  await page.pdf({ path: 'print.pdf', format: 'A4', printBackground: true });

  await browser.close();
  console.log(JSON.stringify(result, null, 1));
  process.exit(result.errors.length || result.mobileOverflowPx > 0 || result.copyMatchesCode === false ? 1 : 0);
})();
