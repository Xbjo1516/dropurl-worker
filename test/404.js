// ./test/404.js
import { chromium } from "playwright";

/**
 * เช็ค 404 สำหรับลิงก์ที่ส่งมา (JS version)
 * @param {string[]} bannerUrls
 * @param {object} options
 */
export async function check404(bannerUrls = [], options = {}) {
  if (!Array.isArray(bannerUrls) || bannerUrls.length === 0) {
    throw new Error("bannerUrls ต้องเป็น array และต้องมีอย่างน้อย 1 URL");
  }

  const categoryUsed = options.category || "Manual Input links";

  // ใช้ chromium ให้ตรงกับที่เราติดตั้ง
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const allResults = [];

  for (const url of bannerUrls) {
    console.log(`\n🚀 Testing banner (404): ${url}`);

    const issues = {
      pageStatus: null,
      iframe404s: [],
      assetFailures: [],
      frames: [],
    };

    page.removeAllListeners("response");
    const failedRequests = new Set();

    page.on("response", async (res) => {
      const status = res.status();
      const urlRes = res.url();
      const type = res.request().resourceType();
      const frame = res.frame();

      // สถานะของ main page
      if (frame === page.mainFrame() && typeof status === "number") {
        issues.pageStatus = status;
      }

      if (status !== 404) return;
      if (failedRequests.has(urlRes)) return;
      failedRequests.add(urlRes);

      const isInIframe = frame && frame.parentFrame() !== null;

      if (isInIframe && type === "document") {
        // iframe ทั้งหน้า 404
        issues.iframe404s.push({ iframeUrl: frame.url(), status });
      } else if (isInIframe) {
        // asset ใน iframe 404 (ภาพ, js, css ฯลฯ)
        issues.assetFailures.push({
          url: urlRes,
          type,
          iframeUrl: frame.url(),
          status,
        });
      }
    });

    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      const st = response ? response.status() : undefined;
      if (typeof st === "number") {
        issues.pageStatus = st;
      }
    } catch (err) {
      console.log(
        "Playwright goto failed (will mark as unreachable):",
        err && err.message ? err.message : err
      );
    }

    await page.waitForTimeout(1200);

    // เก็บข้อมูลทุก iframe เพื่อนำไปแสดงละเอียด
    for (const frame of page.frames()) {
      if (!frame.parentFrame()) continue; // ข้าม main frame

      let title = "";
      try {
        title = await frame.title().catch(() => "");
      } catch {}

      const hasError = issues.iframe404s.some(
        (f) => f.iframeUrl === frame.url()
      );

      issues.frames.push({
        url: frame.url(),
        name: frame.name(),
        title,
        hasError,
      });
    }

    allResults.push({
      url,
      pageStatus: issues.pageStatus,
      iframe404s: issues.iframe404s,
      assetFailures: issues.assetFailures,
      frames: issues.frames,
    });
  }

  await browser.close();

  return {
    category: categoryUsed,
    results: allResults,
  };
}
