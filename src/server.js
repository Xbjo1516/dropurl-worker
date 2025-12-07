// src/server.js
import express from "express";
import cors from "cors";
import { check404 } from "../test/404.js";
import { checkDuplicate } from "../test/duplicate.js";
import { checkSeo } from "../test/read-elements.js";

import { Client, GatewayIntentBits, Partials } from "discord.js";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DROPURL_API_BASE = process.env.DROPURL_API_BASE;

// ---------- Express worker (404 / Duplicate / SEO) ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.send("DropURL worker is running");
});

app.post("/run-checks", async (req, res) => {
  const { urls, checks } = req.body || {};

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({
      error: true,
      errorMessage: "urls must be a non-empty array",
    });
  }

  const normChecks = {
    all: !!checks?.all,
    check404: !!(checks?.all || checks?.check404),
    duplicate: !!(checks?.all || checks?.duplicate),
    seo: !!(checks?.all || checks?.seo),
  };

  const result = {};

  const safeRun = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[worker:${label}] failed`, err);
      return {
        error: true,
        errorMessage: `${label} check failed inside worker.`,
        rawError: err && err.message ? err.message : String(err),
      };
    }
  };

  if (normChecks.check404) {
    result.check404 = await safeRun("404", () => check404(urls));
  }

  if (normChecks.duplicate) {
    result.duplicate = await safeRun("duplicate", () =>
      checkDuplicate(urls)
    );
  }

  if (normChecks.seo) {
    result.seo = await safeRun("seo", () => checkSeo(urls));
  }

  return res.json({ error: false, result });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("DropURL worker listening on port", PORT);
});

// ---------- Discord Bot ----------

// ภาษา per-user ใน memory
const userLang = new Map(); // userId -> "th" | "en"

const TEXT = {
  th: {
    langSet: "เปลี่ยนภาษาเป็นภาษาไทยแล้ว ✅",
    langUsage: "ใช้คำสั่ง `!lang th` หรือ `!lang en` เพื่อเปลี่ยนภาษา",
    needUrl: "โปรดใส่ URL ด้วยนะ เช่น `!check https://example.com`",
    invalidUrl: "รูปแบบ URL ดูไม่ถูกต้องเลย ลองใส่แบบ `https://example.com` อีกครั้งนะ",
    checking: (url) => `กำลังตรวจลิงก์นี้ให้คุณนะครับ...\n<${url}>`,
    checkFailed: (msg) => `⚠️ ตรวจลิงก์ไม่สำเร็จ: ${msg}`,
    botError: "⚠️ มีข้อผิดพลาดภายในบอท ลองใหม่อีกครั้งนะครับ",
    header: (url) => `🔍 **ผลตรวจสำหรับ:** <${url}>`,

    // section titles
    s404_ok: "404 – ✅ ไม่พบปัญหาสำคัญ",
    s404_warn: "404 – ⚠️ อาจมีปัญหา 404 / โหลดไม่สำเร็จ",

    sDup_ok: "Duplicate – ✅ ยังไม่พบความซ้ำที่น่ากังวล",
    sDup_warn: "Duplicate – ⚠️ พบลิงก์หรือไฟล์ที่มีเนื้อหาซ้ำกันหลายที่",
    sDup_error: "Duplicate – ⚠️ ตรวจ Duplicate ไม่สำเร็จ",

    sSeo_ok: "SEO – ✅ โดยรวมค่อนข้างดี",
    sSeo_warn: "SEO – ⚠️ มีจุดที่ควรปรับปรุง",

    noData: "(ไม่มีข้อมูล)",

    // within code block
    basic: "Basic",
    indexing: "Indexing",
    structure: "Structure",
    social: "Social / Schema / Links",

    // misc labels
    mainStatus: "main page HTTP status",
    iframe404: (n) => `iframe 404: ${n} รายการ`,
    asset404: (n) => `asset 404 ใน iframe: ${n} รายการ`,

    titleLen: (len, ok) =>
      `title length: ${len} chars${ok ? "" : " (ควรปรับ)"}`,
    descLen: (len, ok) =>
      `description length: ${len} chars${ok ? "" : " (ควรปรับ)"}`,

    h1Line: (c) => `H1: ${c} (${c === 0 ? "ไม่มี" : ""})`,
    headingsLine: (h1, h2, h3) =>
      `Headings: H1=${h1}, H2=${h2}, H3=${h3}`,

    ogLine: (has) => `OpenGraph: ${has ? "✅ มี" : "⛔ ไม่มี"}`,
    twLine: (has) => `Twitter Card: ${has ? "✅ มี" : "⛔ ไม่มี"}`,
    schemaLine: (types) =>
      types && types.length
        ? `Schema.org: ✅ ${types.join(", ")}`
        : "Schema.org: ⛔ ไม่พบ",
    linksLine: (l) =>
      `links: total=${l.total || 0}, internal=${l.internal || 0}, external=${l.external || 0}`,

    unreachable: "URL not reachable",
  },

  en: {
    langSet: "Language set to English ✅",
    langUsage: "Use `!lang th` or `!lang en` to change language.",
    needUrl: "Please provide a URL, e.g. `!check https://example.com`",
    invalidUrl: "This doesn't look like a valid URL. Try something like `https://example.com`.",
    checking: (url) => `Checking this URL for you...\n<${url}>`,
    checkFailed: (msg) => `⚠️ Failed to check URL: ${msg}`,
    botError: "⚠️ Bot internal error, please try again.",
    header: (url) => `🔍 **Scan result for:** <${url}>`,

    s404_ok: "404 – ✅ No critical issues detected",
    s404_warn: "404 – ⚠️ Possible 404 / loading issues",

    sDup_ok: "Duplicate – ✅ No worrying duplicates found",
    sDup_warn: "Duplicate – ⚠️ Found duplicated content/assets",
    sDup_error: "Duplicate – ⚠️ Duplicate scan failed",

    sSeo_ok: "SEO – ✅ Overall looks good",
    sSeo_warn: "SEO – ⚠️ There are issues to improve",

    noData: "(no data)",

    basic: "Basic",
    indexing: "Indexing",
    structure: "Structure",
    social: "Social / Schema / Links",

    mainStatus: "main page HTTP status",
    iframe404: (n) => `iframe 404: ${n} item(s)`,
    asset404: (n) => `iframe asset 404: ${n} item(s)`,

    titleLen: (len, ok) =>
      `title length: ${len} chars${ok ? "" : " (should be adjusted)"}`,
    descLen: (len, ok) =>
      `description length: ${len} chars${ok ? "" : " (should be adjusted)"}`,

    h1Line: (c) => `H1: ${c} (${c === 0 ? "none" : ""})`,
    headingsLine: (h1, h2, h3) =>
      `Headings: H1=${h1}, H2=${h2}, H3=${h3}`,

    ogLine: (has) => `OpenGraph: ${has ? "✅ present" : "⛔ missing"}`,
    twLine: (has) => `Twitter Card: ${has ? "✅ present" : "⛔ missing"}`,
    schemaLine: (types) =>
      types && types.length
        ? `Schema.org: ✅ ${types.join(", ")}`
        : "Schema.org: ⛔ not found",
    linksLine: (l) =>
      `links: total=${l.total || 0}, internal=${l.internal || 0}, external=${l.external || 0}`,

    unreachable: "URL not reachable",
  },
};

function buildReport({ r404, rDup, rSeo, url, lang }) {
  const t = TEXT[lang] || TEXT.th;
  const lines = [];

  lines.push(t.header(url));
  lines.push(""); // blank line

  // ==== สถานะสำหรับตารางสรุป ====
  let status404Kind = "nodata"; // ok | warn | error | nodata
  let statusDupKind = "nodata";
  let statusSeoKind = "nodata";

  const tableStatusText = {
    ok: lang === "th" ? "✅ ปกติ" : "✅ OK",
    warn: lang === "th" ? "⚠️ พบปัญหา" : "⚠️ Issue",
    error: lang === "th" ? "⛔ ผิดพลาด" : "⛔ Error",
    nodata: lang === "th" ? "— ไม่มีข้อมูล —" : "— no data —",
  };

  // ---------- 404 ----------
  if (r404) {
    const status = r404.pageStatus ?? "no response";
    const hasIframe404 =
      Array.isArray(r404.iframe404s) && r404.iframe404s.length > 0;
    const hasAsset404 =
      Array.isArray(r404.assetFailures) && r404.assetFailures.length > 0;

    const ok404 =
      typeof status === "number" &&
      status >= 200 &&
      status < 400 &&
      !hasIframe404 &&
      !hasAsset404;

    status404Kind = ok404 ? "ok" : "warn";

    // bullet เดิม (สรุป)
    lines.push(`• ${ok404 ? t.s404_ok : t.s404_warn}`);
    lines.push(`  - ${t.mainStatus}: ${status}`);
    if (hasIframe404) {
      lines.push(`  - ${t.iframe404(r404.iframe404s.length)}`);
    }
    if (hasAsset404) {
      lines.push(`  - ${t.asset404(r404.assetFailures.length)}`);
    }

    // กรอบแบบ SEO
    lines.push("```");
    lines.push("404");
    lines.push("------");
    lines.push(`- ${t.mainStatus}: ${status}`);
    if (hasIframe404) {
      lines.push(`- ${t.iframe404(r404.iframe404s.length)}`);
    } else {
      lines.push(
        lang === "th" ? "- iframe 404: ไม่มี" : "- iframe 404: none"
      );
    }
    if (hasAsset404) {
      lines.push(`- ${t.asset404(r404.assetFailures.length)}`);
    } else {
      lines.push(
        lang === "th"
          ? "- iframe asset 404: ไม่มี"
          : "- iframe asset 404: none"
      );
    }
    lines.push("```");
  } else {
    lines.push(`• 404 – ${t.noData}`);
  }

  lines.push(""); // blank line

  // ---------- Duplicate ----------
  let hasDup = false;

  if (rDup) {
    if (rDup.error) {
      statusDupKind = "error";
      lines.push(`• ${t.sDup_error}`);
    } else if (Array.isArray(rDup.results) && rDup.results.length > 0) {
      hasDup = rDup.results.some(
        (it) => Array.isArray(it.duplicates) && it.duplicates.length > 1
      );
      statusDupKind = hasDup ? "warn" : "ok";
      lines.push(`• ${hasDup ? t.sDup_warn : t.sDup_ok}`);
    } else {
      statusDupKind = "ok";
      lines.push(`• ${t.sDup_ok}`);
    }

    // กรอบแบบ SEO
    lines.push("```");
    lines.push("Duplicate");
    lines.push("---------");

    if (rDup.error) {
      lines.push(
        `- ${lang === "th" ? "สถานะ" : "status"
        }: ERROR (${rDup.errorMessage || t.noData})`
      );
    } else if (Array.isArray(rDup.results) && rDup.results.length > 0) {
      const first = rDup.results[0];
      const dupCount = Array.isArray(first.duplicates)
        ? first.duplicates.length
        : 0;

      lines.push(
        `- URL: ${first.url || url || (lang === "th" ? "ไม่ระบุ" : "n/a")}`
      );
      lines.push(
        `- ${lang === "th" ? "จำนวนไฟล์/หน้าเนื้อหาซ้ำ" : "duplicate items"
        }: ${dupCount}`
      );

      if (dupCount > 0) {
        lines.push("");
        lines.push(
          lang === "th" ? "รายการที่ซ้ำ:" : "Duplicated resources:"
        );
        first.duplicates.slice(0, 10).forEach((u, idx) => {
          lines.push(`  ${idx + 1}. ${u}`);
        });
        if (dupCount > 10) {
          lines.push(
            lang === "th"
              ? `  ... และอีก ${dupCount - 10} รายการ`
              : `  ... and ${dupCount - 10} more`
          );
        }
      }
    } else {
      lines.push(
        lang === "th"
          ? "- ไม่พบรายการซ้ำในข้อมูลที่ส่งมา"
          : "- no duplicates in the given data"
      );
    }

    lines.push("```");
  } else {
    lines.push(`• Duplicate – ${t.noData}`);
  }

  lines.push(""); // blank line

  // ---------- SEO ----------
  let warnSeo = false;

  if (rSeo && rSeo.meta) {
    const meta = rSeo.meta;
    const h = meta.seoHints || {};
    const headings = meta.headings || {};
    const schema = meta.schema || {};
    const links = meta.links || {};
    const langInfo = meta.lang || {};

    warnSeo =
      !h.titleLengthOk ||
      !h.descriptionLengthOk ||
      !h.hasCanonical ||
      !h.hasHtmlLang ||
      !h.hasH1 ||
      h.multipleH1 ||
      !h.hasOpenGraph ||
      !h.hasTwitterCard ||
      !h.hasSchema;

    statusSeoKind = warnSeo ? "warn" : "ok";

    lines.push(`• ${warnSeo ? t.sSeo_warn : t.sSeo_ok}`);

    // code block แบบเดิม
    lines.push("```");
    lines.push(t.basic);
    lines.push(`- title: ${meta.priority1?.title ?? t.noData}`);
    lines.push(`- description: ${meta.priority1?.description ?? t.noData}`);
    if (typeof h.titleLength === "number") {
      lines.push("- " + t.titleLen(h.titleLength, !!h.titleLengthOk));
    }
    if (typeof h.descriptionLength === "number") {
      lines.push(
        "- " + t.descLen(h.descriptionLength, !!h.descriptionLengthOk)
      );
    }

    lines.push("");
    lines.push(t.indexing);
    lines.push(`- canonical: ${meta.canonical?.status ?? "missing"}`);
    lines.push(
      `- html lang: ${langInfo.htmlLang ? `✅ ${langInfo.htmlLang}` : "⛔ Not found"
      }`
    );
    lines.push(`- robots.txt: ${meta.other?.["robots.txt"] ?? t.noData}`);
    lines.push(`- sitemap.xml: ${meta.other?.["sitemap.xml"] ?? t.noData}`);

    lines.push("");
    lines.push(t.structure);
    lines.push("- " + t.h1Line(headings.h1Count ?? 0));
    lines.push(
      "- " +
      t.headingsLine(
        headings.h1Count ?? 0,
        headings.h2Count ?? 0,
        headings.h3Count ?? 0
      )
    );

    lines.push("");
    lines.push(t.social);
    lines.push("- " + t.ogLine(!!h.hasOpenGraph));
    lines.push("- " + t.twLine(!!h.hasTwitterCard));
    lines.push("- " + t.schemaLine(schema.types));
    lines.push("- " + t.linksLine(links));

    lines.push("```");
  } else if (rSeo && rSeo.error) {
    statusSeoKind = "error";
    lines.push(`• SEO – ⚠️ ${rSeo.errorMessage || t.noData}`);
  } else {
    lines.push(`• SEO – ${t.noData}`);
  }

  // ---------- ตารางสรุปผลลัพธ์ ----------
  lines.push("");
  lines.push("```");
  lines.push(
    lang === "th"
      ? "ภาพรวมการตรวจสอบ"
      : "Overall check summary"
  );
  lines.push("-----------------------");
  lines.push("");
  lines.push("Check      | Status");
  lines.push("-----------|----------------------");
  lines.push(
    `404        | ${tableStatusText[status404Kind] || tableStatusText.nodata}`
  );
  lines.push(
    `Duplicate  | ${tableStatusText[statusDupKind] || tableStatusText.nodata}`
  );
  lines.push(
    `SEO        | ${tableStatusText[statusSeoKind] || tableStatusText.nodata}`
  );
  lines.push("```");

  return lines.join("\n");
}
