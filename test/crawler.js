// test/crawler.js
import { chromium } from "playwright";
import { extractLinks } from "./extract-links.js";

export async function crawlAndCheck({
  startUrl,
  maxDepth = 1,
  sameDomainOnly = true,
  maxUrls = 100,
}) {
  const visited = new Set();
  const results = [];

  const startNormalized = normalizeUrl(startUrl);
  const startHost = new URL(startNormalized).hostname;

  const queue = [{ url: startNormalized, depth: 0, from: null }];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  try {
    while (queue.length > 0 && visited.size < maxUrls) {
      const current = queue.shift();
      const url = current.url;

      if (visited.has(url)) continue;
      visited.add(url);

      const page = await context.newPage();
      let status = null;
      let error = null;

      try {
        const res = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });

        status = res?.status() ?? null;

        // ---- crawl ต่อ ----
        if (current.depth < maxDepth) {
          const links = await extractLinks(page, url);

          for (const link of links) {
            if (!link) continue;

            if (
              link.startsWith("mailto:") ||
              link.startsWith("tel:") ||
              link.startsWith("javascript:") ||
              link.startsWith("#")
            ) {
              continue;
            }

            const nextUrl = normalizeUrl(link, url);
            if (!nextUrl) continue;

            if (sameDomainOnly && !isSameDomain(nextUrl, startHost)) continue;
            if (visited.has(nextUrl)) continue;

            queue.push({
              url: nextUrl,
              depth: current.depth + 1,
              from: url,
            });
          }
        }
      } catch (e) {
        error = e.message || String(e);
      } finally {
        await page.close();
      }

      // ✅ push result หลัง crawl หน้านี้เสร็จ
      results.push({
        url: normalizeUrl(url),
        status,
        depth: current.depth,
        from: current.from ? normalizeUrl(current.from) : null,
        error,
      });
    }
  } finally {
    await browser.close();
  }

  return {
    totalVisited: visited.size,
    results,
  };
}

// ---------------- utils ----------------

function normalizeUrl(raw, base) {
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    u.hash = "";
    u.search = ""; 
    return u.toString();
  } catch {
    return null;
  }
}

function isSameDomain(url, startHost) {
  try {
    const host = new URL(url).hostname;
    return host === startHost || host.endsWith("." + startHost);
  } catch {
    return false;
  }
}
