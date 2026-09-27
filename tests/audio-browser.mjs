import { chromium, webkit } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const harnessPath = fileURLToPath(new URL('../fixtures/audio/audio-harness.html', import.meta.url));
const url = process.argv[2] ?? `http://127.0.0.1:5173/@fs${harnessPath}`;
const results = [];
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  let browser;
  try {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url);
    await page.locator('#run').click();
    await page.waitForFunction(() => document.querySelector('#run')?.disabled === false);
    const output = await page.locator('#result').innerText();
    const report = JSON.parse(output);
    results.push({ name, browserVersion: browser.version(), status: 'passed', report });
    console.log(`${name} ${browser.version()}: passed, PCM ${report.loaded.decodedBytes} bytes`);
  } catch (error) {
    results.push({ name, status: 'failed', error: String(error) });
    console.error(`${name}: ${String(error).split('\n')[0]}`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}
await writeFile('/tmp/maijdata-audio-browser-results.json', JSON.stringify(results, null, 2));
