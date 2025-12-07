import { firefox } from "playwright";

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
  const el = page.locator(selector).first();
  if ((await el.count()) === 0) return null;
  if (attr === "text") return (await el.textContent()) || null;
  return (await el.getAttribute(attr)) || null;
}

async function getTwitterMeta(page, key) {
  const el1 = page.locator(`meta[name='${key}']`).first();
  if (await el1.count()) return (await el1.getAttribute("content")) || null;

  const el2 = page.locator(`meta[property='${key}']`).first();
  if (await el2.count()) return (await el2.getAttribute("content")) || null;

  const el3 = page.locator(`meta[property='${key}'][name]`).first();
  if (await el3.count()) return (await el3.getAttribute("content")) || null;

  return null;
}

/**
 * วิเคราะห์ SEO ของหน้าเดียว (ใช้ร่วมกับ browser/page จากด้านนอก)
 * @param {import("playwright").Page} page
 * @param {string} url
 * @returns {Promise<any>}
 */
async function analyzeMeta(page, url) {
  console.log(`\n🚀 SEO check: ${url}`);
  await page.goto(url, { waitUntil: "load" }).catch(() => {});

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
  const headingInfo = await page.evaluate(() => {
    const h1s = Array.from(document.querySelectorAll("h1"));
    const h2s = Array.from(document.querySelectorAll("h2"));
    const h3s = Array.from(document.querySelectorAll("h3"));

    return {
      h1Count: h1s.length,
      h1Texts: h1s.map((el) => (el.textContent || "").trim()),
      h2Count: h2s.length,
      h3Count: h3s.length,
    };
  });

  metaData.headings = {
    h1Count: headingInfo.h1Count,
    h1Texts: headingInfo.h1Texts,
    h2Count: headingInfo.h2Count,
    h3Count: headingInfo.h3Count,
    hasH1: headingInfo.h1Count > 0,
    multipleH1: headingInfo.h1Count > 1,
  };

  // 4) Images alt
  const imageInfo = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll("img"));
    let withAlt = 0;
    let withoutAlt = 0;
    imgs.forEach((img) => {
      const alt = img.getAttribute("alt");
      if (alt && alt.trim().length > 0) withAlt++;
      else withoutAlt++;
    });
    return {
      total: imgs.length,
      withAlt,
      withoutAlt,
    };
  });

  metaData.images = imageInfo;

  // 5) Internal / External links
  const linkInfo = await page.evaluate((pageUrl) => {
    const aTags = Array.from(document.querySelectorAll("a[href]"));

    let internal = 0;
    let external = 0;
    let follow = 0;
    let nofollow = 0;
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

  metaData.links = linkInfo;

  // 6) Structured Data (schema.org via JSON-LD)
  const schemaInfo = await page.evaluate(() => {
    const scripts = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]')
    );
    const types = [];
    scripts.forEach((s) => {
      try {
        const text = s.textContent || "{}";
        const json = JSON.parse(text);
        if (Array.isArray(json)) {
          json.forEach((item) => {
            if (item && item["@type"]) types.push(item["@type"]);
            if (item && item["@graph"]) {
              item["@graph"].forEach((g) => {
                if (g && g["@type"]) types.push(g["@type"]);
              });
            }
          });
        } else {
          if (json["@type"]) types.push(json["@type"]);
          if (json["@graph"]) {
            json["@graph"].forEach((g) => {
              if (g && g["@type"]) types.push(g["@type"]);
            });
          }
        }
      } catch {
        // ignore invalid JSON
      }
    });
    return {
      hasSchema: scripts.length > 0,
      types,
    };
  });

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
  const page = await browser.newPage();

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

    const metaData = await analyzeMeta(page, rootUrl);

    results.push({
      originalUrl,
      rootUrl,
      reachable: true,
      meta: metaData,
    });
  }

  await browser.close();

  return { results };
}
