// test/crawler.js
import { chromium } from "playwright";
import { extractLinks } from "./extract-links.js";

const maxUrlsPerDepth = {
  0: 1,
  1: 20,
  2: 50,
};

export async function crawlAndCheck({
  startUrl,
  maxDepth = 1,
  sameDomainOnly = true,
  maxUrls = 50,
}) {
  const visited = new Set();
  const visitedByDepth = {};
  const results = [];

  const startNormalized = normalizeUrl(startUrl);
  const startHost = new URL(startNormalized).hostname;

  const queue = [{ url: startNormalized, depth: 0, from: null }];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  try {
    while (queue.length > 0) {
      const current = queue.shift();

      const nextDepth = current.depth;

      // init counter
      if (visitedByDepth[nextDepth] === undefined) {
        visitedByDepth[nextDepth] = 0;
      }

      // ❌ ถ้า depth นี้เกิน limit แล้ว → ข้าม
      if (
        maxUrlsPerDepth[nextDepth] !== undefined &&
        visitedByDepth[nextDepth] >= maxUrlsPerDepth[nextDepth]
      ) {
        continue;
      }

      const url = current.url;

      if (visited.has(url)) continue;
      visited.add(url);

      // ✅ นับเฉพาะ URL ที่ถูก crawl จริง
      visitedByDepth[current.depth]++;

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

            const childDepth = current.depth + 1;

            // กัน depth เกิน maxDepth
            if (childDepth > maxDepth) continue;

            // กัน quota depth ถัดไป
            if (
              maxUrlsPerDepth[childDepth] !== undefined &&
              (visitedByDepth[childDepth] || 0) >= maxUrlsPerDepth[childDepth]
            ) {
              continue;
            }

            queue.push({
              url: nextUrl,
              depth: childDepth,
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
