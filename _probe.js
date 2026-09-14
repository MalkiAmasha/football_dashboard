/** Smoke-check the UI: load the page, wait for the scorecard, report errors. */
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  await p.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.match', { timeout: 60000 });
  await p.waitForSelector('table.sc tbody tr', { timeout: 60000 });
  console.log('matches listed :', await p.locator('.match').count());
  console.log('leagues in picker:', await p.locator('#league option').count());
  console.log('first match  :', (await p.locator('.match').first().innerText()).replace(/\n/g, ' | '));
  console.log('scoreline    :', (await p.locator('#card .cardhead').innerText()).replace(/\n/g, ' | '));
  console.log('teams shown  :', await p.locator('.teamtitle').allInnerTexts());
  console.log('player rows  :', await p.locator('table.sc tbody tr').count());
  console.log('headers      :', (await p.locator('table.sc thead tr').nth(1).innerText()).replace(/\n/g, ' '));
  console.log('sample row   :', (await p.locator('table.sc tbody tr').first().innerText()).replace(/\n/g, ' '));
  console.log('bench label  :', await p.locator('.sub-sep').first().innerText());
  console.log('JS errors    :', errs.length ? errs : 'none');
  await p.screenshot({ path: process.env.SHOT || '_smoke.png', fullPage: true });
  await b.close();
})();
