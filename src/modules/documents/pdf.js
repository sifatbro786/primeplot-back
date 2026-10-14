import puppeteer from 'puppeteer';
import { env } from '#config/env.js';
import { logger } from '#config/logger.js';
import { AppError } from '#shared/errors/AppError.js';

/**
 * HTML → A4 PDF with headless Chrome (D1, ARCHITECTURE §6.6 / §8): ONE shared browser,
 * launched on first use, at most 2 pages at a time, a hard timeout per document. The page
 * HTML is self-contained (fonts and images inlined), so Chrome needs no network at all —
 * requests are blocked to keep printing deterministic and safe.
 */
const log = logger.child({ module: 'pdf' });
const MAX_PAGES = 2;

let browserPromise = null;
let active = 0;
const waiting = [];

async function browser() {
  browserPromise ??= puppeteer
    .launch({
      headless: true,
      ...(env.PDF_CHROME_PATH && { executablePath: env.PDF_CHROME_PATH }),
      args: [
        '--disable-dev-shm-usage', // small /dev/shm on VPS containers
        '--font-render-hinting=none',
        ...(env.PDF_NO_SANDBOX ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      ],
    })
    .then((b) => {
      b.on('disconnected', () => {
        browserPromise = null;
      });
      return b;
    })
    .catch((err) => {
      browserPromise = null;
      log.error({ err: { message: err.message } }, 'Chrome failed to start');
      throw new AppError(
        'PDF printing is not available on this server (Chrome could not start). See PDF_CHROME_PATH in .env.example.',
        { statusCode: 503, code: 'PDF_UNAVAILABLE', cause: err },
      );
    });
  return browserPromise;
}

async function slot() {
  if (active < MAX_PAGES) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
  active += 1;
}

function release() {
  active -= 1;
  waiting.shift()?.();
}

/** Render a full HTML document to a PDF Buffer. */
export async function htmlToPdf(html) {
  const b = await browser();
  await slot();
  let page;
  try {
    page = await b.newPage();
    page.setDefaultTimeout(env.PDF_TIMEOUT_MS);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url === 'about:blank') req.continue();
      else req.abort();
    });
    await page.setContent(html, { waitUntil: 'load', timeout: env.PDF_TIMEOUT_MS });
    // eslint-disable-next-line no-undef -- runs in the browser
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      timeout: env.PDF_TIMEOUT_MS,
    });
    return Buffer.from(pdf);
  } finally {
    await page?.close().catch(() => {});
    release();
  }
}

/** Shutdown hook (server.js). */
export async function closePdf() {
  const p = browserPromise;
  browserPromise = null;
  if (p) await (await p.catch(() => null))?.close().catch(() => {});
}
