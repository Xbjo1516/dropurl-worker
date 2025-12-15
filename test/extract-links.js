export async function extractLinks(page) {
  try {
    await page.waitForSelector("a[href]", { timeout: 5000 });
  } catch {}

  const hrefs = await page.$$eval("a[href]", as =>
    as.map(a => a.getAttribute("href")).filter(Boolean)
  );

  return [...new Set(hrefs)];
}
