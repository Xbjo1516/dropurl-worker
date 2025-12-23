import { firefox } from "playwright";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

function getRootUrl(inputUrl) {
  try {
    const u = new URL(inputUrl);
    return `${u.protocol}//${u.hostname}/`;
  } catch {
    return inputUrl;
  }
}

async function urlExists(inputUrl) {
  try {
    const res = await fetch(inputUrl);
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function getMeta(page, selector, attr = "content") {
  try {
    if (page.isClosed()) return null;

    const el = page.locator(selector).first();
    if ((await el.count()) === 0) return null;

    if (attr === "text") {
      return (await el.textContent()) || null;
    }

    return (await el.getAttribute(attr)) || null;
  } catch (err) {
    console.warn(`[SEO] getMeta failed: ${selector}`, err.message);
    return null;
  }
}

async function getTwitterMeta(page, key) {
  try {
    if (page.isClosed()) return null;

    const el1 = page.locator(`meta[name='${key}']`).first();
    if (await el1.count()) return (await el1.getAttribute("content")) || null;

    const el2 = page.locator(`meta[property='${key}']`).first();
    if (await el2.count()) return (await el2.getAttribute("content")) || null;

    return null;
  } catch (err) {
    console.warn(`[SEO] twitter meta failed: ${key}`, err.message);
    return null;
  }
}

/**
 * วิเคราะห์ SEO ของหน้าเดียว (ใช้ร่วมกับ browser/page จากด้านนอก)
 * @param {import("playwright").Page} page
 * @param {string} url
 * @returns {Promise<any>}
 */
async function analyzeMeta(page, url) {
  console.log(`\n🚀 SEO check: ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  }).catch(() => { });

  if (page.isClosed()) {
    return {
      skipped: true,
      reason: "page_closed_or_blocked",
    };
  }

  const metaData = {};

  // helper เช็กว่ามีค่าไหม
  function mark(value) {
    return value ? `✅ ${value}` : "⛔ Not found";
  }

  // ----------- Basic meta -----------
  const titleRaw = await page.title().catch(() => "");
  const descriptionRaw = await getMeta(page, "meta[name='description']");
  const titleLength = titleRaw ? titleRaw.length : 0;
  const descLength = descriptionRaw ? descriptionRaw.length : 0;

  metaData.priority1 = {
    charset: mark(await getMeta(page, "meta[charset]", "charset")),
    viewport: mark(await getMeta(page, "meta[name='viewport']")),
    title: mark(titleRaw),
    description: mark(descriptionRaw),
    robots: mark(await getMeta(page, "meta[name='robots']")),
  };

  // ----------- Open Graph -----------
  metaData.openGraph = {
    "og:title": mark(await getMeta(page, "meta[property='og:title']")),
    "og:description": mark(
      await getMeta(page, "meta[property='og:description']")
    ),
    "og:image": mark(await getMeta(page, "meta[property='og:image']")),
    "og:url": mark(await getMeta(page, "meta[property='og:url']")),
    "og:type": mark(await getMeta(page, "meta[property='og:type']")),
  };

  // ----------- Twitter Card -----------
  metaData.twitter = {
    "twitter:card": mark(await getTwitterMeta(page, "twitter:card")),
    "twitter:title": mark(await getTwitterMeta(page, "twitter:title")),
    "twitter:description": mark(
      await getTwitterMeta(page, "twitter:description")
    ),
    "twitter:image": mark(await getTwitterMeta(page, "twitter:image")),
  };

  // ----------- Favicon / Robots / Sitemap -----------
  metaData.other = {
    favicon: mark(await getMeta(page, "link[rel='icon']", "href")),
  };

  try {
    const base = new URL(url).origin;
    const robots = await fetch(base + "/robots.txt");
    metaData.other["robots.txt"] =
      robots.status === 200 ? `✅ ${base}/robots.txt` : "⛔ Not found";

    const sitemap = await fetch(base + "/sitemap.xml");
    metaData.other["sitemap.xml"] =
      sitemap.status === 200 ? `✅ ${base}/sitemap.xml` : "⛔ Not found";
  } catch {
    metaData.other["robots.txt"] = "⛔ Not found";
    metaData.other["sitemap.xml"] = "⛔ Not found";
  }

  metaData.priority2 = {
    "theme-color": mark(await getMeta(page, "meta[name='theme-color']")),
    author: mark(await getMeta(page, "meta[name='author']")),
    "content-type": mark(
      await getMeta(page, "meta[http-equiv='Content-Type']")
    ),
  };

  // ----------- เพิ่ม SEO checks ที่ช่วยเรื่อง ranking -----------

  // 1) Canonical URL
  const canonicalHref = await getMeta(page, "link[rel='canonical']", "href");
  metaData.canonical = {
    value: canonicalHref || null,
    status: canonicalHref ? "✅ found" : "⛔ missing",
  };

  // 2) <html lang="">
  const htmlLang = await page
    .locator("html")
    .first()
    .getAttribute("lang")
    .catch(() => null);
  metaData.lang = {
    htmlLang: htmlLang || null,
    hasHtmlLang: !!htmlLang,
  };


  // 3) Headings (H1 / H2 / H3)
  let headingInfo = {
    h1Count: 0,
    h1Texts: [],
    h2Count: 0,
    h3Count: 0,
  };

  try {
    headingInfo = await page.evaluate(() => {
      const h1s = Array.from(document.querySelectorAll("h1"));
      const h2s = Array.from(document.querySelectorAll("h2"));
      const h3s = Array.from(document.querySelectorAll("h3"));
      return {
        h1Count: h1s.length,
        h1Texts: h1s.map(el => (el.textContent || "").trim()),
        h2Count: h2s.length,
        h3Count: h3s.length,
      };
    });
  } catch {
    // page closed → ใช้ค่า default
  }

  metaData.headings = {
    h1Count: headingInfo.h1Count,
    h1Texts: headingInfo.h1Texts,
    h2Count: headingInfo.h2Count,
    h3Count: headingInfo.h3Count,
    hasH1: headingInfo.h1Count > 0,
    multipleH1: headingInfo.h1Count > 1,
  };

  // 4) Images alt
  let imageInfo = { total: 0, withAlt: 0, withoutAlt: 0 };
  try {
    imageInfo = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      let withAlt = 0;
      let withoutAlt = 0;
      imgs.forEach(img => {
        const alt = img.getAttribute("alt");
        if (alt && alt.trim()) withAlt++;
        else withoutAlt++;
      });
      return { total: imgs.length, withAlt, withoutAlt };
    });
  } catch { }
  metaData.images = imageInfo;

  // 5) Internal / External links
  let linkInfo = { total: 0, internal: 0, external: 0, follow: 0, nofollow: 0 };
  try {
    linkInfo = await page.evaluate((pageUrl) => {
      const aTags = Array.from(document.querySelectorAll("a[href]"));
      let internal = 0, external = 0, follow = 0, nofollow = 0;
      const origin = new URL(pageUrl).origin;

      aTags.forEach((a) => {
        const href = a.href;
        if (!href) return;
        if (href.startsWith(origin)) internal++;
        else if (/^https?:\/\//i.test(href)) external++;

        const rel = (a.getAttribute("rel") || "").toLowerCase();
        if (rel.includes("nofollow")) nofollow++;
        else follow++;
      });

      return { total: aTags.length, internal, external, follow, nofollow };
    }, url);
  } catch { }
  metaData.links = linkInfo;

  // 6) Structured Data (schema.org via JSON-LD)
  let schemaInfo = { hasSchema: false, types: [] };
  try {
    schemaInfo = await page.evaluate(() => {
      const scripts = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]')
      );
      const types = [];
      scripts.forEach((s) => {
        try {
          const json = JSON.parse(s.textContent || "{}");
          if (json["@type"]) types.push(json["@type"]);
          if (json["@graph"]) {
            json["@graph"].forEach(g => g["@type"] && types.push(g["@type"]));
          }
        } catch { }
      });
      return { hasSchema: scripts.length > 0, types };
    });
  } catch { }
  metaData.schema = schemaInfo;

  // 7) Hint สำหรับ SEO score (ไม่ใช่คะแนนจริง แต่เป็น checklist)
  metaData.seoHints = {
    titleLength,
    titleLengthOk: titleLength >= 30 && titleLength <= 65, // แนะนำ
    descriptionLength: descLength,
    descriptionLengthOk: descLength >= 70 && descLength <= 160,
    hasCanonical: !!canonicalHref,
    hasHtmlLang: !!htmlLang,
    hasH1: headingInfo.h1Count > 0,
    multipleH1: headingInfo.h1Count > 1,
    hasOpenGraph: Object.values(metaData.openGraph).some((v) =>
      String(v).startsWith("✅")
    ),
    hasTwitterCard: Object.values(metaData.twitter).some((v) =>
      String(v).startsWith("✅")
    ),
    hasSchema: schemaInfo.hasSchema,
    imageAltCoverage:
      imageInfo.total > 0 ? imageInfo.withAlt / imageInfo.total : null,
  };

  return metaData;
}

/**
 * ฟังก์ชันหลักสำหรับใช้จาก API / โค้ดอื่น
 * ไม่เขียนไฟล์ ไม่สร้างโฟลเดอร์ ใด ๆ
 *
 * @param {string[]} bannerUrls
 * @returns {Promise<{ results: any[] }>}
 */
export async function checkSeo(bannerUrls = []) {
  if (!Array.isArray(bannerUrls) || bannerUrls.length === 0) {
    throw new Error("bannerUrls ต้องเป็น array และต้องมีอย่างน้อย 1 URL");
  }

  const browser = await firefox.launch({ headless: true });
  const results = [];

  for (const originalUrl of bannerUrls) {
    const rootUrl = getRootUrl(originalUrl);

    console.log(`\n🔍 Check URL: ${rootUrl}`);

    const ok = await urlExists(rootUrl);
    if (!ok) {
      results.push({
        originalUrl,
        rootUrl,
        reachable: false,
        error: "URL not reachable",
      });
      continue;
    }

    let metaData;

    try {
      const tab = await browser.newPage({ userAgent: USER_AGENT });
      try {
        metaData = await analyzeMeta(tab, rootUrl);
      } finally {
        await tab.close();
      }
    } catch (err) {
      console.warn("[SEO] analyzeMeta crashed:", err.message);
      metaData = {
        skipped: true,
        reason: "analyze_failed",
      };
    }

    results.push({
      originalUrl,
      rootUrl,
      reachable: true,
      meta: metaData,
    });
  }
  try {
    // loop + logic ทั้งหมด
    return { results };
  } finally {
    await browser.close();
  }
}
