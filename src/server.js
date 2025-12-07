// src/server.js
import express from "express";
import cors from "cors";

import { check404 } from "../test/404.js";
import { checkDuplicate } from "../test/duplicate.js";
import { checkSeo } from "../test/read-elements.js";

import { Client, GatewayIntentBits, Partials } from "discord.js";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DROPURL_API_BASE =
  process.env.DROPURL_API_BASE || "https://dropurl.vercel.app";

// ================== Express / Worker ==================

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

  // 1) 404
  if (normChecks.check404) {
    result.check404 = await safeRun("404", () => check404(urls));
  }

  // 2) Duplicate
  if (normChecks.duplicate) {
    result.duplicate = await safeRun("duplicate", () =>
      checkDuplicate(urls)
    );
  }

  // 3) SEO
  if (normChecks.seo) {
    result.seo = await safeRun("seo", () => checkSeo(urls));
  }

  return res.json({ error: false, result });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("DropURL worker listening on port", PORT);
});

// ================== Discord Bot – Multi-language ==================

// เก็บภาษาของแต่ละ user (in-memory)
const userLang = {}; // userLang[userId] = "th" | "en"

// template ข้อความสองภาษา
const MESSAGES = {
  th: {
    langSetTh: "ตั้งค่าภาษาเป็น **ไทย** 🇹🇭 เรียบร้อยแล้ว!",
    langSetEn: "ตั้งค่าภาษาเป็น **อังกฤษ** 🇺🇸 เรียบร้อยแล้ว!",
    langHelp: "เลือกภาษาได้ด้วยคำสั่ง `!lang th` หรือ `!lang en`",
    needUrl:
      "โปรดใส่ URL ด้วยนะ เช่น `!check https://example.com`",
    invalidUrl:
      "รูปแบบ URL ไม่ถูกต้องค่ะ ลองใช้แบบนี้ดูนะ `!check https://example.com`",
    checking: "กำลังตรวจลิงก์นี้ให้คุณนะครับ...\n<${url}>",
    apiError: "ตรวจลิงก์ไม่สำเร็จ: ${msg}",
    botError: "⚠️ มีข้อผิดพลาดภายในบอท ลองใหม่อีกครั้งนะครับ",
    resultTitle: "🔍 ผลตรวจสำหรับ: <${url}>",
    section404: "• **404 / Reachability**",
    sectionDup: "• **Duplicate**",
    sectionSeo: "• **SEO Overview**",
    noData: "(ไม่มีข้อมูล)",
    // 404 detail
    httpStatus: "- สถานะ HTTP: `${status}` ${label}",
    httpOk: "✅ ปกติ",
    httpWarn: "⚠️ อาจมีปัญหา",
    iframeCount: "- Iframe 404: ${count} รายการ",
    assetCount: "- Asset 404 (รูป / script / css): ${count} รายการ",
    unreachable:
      "- ผลรวม: ⚠️ หน้าเว็บเข้าถึงไม่ได้ อาจพิมพ์ URL ผิดหรือเว็บล่ม",
    // duplicate detail
    dupError: "⚠️ ตรวจ Duplicate ไม่สำเร็จ: ${msg}",
    dupNone: "- ยังไม่พบความซ้ำที่น่ากังวล",
    dupSome: "- พบกลุ่มเนื้อหาซ้ำที่น่าสนใจ ${groups} กลุ่ม (ตัวอย่าง ${sample} รายการ)",
    // seo detail
    seoError: "⚠️ วิเคราะห์ SEO ไม่สำเร็จ: ${msg}",
    seoUnreachable:
      "- ไม่สามารถวิเคราะห์ SEO ได้เพราะหน้าเว็บเข้าถึงไม่ได้",
    seoTitle: "- Title: ${ok} (ความยาว ${len} ตัวอักษร)",
    seoDesc: "- Description: ${ok} (ความยาว ${len} ตัวอักษร)",
    okWord: "✅ ดี",
    badWord: "⚠️ ควรปรับ",
    seoCanonical: "- Canonical: ${yesno}",
    seoHtmlLang: "- HTML lang: ${yesno}",
    yes: "✅ มี",
    no: "⚠️ ไม่มี",
    h1Summary: "- H1: ${count} ตัว ${extra}",
    h1ExtraGood: "(โอเค)",
    h1ExtraNone: "(ควรมีอย่างน้อย 1 ตัว)",
    h1ExtraMulti: "(มีหลายตัว อาจซ้ำซ้อน)",
    imgAlt: "- รูปภาพมี alt: ${percent}",
    imgAltNA: "ไม่มีข้อมูล",
    socialOg: "- Open Graph: ${yesno}",
    socialTw: "- Twitter Card: ${yesno}",
    schema: "- Structured data (schema.org): ${yesno}",
    linksSummary:
      "- ลิงก์ทั้งหมด: ${total} (ภายใน ${internal} | ภายนอก ${external})",
  },
  en: {
    langSetTh: "Language set to **Thai** 🇹🇭",
    langSetEn: "Language set to **English** 🇺🇸",
    langHelp: "You can change language with `!lang th` or `!lang en`",
    needUrl: "Please provide a URL, e.g. `!check https://example.com`",
    invalidUrl:
      "URL format seems invalid. Try something like `!check https://example.com`",
    checking: "Checking this URL for you...\n<${url}>",
    apiError: "Failed to check URL: ${msg}",
    botError: "⚠️ Bot error occurred, please try again.",
    resultTitle: "🔍 Scan result for: <${url}>",
    section404: "• **404 / Reachability**",
    sectionDup: "• **Duplicate**",
    sectionSeo: "• **SEO Overview**",
    noData: "(no data)",
    httpStatus: "- HTTP status: `${status}` ${label}",
    httpOk: "✅ OK",
    httpWarn: "⚠️ Might be problematic",
    iframeCount: "- Iframe 404: ${count} item(s)",
    assetCount: "- Asset 404 (images / scripts / css): ${count} item(s)",
    unreachable:
      "- Summary: ⚠️ Page not reachable. URL may be wrong or site is down.",
    dupError: "⚠️ Duplicate check failed: ${msg}",
    dupNone: "- No concerning duplicates found.",
    dupSome:
      "- Found duplicated content groups: ${groups} groups (sample ${sample} URLs)",
    seoError: "⚠️ SEO analysis failed: ${msg}",
    seoUnreachable:
      "- Cannot analyze SEO because the page is not reachable.",
    seoTitle: "- Title: ${ok} (length ${len} chars)",
    seoDesc: "- Description: ${ok} (length ${len} chars)",
    okWord: "✅ Good",
    badWord: "⚠️ Needs improvement",
    seoCanonical: "- Canonical: ${yesno}",
    seoHtmlLang: "- HTML lang: ${yesno}",
    yes: "✅ Present",
    no: "⚠️ Missing",
    h1Summary: "- H1: ${count} element(s) ${extra}",
    h1ExtraGood: "(looks good)",
    h1ExtraNone: "(should have at least one)",
    h1ExtraMulti: "(multiple H1s – might be confusing)",
    imgAlt: "- Images with alt: ${percent}",
    imgAltNA: "N/A",
    socialOg: "- Open Graph: ${yesno}",
    socialTw: "- Twitter Card: ${yesno}",
    schema: "- Structured data (schema.org): ${yesno}",
    linksSummary:
      "- Links: ${total} total (internal ${internal} | external ${external})",
  },
};

function getLangForUser(userId) {
  return userLang[userId] || "th"; // default ไทย
}

function tmpl(str, vars) {
  return str.replace(/\$\{([^}]+)}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : ""
  );
}

// validate + normalize URL (เติม https:// ถ้าไม่มี)
function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false };

  const withProto =
    raw.startsWith("http://") || raw.startsWith("https://")
      ? raw
      : `https://${raw}`;

  try {
    const u = new URL(withProto);
    return { ok: true, url: u.toString() };
  } catch {
    return { ok: false };
  }
}

// สร้างรายงาน Discord จากผล API (detail คล้ายตาราง)
function buildDiscordReport(url, apiResult, lang) {
  const M = MESSAGES[lang];
  const lines = [];

  const r404 = apiResult.check404?.results?.[0];
  const rDup = apiResult.duplicate;
  const rSeo = apiResult.seo?.results?.[0];

  lines.push(tmpl(M.resultTitle, { url }));

  // ----- 404 -----
  lines.push(M.section404);
  if (r404) {
    const status = r404.pageStatus ?? "no-response";
    const isBad =
      status === 0 ||
      status === null ||
      status === 404 ||
      status === 500 ||
      status === "no-response";

    lines.push(
      tmpl(M.httpStatus, {
        status,
        label: isBad ? M.httpWarn : M.httpOk,
      })
    );

    const iframeCount = Array.isArray(r404.iframe404s)
      ? r404.iframe404s.length
      : 0;
    const assetCount = Array.isArray(r404.assetFailures)
      ? r404.assetFailures.length
      : 0;

    lines.push(
      tmpl(M.iframeCount, {
        count: iframeCount,
      })
    );
    lines.push(
      tmpl(M.assetCount, {
        count: assetCount,
      })
    );

    if (r404.error || isBad) {
      lines.push(M.unreachable);
    }
  } else {
    lines.push(`  ${M.noData}`);
  }

  // ----- Duplicate -----
  lines.push("");
  lines.push(M.sectionDup);
  if (!rDup) {
    lines.push(`  ${M.noData}`);
  } else if (rDup.error) {
    lines.push(
      tmpl(M.dupError, {
        msg: rDup.errorMessage || rDup.rawError || "unknown",
      })
    );
  } else if (Array.isArray(rDup.results) && rDup.results.length > 0) {
    // นับกลุ่ม duplicates คร่าว ๆ
    let groupCount = 0;
    let sampleUrls = new Set();

    rDup.results.forEach((item) => {
      if (Array.isArray(item.frames)) {
        item.frames.forEach((f) => {
          if (Array.isArray(f.duplicates) && f.duplicates.length > 1) {
            groupCount++;
            f.duplicates.slice(0, 5).forEach((u) => sampleUrls.add(u));
          }
        });
      } else if (
        Array.isArray(item.duplicates) &&
        item.duplicates.length > 1
      ) {
        groupCount++;
        item.duplicates.slice(0, 5).forEach((u) => sampleUrls.add(u));
      }
    });

    if (groupCount === 0) {
      lines.push(M.dupNone);
    } else {
      lines.push(
        tmpl(M.dupSome, {
          groups: groupCount,
          sample: sampleUrls.size,
        })
      );
    }
  } else {
    lines.push(M.dupNone);
  }

  // ----- SEO -----
  lines.push("");
  lines.push(M.sectionSeo);
  if (!rSeo) {
    lines.push(`  ${M.noData}`);
  } else if (rSeo.error) {
    lines.push(
      tmpl(M.seoError, {
        msg: rSeo.errorMessage || rSeo.rawError || "unknown",
      })
    );
  } else if (rSeo.reachable === false) {
    lines.push(M.seoUnreachable);
  } else if (rSeo.meta && rSeo.meta.seoHints) {
    const h = rSeo.meta.seoHints;
    const meta = rSeo.meta;

    // title / description
    lines.push(
      tmpl(M.seoTitle, {
        ok: h.titleLengthOk ? M.okWord : M.badWord,
        len: h.titleLength ?? 0,
      })
    );
    lines.push(
      tmpl(M.seoDesc, {
        ok: h.descriptionLengthOk ? M.okWord : M.badWord,
        len: h.descriptionLength ?? 0,
      })
    );

    // canonical + html lang
    lines.push(
      tmpl(M.seoCanonical, {
        yesno: h.hasCanonical ? M.yes : M.no,
      })
    );
    lines.push(
      tmpl(M.seoHtmlLang, {
        yesno: h.hasHtmlLang ? M.yes : M.no,
      })
    );

    // H1
    const h1Count = meta.headings?.h1Count ?? 0;
    let extra;
    if (h1Count === 0) extra = M.h1ExtraNone;
    else if (h1Count === 1) extra = M.h1ExtraGood;
    else extra = M.h1ExtraMulti;

    lines.push(
      tmpl(M.h1Summary, {
        count: h1Count,
        extra,
      })
    );

    // image alt coverage
    if (
      h.imageAltCoverage !== null &&
      typeof h.imageAltCoverage === "number"
    ) {
      const percent = Math.round(h.imageAltCoverage * 100);
      lines.push(
        tmpl(M.imgAlt, {
          percent: `${percent}%`,
        })
      );
    } else {
      lines.push(
        tmpl(M.imgAlt, {
          percent: M.imgAltNA,
        })
      );
    }

    // Social tags
    lines.push(
      tmpl(M.socialOg, {
        yesno: h.hasOpenGraph ? M.yes : M.no,
      })
    );
    lines.push(
      tmpl(M.socialTw, {
        yesno: h.hasTwitterCard ? M.yes : M.no,
      })
    );

    // Schema
    lines.push(
      tmpl(M.schema, {
        yesno: h.hasSchema ? M.yes : M.no,
      })
    );

    // Links summary
    const links = meta.links || {};
    lines.push(
      tmpl(M.linksSummary, {
        total: links.total ?? 0,
        internal: links.internal ?? 0,
        external: links.external ?? 0,
      })
    );
  } else {
    lines.push(`  ${M.noData}`);
  }

  return lines.join("\n");
}

// ================== Discord Bot setup ==================

function setupDiscordBot() {
  if (!DISCORD_BOT_TOKEN) {
    console.log("DISCORD_BOT_TOKEN is not set, bot will not start.");
    return;
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

      const raw = message.content.trim();
      const lower = raw.toLowerCase();

      // ---------- เปลี่ยนภาษา: !lang th / !lang en ----------
      if (lower.startsWith("!lang")) {
        const parts = lower.split(/\s+/);
        const lang = parts[1];

        if (!lang || !["th", "en"].includes(lang)) {
          return message.reply(
            "Available languages: `th`, `en`"
          );
        }

        userLang[message.author.id] = lang;

        const M = MESSAGES[lang];
        await message.reply(
          lang === "th" ? M.langSetTh : M.langSetEn
        );
        await message.reply(M.langHelp);
        return;
      }

      // ---------- เช็ค URL: !check <url> ----------
      if (!lower.startsWith("!check ")) return;

      const lang = getLangForUser(message.author.id);
      const M = MESSAGES[lang];

      const urlPart = raw.slice("!check ".length).trim();
      if (!urlPart) {
        await message.reply(M.needUrl);
        return;
      }

      const norm = normalizeUrl(urlPart);
      if (!norm.ok || !norm.url) {
        await message.reply(M.invalidUrl);
        return;
      }
      const url = norm.url;

      const waitingMsg = await message.reply(
        tmpl(M.checking, { url })
      );

      // เรียก DropURL API ที่ production
      const resp = await fetch(`${DROPURL_API_BASE}/api/check-url`, {
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
        data = null;
      }

      if (!resp.ok || !data || data.error) {
        const msg =
          data?.errorMessage ||
          `status ${resp.status}`;
        await waitingMsg.edit(
          tmpl(M.apiError, { msg })
        );
        return;
      }

      const report = buildDiscordReport(url, data.result || {}, lang);
      await waitingMsg.edit(report);
    } catch (err) {
      console.error("bot messageCreate error:", err);
      const lang = getLangForUser(message.author?.id || "");
      const M = MESSAGES[lang];
      try {
        await message.reply(M.botError);
      } catch {
        // ignore
      }
    }
  });

  client
    .login(DISCORD_BOT_TOKEN)
    .catch((err) => console.error("Discord login failed:", err));
}

// start bot
setupDiscordBot();
