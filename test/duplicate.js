// /test/duplicate.js
import crypto from "crypto";
import { chromium } from "playwright";

function hashBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function getHostname(raw) {
  try {
    let s = String(raw || "").trim();
    if (!s) return null;
    if (!s.startsWith("http://") && !s.startsWith("https://")) {
      s = `https://${s}`;
    }
    return new URL(s).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function cleanHtml(html) {
  if (!html) return "";
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  html = html.replace(
    /<link[^>]+rel=["']?(?:preload|prefetch|modulepreload|dns-prefetch)["']?[^>]*>/gi,
    ""
  );
  html = html.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<meta[^>]*>/gi, "");
  html = html.replace(
    /\s(data-rsc|data-nextjs|nonce|data-?ssr|data-?props)=["'][^"']*["']/gi,
    ""
  );
  html = html.replace(/\?_rsc=[^"'\s>]+/gi, "");
  html = html.replace(/\s+/g, " ").trim();
  return html;
}

export async function checkDuplicate(urls = []) {
  const browser = await chromium.launch({ headless: true });
  const results = [];

  const primaryHosts = new Set();
  for (const u of urls || []) {
    const h = getHostname(u);
    if (h) primaryHosts.add(h);
  }
  console.log("DEBUG primaryHosts:", Array.from(primaryHosts));

  for (let i = 0; i < urls.length; i++) {
    const target = urls[i];
    const context = await browser.newContext();
    const page = await context.newPage();

    const hashMap = {};
    const responsesSeen = new Set();
    let responseCount = 0;
    const seenUrlsSample = [];

    page.on("response", async (response) => {
      try {
        responseCount++;
        const respUrl = response.url();
        const status = response.status();

        if (
          !seenUrlsSample.includes(respUrl) &&
          seenUrlsSample.length < 20
        ) {
          seenUrlsSample.push(respUrl);
        }

        if (
          respUrl.includes("/_next/") ||
          respUrl.includes("_rsc") ||
          respUrl.includes("sockjs-node") ||
          respUrl.includes("/api/")
        ) {
          return;
        }

        const host = getHostname(respUrl);
        if (!host || !primaryHosts.has(host)) {
          return;
        }

        const key = `${respUrl}::${status}`;
        if (responsesSeen.has(key)) return;
        responsesSeen.add(key);

        if (status < 200 || status >= 400) return;

        const ct = (response.headers()["content-type"] || "").toLowerCase();

        if (ct.includes("text/html")) {
          let text;
          try {
            text = await response.text();
          } catch {
            return;
          }
          if (!text) return;
          const cleaned = cleanHtml(text);
          const h = hashBuffer(Buffer.from(cleaned, "utf8"));
          if (!hashMap[h]) hashMap[h] = new Set();
          hashMap[h].add(respUrl);
        } else {
          let body;
          try {
            body = await response.body();
          } catch {
            return;
          }
          if (!body || body.length === 0) return;
          const MAX_BYTES = 5 * 1024 * 1024;
          if (body.length > MAX_BYTES) return;
          const h = hashBuffer(body);
          if (!hashMap[h]) hashMap[h] = new Set();
          hashMap[h].add(respUrl);
        }
      } catch {
        // ignore
      }
    });

    try {
      console.log("DEBUG: navigating to", target);
      await page.goto(target, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(1500);
      await autoScroll(page);
      await page.waitForTimeout(1000);

      const iframeSrcs = await page
        .evaluate(() =>
          Array.from(document.querySelectorAll("iframe[src]")).map(
            (f) => f.src
          )
        )
        .catch(() => []);

      console.log(
        "DEBUG: responseCount so far (events fired):",
        responseCount
      );
      console.log("DEBUG: sample response URLs (up to 20):", seenUrlsSample);
      console.log("DEBUG: iframeSrcs:", iframeSrcs);

      for (const src of (iframeSrcs || []).slice(0, 6)) {
        try {
          const cleanedSrc = src.replace(/\?_rsc=[^&]+/g, "");
          console.log("DEBUG: loading iframe src:", cleanedSrc);
          const p2 = await context.newPage();

          p2.on("response", async (r) => {
            try {
              const s = r.url();
              const status = r.status();

              if (status < 200 || status >= 400) return;
              if (s.includes("/_next/") || s.includes("_rsc")) return;

              const host = getHostname(s);
              if (!host || !primaryHosts.has(host)) {
                return;
              }

              const key = `${s}::${status}`;
              if (responsesSeen.has(key)) return;
              responsesSeen.add(key);

              const ctype = (r.headers()["content-type"] || "").toLowerCase();
              if (ctype.includes("text/html")) {
                let txt;
                try {
                  txt = await r.text();
                } catch {
                  return;
                }
                if (!txt) return;
                const cleaned = cleanHtml(txt);
                const hh = hashBuffer(Buffer.from(cleaned, "utf8"));
                if (!hashMap[hh]) hashMap[hh] = new Set();
                hashMap[hh].add(s);
              } else {
                let b;
                try {
                  b = await r.body();
                } catch {
                  return;
                }
                if (!b || b.length === 0) return;
                if (b.length > 5 * 1024 * 1024) return;
                const hh = hashBuffer(b);
                if (!hashMap[hh]) hashMap[hh] = new Set();
                hashMap[hh].add(s);
              }
            } catch {
              // ignore
            }
          });

          await p2
            .goto(cleanedSrc, { waitUntil: "networkidle", timeout: 30000 })
            .catch((e) => {
              console.log(
                "DEBUG: iframe navigation failed:",
                cleanedSrc,
                e && e.message ? e.message : e
              );
            });
          await p2.waitForTimeout(800);
          await p2.close();
        } catch (e) {
          console.log(
            "DEBUG: iframe processing error:",
            e && e.message ? e.message : e
          );
        }
      }

      const frames = [];
      Object.entries(hashMap).forEach(([h, setUrls]) => {
        const arr = Array.from(setUrls);
        if (arr.length > 1) {
          frames.push({ frameUrl: "page", duplicates: arr, hash: h });
        }
      });

      console.log(
        "DEBUG: hashed groups count:",
        Object.keys(hashMap).length
      );
      const sampleGroups = Object.entries(hashMap)
        .slice(0, 5)
        .map(([h, s]) => ({
          hash: h,
          urls: Array.from(s).slice(0, 5),
        }));
      console.log("DEBUG: sample hash groups (up to 5):", sampleGroups);

      results.push({
        url: target,
        frames,
        duplicates: frames.flatMap((f) => f.duplicates),
        debug: {
          responseCount,
          seenUrlsSample,
          iframeSrcs,
          hashedGroupCount: Object.keys(hashMap).length,
          sampleGroups,
        },
      });
    } catch (err) {
      results.push({
        url: target,
        errorMessage: err && err.message ? err.message : String(err),
        frames: [],
        duplicates: [],
        debug: { responseCount, seenUrlsSample },
      });
    } finally {
      try {
        await page.close();
      } catch { }
      try {
        await context.close();
      } catch { }
    }
  }

  try {
    await browser.close();
  } catch { }
  return { results };
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}
