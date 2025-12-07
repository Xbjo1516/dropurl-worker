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

  // ---------- 404 ----------
  if (r404) {
    const status = r404.pageStatus ?? "no response";
    const hasIframe404 = Array.isArray(r404.iframe404s) && r404.iframe404s.length > 0;
    const hasAsset404 = Array.isArray(r404.assetFailures) && r404.assetFailures.length > 0;

    const ok404 =
      typeof status === "number" &&
      status >= 200 &&
      status < 400 &&
      !hasIframe404 &&
      !hasAsset404;

    lines.push(`• ${ok404 ? t.s404_ok : t.s404_warn}`);
    lines.push(
      `  - ${t.mainStatus}: ${status}`
    );
    if (hasIframe404) {
      lines.push(`  - ${t.iframe404(r404.iframe404s.length)}`);
    }
    if (hasAsset404) {
      lines.push(`  - ${t.asset404(r404.assetFailures.length)}`);
    }
  } else {
    lines.push(`• 404 – ${t.noData}`);
  }

  lines.push(""); // blank line

  // ---------- Duplicate ----------
  if (rDup) {
    if (rDup.error) {
      lines.push(`• ${t.sDup_error}`);
    } else if (Array.isArray(rDup.results) && rDup.results.length > 0) {
      const hasDup = rDup.results.some(
        (it) => Array.isArray(it.duplicates) && it.duplicates.length > 1
      );
      lines.push(`• ${hasDup ? t.sDup_warn : t.sDup_ok}`);
    } else {
      lines.push(`• ${t.sDup_ok}`);
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

    // code block แบบในรูป
    lines.push("```");
    lines.push(t.basic);
    lines.push(
      `- title: ${meta.priority1?.title ?? t.noData}`
    );
    lines.push(
      `- description: ${meta.priority1?.description ?? t.noData}`
    );
    if (typeof h.titleLength === "number") {
      lines.push("- " + t.titleLen(h.titleLength, !!h.titleLengthOk));
    }
    if (typeof h.descriptionLength === "number") {
      lines.push("- " + t.descLen(h.descriptionLength, !!h.descriptionLengthOk));
    }

    lines.push("");
    lines.push(t.indexing);
    lines.push(
      `- canonical: ${meta.canonical?.status ?? "missing"}`
    );
    lines.push(
      `- html lang: ${langInfo.htmlLang ? `✅ ${langInfo.htmlLang}` : "⛔ Not found"}`
    );
    lines.push(
      `- robots.txt: ${meta.other?.["robots.txt"] ?? t.noData}`
    );
    lines.push(
      `- sitemap.xml: ${meta.other?.["sitemap.xml"] ?? t.noData}`
    );

    lines.push("");
    lines.push(t.structure);
    lines.push(
      "- " + t.h1Line(headings.h1Count ?? 0)
    );
    lines.push(
      "- " + t.headingsLine(
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
    lines.push(`• SEO – ⚠️ ${rSeo.errorMessage || t.noData}`);
  } else {
    lines.push(`• SEO – ${t.noData}`);
  }

  return lines.join("\n");
}

function setupDiscordBot() {
  if (!DISCORD_BOT_TOKEN) {
    console.log("DISCORD_BOT_TOKEN is not set, bot will not start.");
    return;
  }
  if (!DROPURL_API_BASE) {
    console.log("DROPURL_API_BASE is not set, bot will not call DropURL API.");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once("ready", () => {
    console.log(`🤖 Discord bot logged in as ${client.user.tag}`);
  });

  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;

      const content = message.content.trim();

      // ----- เปลี่ยนภาษา -----
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

      // ดัก URL format พิมพ์ผิด
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
          t.checkFailed(
            data?.errorMessage || `HTTP ${resp.status}`
          )
        );
        return;
      }

      const result = data.result || {};
      const r404 = result.check404?.results?.[0];
      const rSeo = result.seo?.results?.[0];
      const rDup = result.duplicate;

      const report = buildReport({ r404, rDup, rSeo, url, lang });
      await waitingMsg.edit(report);
    } catch (err) {
      console.error("bot messageCreate error:", err);
      try {
        await message.reply(TEXT.th.botError);
      } catch {}
    }
  });

  client
    .login(DISCORD_BOT_TOKEN)
    .catch((err) => console.error("Discord login failed:", err));
}

setupDiscordBot();
