import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

await page.goto('http://localhost:4177', { waitUntil: 'networkidle' });
await page.mouse.move(220, 220);
await page.mouse.down();
await page.mouse.move(360, 290, { steps: 8 });
await page.mouse.move(540, 360, { steps: 8 });
await page.mouse.move(760, 440, { steps: 8 });
await page.mouse.up();
await page.screenshot({ path: 'visual-smoke-after-tear.png', fullPage: true });

if (errors.length || consoleErrors.length) {
  throw new Error(`Browser errors: ${errors.concat(consoleErrors).join('; ')}`);
}

await browser.close();
