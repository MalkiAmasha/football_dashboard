/**
 * Is this IP allowed to read Sofascore?
 *
 * Run it bare to test the connection you are on right now:
 *     node scripts/check-ip.js
 *
 * Run it with a proxy to test that proxy before wiring it into the server:
 *     node scripts/check-ip.js http://user:pass@host:port
 *     $env:SOFA_PROXY='http://host:port'; node scripts/check-ip.js
 *
 * Whatever it prints PASS for is what SOFA_PROXY should be set to (or, if you
 * ran it bare over a VPN, just start the server with that VPN connected).
 */
const { chromium } = require('playwright');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function parseProxy(raw) {
  if (!raw) return undefined;
  const u = new URL(raw);
  const cfg = { server: `${u.protocol}//${u.host}` };
  if (u.username) cfg.username = decodeURIComponent(u.username);
  if (u.password) cfg.password = decodeURIComponent(u.password);
  return cfg;
}

(async () => {
  const raw = process.argv[2] || process.env.SOFA_PROXY || '';
  let proxy;
  try {
    proxy = parseProxy(raw);
  } catch (e) {
    console.log(`\n  Could not parse "${raw}" as a proxy URL: ${e.message}\n`);
    process.exit(2);
  }

  console.log(`\n  Route: ${proxy ? `proxy ${proxy.server}` : 'direct (this connection / VPN)'}`);

  const browser = await chromium.launch({ headless: true, proxy });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  const page = await ctx.newPage();

  // What address does Sofascore actually see us coming from?
  let egress = 'unknown';
  try {
    const r = await page.goto('https://api.ipify.org/', { timeout: 30000 });
    if (r) egress = (await page.innerText('body')).trim();
  } catch (e) {
    egress = `could not determine (${e.message.split('\n')[0]})`;
  }
  console.log(`  Egress IP: ${egress}`);

  let homeStatus = null;
  try {
    const r = await page.goto('https://www.sofascore.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    homeStatus = r ? r.status() : null;
  } catch (e) {
    console.log(`  Homepage: FAILED — ${e.message.split('\n')[0]}`);
  }
  if (homeStatus !== null) console.log(`  Homepage: HTTP ${homeStatus}`);

  // The real test: can we read the API from inside the page context?
  let apiStatus = null;
  let eventCount = null;
  if (homeStatus && homeStatus < 400) {
    await page.waitForTimeout(2500);
    try {
      const out = await page.evaluate(async () => {
        const r = await fetch('https://api.sofascore.com/api/v1/sport/football/events/live', {
          headers: { Accept: 'application/json' },
        });
        let n = null;
        try {
          const j = await r.json();
          n = (j.events || []).length;
        } catch (e) {}
        return { status: r.status, n };
      });
      apiStatus = out.status;
      eventCount = out.n;
    } catch (e) {
      console.log(`  API: FAILED — ${e.message.split('\n')[0]}`);
    }
  }
  if (apiStatus !== null) {
    console.log(`  API: HTTP ${apiStatus}${eventCount !== null ? ` (${eventCount} live matches)` : ''}`);
  }

  await browser.close();

  const ok = homeStatus && homeStatus < 400 && apiStatus === 200;
  if (ok) {
    console.log('\n  PASS — this address can read Sofascore.');
    if (proxy) console.log(`  Start the server with:  $env:SOFA_PROXY='${raw}'; npm start`);
    else console.log('  Start the server on this same connection:  npm start');
  } else if (homeStatus === 403) {
    console.log('\n  BLOCKED — Sofascore returned 403 at the edge for this address.');
    console.log('  Not fixable in code. Try a different VPN location or a residential proxy.');
  } else {
    console.log('\n  FAIL — could not reach Sofascore from this address (see errors above).');
  }
  console.log('');
  process.exit(ok ? 0 : 1);
})();
