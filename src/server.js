// src/server.js
import express from "express";
import cors from "cors";
import { check404 } from "../test/404.js";
import { checkDuplicate } from "../test/duplicate.js";
import { checkSeo } from "../test/read-elements.js";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { crawlAndCheck } from "../test/crawler.js";
import { summarizeWithAI } from "../lib/ai.js";


const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DROPURL_API_BASE = process.env.DROPURL_API_BASE;

// --------------------------------------
//  Express worker (404 / Duplicate / SEO)
// --------------------------------------

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
    result.duplicate = await safeRun("duplicate", () => checkDuplicate(urls));
  }

  if (normChecks.seo) {
    result.seo = await safeRun("seo", () => checkSeo(urls));
  }

  // สร้าง duplicateSummary ไว้ให้ frontend + bot ใช้ (ถ้ามีผล duplicate)
  try {
    const dupRes = result.duplicate;
    const items =
      dupRes?.results && Array.isArray(dupRes.results) ? dupRes.results : [];

    const hashToUrls = {};
    for (const item of items) {
      // จาก test/duplicate.js เรามี frames[].hash + urls
      if (Array.isArray(item.frames)) {
        for (const f of item.frames) {
          if (!f || !f.hash) continue;
          if (!hashToUrls[f.hash]) hashToUrls[f.hash] = new Set();
          if (Array.isArray(f.duplicates)) {
            f.duplicates.forEach((u) => u && hashToUrls[f.hash].add(String(u)));
          }
        }
      }
      // debug.sampleGroups (ถ้ามี)
      if (item.debug && Array.isArray(item.debug.sampleGroups)) {
        for (const sg of item.debug.sampleGroups) {
          if (!sg || !sg.hash || !Array.isArray(sg.urls)) continue;
          if (!hashToUrls[sg.hash]) hashToUrls[sg.hash] = new Set();
          sg.urls.forEach((u) => u && hashToUrls[sg.hash].add(String(u)));
        }
      }
    }

    const crossPageDuplicates = [];
    for (const [hash, setUrls] of Object.entries(hashToUrls)) {
      const arr = Array.from(setUrls);
      if (arr.length > 1) {
        crossPageDuplicates.push({ hash, urls: arr });
      }
    }

    const detected =
      items.some(
        (it) =>
          (Array.isArray(it.frames) && it.frames.length > 0) ||
          (Array.isArray(it.duplicates) && it.duplicates.length > 0)
      ) || crossPageDuplicates.length > 0;

    result.duplicateSummary = {
      detected,
      itemsCount: items.length,
      crossPageDuplicates,
    };
  } catch (e) {
    console.log("duplicateSummary build failed (non-fatal):", e);
  }

  return res.json({ error: false, result });
});

app.post("/crawl-check", async (req, res) => {
  const { url, maxDepth = 1, sameDomainOnly = true, checks } = req.body || {};

  if (!url) {
    return res.status(400).json({
      error: true,
      message: "url is required",
    });
  }

  // ✅ normalize checks เหมือน /run-checks
  const normChecks = {
    check404: !!(checks?.all || checks?.check404),
    duplicate: !!(checks?.all || checks?.duplicate),
    seo: !!(checks?.all || checks?.seo),
  };

  try {
    const data = await crawlAndCheck({
      startUrl: url,
      maxDepth: Number(maxDepth),
      sameDomainOnly: !!sameDomainOnly,
      checks: normChecks, // ✅ ใช้ตัวนี้
    });

    return res.json({
      error: false,
      result: data,
    });
  } catch (e) {
    console.error("crawl-check failed:", e);
    return res.status(500).json({
      error: true,
      message: e.message || "crawl failed",
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("DropURL worker listening on port", PORT);
});

// ----------------------
// Discord Bot + i18n
// ----------------------

// language per-user (userId -> "th" | "en")
const userLang = new Map();

/**
 * ข้อความ 2 ภาษา
 */
const TEXT = {
  th: {
    langSet: "เปลี่ยนภาษาเป็นภาษาไทยแล้ว ✅",
    langUsage: "ใช้คำสั่ง `!lang th` หรือ `!lang en` เพื่อเปลี่ยนภาษา",
    needUrl: "โปรดใส่ URL ด้วยนะ เช่น `!check https://example.com`",
    invalidUrl:
      "รูปแบบ URL ดูไม่ถูกต้องเลย ลองใส่แบบ `https://example.com` อีกครั้งนะ",
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

    // block titles
    basic: "Basic",
    indexing: "Indexing",
    structure: "Structure",
    social: "Social / Schema / Links",

    dupSummaryTitle: "Duplicate summary",
    dupGroupsTitle: "Groups (ตัวอย่าง)",
    dupNoGroup:
      "ไม่พบกลุ่มเนื้อหาซ้ำระหว่างหลายเพจ (cross-page duplicate)",

    // labels
    mainStatus: "main page HTTP status",
    iframe404: (n) => `iframe 404: ${n} รายการ`,
    asset404: (n) => `asset 404 ใน iframe: ${n} รายการ`,
    titleLen: (len, ok) =>
      `title length: ${len} chars${ok ? "" : " (ควรปรับ)"}`,
    descLen: (len, ok) =>
      `description length: ${len} chars${ok ? "" : " (ควรปรับ)"}`,
    h1Line: (c) => `H1: ${c} (${c === 0 ? "ไม่มี" : ""})`,
    headingsLine: (h1, h2, h3) => `Headings: H1=${h1}, H2=${h2}, H3=${h3}`,
    ogLine: (has) => `OpenGraph: ${has ? "✅ มี" : "⛔ ไม่มี"}`,
    twLine: (has) => `Twitter Card: ${has ? "✅ มี" : "⛔ ไม่มี"}`,
    schemaLine: (types) =>
      types && types.length
        ? `Schema.org: ✅ ${types.join(", ")}`
        : "Schema.org: ⛔ ไม่พบ",
    linksLine: (l) =>
      `links: total=${l.total || 0}, internal=${l.internal || 0}, external=${l.external || 0
      }`,
    unreachable: "URL not reachable",
  },

  en: {
    langSet: "Language set to English ✅",
    langUsage: "Use `!lang th` or `!lang en` to change language.",
    needUrl: "Please provide a URL, e.g. `!check https://example.com`",
    invalidUrl:
      "This doesn't look like a valid URL. Try something like `https://example.com`.",
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

    dupSummaryTitle: "Duplicate summary",
    dupGroupsTitle: "Groups (sample)",
    dupNoGroup: "No cross-page duplicate groups detected.",

    mainStatus: "main page HTTP status",
    iframe404: (n) => `iframe 404: ${n} item(s)`,
    asset404: (n) => `iframe asset 404: ${n} item(s)`,
    titleLen: (len, ok) =>
      `title length: ${len} chars${ok ? "" : " (should be adjusted)"}`,
    descLen: (len, ok) =>
      `description length: ${len} chars${ok ? "" : " (should be adjusted)"}`,
    h1Line: (c) => `H1: ${c} (${c === 0 ? "none" : ""})`,
    headingsLine: (h1, h2, h3) => `Headings: H1=${h1}, H2=${h2}, H3=${h3}`,
    ogLine: (has) => `OpenGraph: ${has ? "✅ present" : "⛔ missing"}`,
    twLine: (has) => `Twitter Card: ${has ? "✅ present" : "⛔ missing"}`,
    schemaLine: (types) =>
      types && types.length
        ? `Schema.org: ✅ ${types.join(", ")}`
        : "Schema.org: ⛔ not found",
    linksLine: (l) =>
      `links: total=${l.total || 0}, internal=${l.internal || 0}, external=${l.external || 0
      }`,
    unreachable: "URL not reachable",
  },
};

/**
 * สร้างข้อความรายงานสรุป เหมือนตารางผลในเว็บ แต่ในรูปแบบโค้ดบล็อก
 */
function buildReport({ r404, rDup, dupSummary, rSeo, url, lang }) {
  const t = TEXT[lang] || TEXT.th;
  const lines = [];

  lines.push(t.header(url));
  lines.push(""); // blank line

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

    lines.push(`• ${ok404 ? t.s404_ok : t.s404_warn}`);
    lines.push("```");
    lines.push(t.basic);
    lines.push(`- ${t.mainStatus}: ${status}`);
    lines.push(`- ${t.iframe404(hasIframe404 ? r404.iframe404s.length : 0)}`);
    lines.push(`- ${t.asset404(hasAsset404 ? r404.assetFailures.length : 0)}`);
    lines.push("```");
  } else {
    lines.push(`• 404 – ${t.noData}`);
  }

  lines.push(""); // blank line

  // ---------- Duplicate ----------
  if (rDup) {
    if (rDup.error) {
      lines.push(`• ${t.sDup_error}`);
    } else {
      const summary = dupSummary || {};
      const detected = !!summary.detected;
      const groups = Array.isArray(summary.crossPageDuplicates)
        ? summary.crossPageDuplicates
        : [];

      lines.push(`• ${detected ? t.sDup_warn : t.sDup_ok}`);

      lines.push("```");
      lines.push(t.dupSummaryTitle);
      lines.push(
        `- pages scanned: ${summary.itemsCount ?? (rDup.results || []).length}`
      );
      lines.push(`- groups with duplicates: ${groups.length}`);

      lines.push("");
      lines.push(t.dupGroupsTitle);

      if (!groups.length) {
        lines.push(`- ${t.dupNoGroup}`);
      } else {
        groups.slice(0, 3).forEach((g, idx) => {
          const urls = Array.isArray(g.urls) ? g.urls : [];
          lines.push(
            `- #${idx + 1}: ${urls.length} URL(s) (hash: ${g.hash ? g.hash.slice(0, 8) : "n/a"
            })`
          );
          urls.slice(0, 4).forEach((u) => {
            lines.push(`    • ${u}`);
          });
        });
        if (groups.length > 3) {
          lines.push(`- ... (${groups.length - 3} more group(s))`);
        }
      }

      lines.push("```");
    }
  } else {
    lines.push(`• Duplicate – ${t.noData}`);
  }

  lines.push(""); // blank line

  // ---------- SEO ----------
  if (rSeo && rSeo.meta) {
    const meta = rSeo.meta;
    const h = meta.seoHints || {};
    const headings = meta.headings || {};
    const schema = meta.schema || {};
    const links = meta.links || {};
    const langInfo = meta.lang || {};

    const warnSeo =
      !h.titleLengthOk ||
      !h.descriptionLengthOk ||
      !h.hasCanonical ||
      !h.hasHtmlLang ||
      !h.hasH1 ||
      h.multipleH1 ||
      !h.hasOpenGraph ||
      !h.hasTwitterCard ||
      !h.hasSchema;

    lines.push(`• ${warnSeo ? t.sSeo_warn : t.sSeo_ok}`);
    lines.push("```");

    // Basic
    lines.push(t.basic);
    lines.push(`- title: ${meta.priority1?.title ?? t.noData}`);
    lines.push(`- description: ${meta.priority1?.description ?? t.noData}`);
    if (typeof h.titleLength === "number") {
      lines.push("- " + t.titleLen(h.titleLength, !!h.titleLengthOk));
    }
    if (typeof h.descriptionLength === "number") {
      lines.push("- " + t.descLen(h.descriptionLength, !!h.descriptionLengthOk));
    }

    lines.push("");
    // Indexing
    lines.push(t.indexing);
    lines.push(`- canonical: ${meta.canonical?.status ?? "missing"}`);
    lines.push(
      `- html lang: ${langInfo.htmlLang ? `✅ ${langInfo.htmlLang}` : "⛔ Not found"
      }`
    );
    lines.push(`- robots.txt: ${meta.other?.["robots.txt"] ?? t.noData}`);
    lines.push(`- sitemap.xml: ${meta.other?.["sitemap.xml"] ?? t.noData}`);

    lines.push("");
    // Structure
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
    // Social / Schema / Links
    lines.push(t.social);
    lines.push("- " + t.ogLine(!!h.hasOpenGraph));
    lines.push("- " + t.twLine(!!h.hasTwitterCard));
    lines.push("- " + t.schemaLine(schema.types));
    lines.push("- " + t.linksLine(links));

    lines.push("```");
  } else if (rSeo && rSeo.error) {
    lines.push(`• SEO – ⚠️ ${rSeo.errorMessage || t.noData}`);
  } else {
    lines.push(`• SEO – ${t.noData}`);
  }

  return lines.join("\n");
}

// --------------------
// Discord bot setup
// --------------------
function setupDiscordBot() {
  if (!DISCORD_BOT_TOKEN) {
    console.log("DISCORD_BOT_TOKEN is not set, bot will not start.");
    return;
  }
  if (!DROPURL_API_BASE) {
    console.log(
      "DROPURL_API_BASE is not set, bot will call default DropURL domain."
    );
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, () => {
    console.log(`🤖 Discord bot logged in as ${client.user.tag}`);
  });

  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;

      const content = message.content.trim();

      // ----- language command -----
      if (content.toLowerCase().startsWith("!lang")) {
        const [, arg] = content.split(/\s+/, 2);
        const lang = (arg || "").toLowerCase();

        if (lang === "th" || lang === "en") {
          userLang.set(message.author.id, lang);
          await message.reply(TEXT[lang].langSet);
        } else {
          await message.reply(
            `${TEXT.th.langUsage}\n${TEXT.en.langUsage}`
          );
        }
        return;
      }

      const lang = userLang.get(message.author.id) || "th";
      const t = TEXT[lang];

      // ----- !check -----
      if (!content.toLowerCase().startsWith("!check ")) return;

      const urlRaw = content.slice("!check ".length).trim();
      if (!urlRaw) {
        await message.reply(t.needUrl);
        return;
      }

      // validate URL
      let url = urlRaw;
      try {
        if (!/^https?:\/\//i.test(url)) {
          url = `https://${url}`;
        }
        new URL(url);
      } catch {
        await message.reply(t.invalidUrl);
        return;
      }

      const waitingMsg = await message.reply(t.checking(url));

      const apiBase = DROPURL_API_BASE || "https://dropurl.vercel.app";
      const resp = await fetch(`${apiBase}/api/check-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: [url],
          checks: { all: true },
        }),
      });

      let data;
      try {
        data = await resp.json();
      } catch {
        await waitingMsg.edit(t.checkFailed("invalid JSON from API"));
        return;
      }

      if (!resp.ok || data.error) {
        await waitingMsg.edit(
          t.checkFailed(data?.errorMessage || `HTTP ${resp.status}`)
        );
        return;
      }

      const result = data.result || {};
      const r404 = result.check404?.results?.[0];
      const rSeo = result.seo?.results?.[0];
      const rDup = result.duplicate;
      const dupSummary = result.duplicateSummary;

      // --------------------
      // Build AI summary meta
      // --------------------
      const issueDetails = [];

      // 404
      if (r404) {
        const has404 =
          (Array.isArray(r404.iframe404s) && r404.iframe404s.length > 0) ||
          (Array.isArray(r404.assetFailures) && r404.assetFailures.length > 0) ||
          (typeof r404.pageStatus === "number" && r404.pageStatus >= 400);

        if (has404) {
          issueDetails.push({
            type: "404",
            urls: [url],
          });
        }
      }

      // Duplicate
      if (dupSummary?.detected && dupSummary.crossPageDuplicates?.length) {
        issueDetails.push({
          type: "duplicate",
          urls: dupSummary.crossPageDuplicates.flatMap((g) => g.urls).slice(0, 5),
          note: "Multiple pages share identical or very similar content",
        });
      }

      // SEO
      if (rSeo?.meta?.seoHints) {
        const h = rSeo.meta.seoHints;
        const hasSeoIssue =
          !h.titleLengthOk ||
          !h.descriptionLengthOk ||
          !h.hasCanonical ||
          !h.hasH1 ||
          !h.hasOpenGraph ||
          !h.hasTwitterCard;
          
        if (hasSeoIssue) {
          const seoProblems = [];

          if (!h.hasViewport) seoProblems.push("viewport meta tag is missing");
          if (!h.hasH1) seoProblems.push("no H1 heading on the page");
          if (!h.titleLengthOk)
            seoProblems.push(`title length is ${h.titleLength} characters`);
          if (!h.descriptionLengthOk)
            seoProblems.push(
              `description length is ${h.descriptionLength} characters`
            );
          if (!h.hasOpenGraph) seoProblems.push("Open Graph tags are missing");
          if (!h.hasTwitterCard) seoProblems.push("Twitter Card meta is missing");
          if (!h.hasSchema) seoProblems.push("Structured Data (Schema.org) is missing");
          if (typeof h.imageAltCoverage === "number" && h.imageAltCoverage < 0.5) {
            seoProblems.push(
              `image alt coverage is low (${Math.round(
                h.imageAltCoverage * 100
              )}%)`
            );
          }

          issueDetails.push({
            type: "seo",
            urls: [url],
            note: seoProblems.join("; "),
          });
        }
      }

      const aiMeta = {
        urls: [url],
        has404: issueDetails.some((i) => i.type === "404"),
        hasDuplicate: issueDetails.some((i) => i.type === "duplicate"),
        hasSeoIssues: issueDetails.some((i) => i.type === "seo"),
        issueDetails,
      };

      const report = buildReport({ r404, rDup, dupSummary, rSeo, url, lang });

      let aiSummary = "";
      try {
        aiSummary = await summarizeWithAI(aiMeta, lang);
      } catch (e) {
        aiSummary = lang === "th"
          ? "ไม่สามารถสรุปด้วย AI ได้ในขณะนี้"
          : "AI summary is unavailable at the moment.";
      }

      const finalMessage =
        report +
        "\n\n🤖 **AI Summary**\n" +
        "```" +
        "\n" +
        aiSummary +
        "\n```";

      await waitingMsg.edit(finalMessage);
    } catch (err) {
      console.error("bot messageCreate error:", err);
      try {
        await message.reply(TEXT.th.botError);
      } catch { }
    }
  });

  client
    .login(DISCORD_BOT_TOKEN)
    .catch((err) => console.error("Discord login failed:", err));
}

setupDiscordBot();
