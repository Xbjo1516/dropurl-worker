// src/server.js
import express from "express";
import cors from "cors";
import { check404 } from "../test/404.js";
import { checkDuplicate } from "../test/duplicate.js";
import { checkSeo } from "../test/read-elements.js";

import { Client, GatewayIntentBits, Partials } from "discord.js";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DROPURL_API_BASE = process.env.DROPURL_API_BASE;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------------- HTTP worker (ให้ DropURL เรียก /run-checks) ----------------
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

  return res.json({ error: false, result });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("DropURL worker listening on port", PORT);
});

// ======================= Discord Bot helpers =======================

// แปลง/เช็ก URL ที่ผู้ใช้พิมพ์ใน Discord
function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  let s = raw;
  if (!/^https?:\/\//i.test(s)) {
    s = "https://" + s;
  }

  try {
    // ถ้า new URL ไม่ผ่าน แสดงว่า URL ผิดรูป
    // (hostname ต้องมีอย่างน้อยจุดเดียว เช่น example.com)
    const u = new URL(s);
    if (!u.hostname || !u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// สร้างข้อความรายงานแบบละเอียดจาก result ของ /api/check-url
function buildDiscordReport(url, apiResult) {
  const lines = [];
  lines.push(`🔍 **ผลตรวจสำหรับ:** <${url}>`);

  const r404Block = apiResult?.check404;
  const rDupBlock = apiResult?.duplicate;
  const rSeoBlock = apiResult?.seo;

  // ---------------- 1) 404 ----------------
  if (
    r404Block &&
    Array.isArray(r404Block.results) &&
    r404Block.results.length
  ) {
    const item = r404Block.results[0];
    const status = item.pageStatus ?? null;
    const hasIframe404 = item.iframe404s?.length > 0;
    const hasAsset404 = item.assetFailures?.length > 0;
    const hasError =
      status === 404 ||
      status === 500 ||
      status === 0 ||
      hasIframe404 ||
      hasAsset404 ||
      !!item.error;

    lines.push("");
    lines.push(
      `**• 404** – ${hasError ? "⚠️ มีปัญหาบางอย่าง" : "✅ ไม่พบปัญหาสำคัญ"}`
    );

    const detail = [];
    if (status != null) {
      detail.push(`- main page HTTP status: ${status}`);
    } else {
      detail.push("- main page: ไม่มี HTTP response (อาจโหลดไม่สำเร็จ)");
    }

    if (item.error) {
      detail.push(`- error: ${item.error}`);
    }

    if (hasIframe404) {
      detail.push(`- iframe 404: ${item.iframe404s.length} รายการ`);
    }

    if (hasAsset404) {
      detail.push(`- asset 404 ภายใน iframe: ${item.assetFailures.length} รายการ`);
    }

    if (!detail.length) detail.push("- ไม่มีประเด็นสำคัญ");

    lines.push("```");
    lines.push(detail.join("\n"));
    lines.push("```");
  } else {
    lines.push("");
    lines.push("**• 404** – (ไม่มีข้อมูลการทดสอบ)");
  }

  // ---------------- 2) Duplicate ----------------
  if (rDupBlock) {
    if (rDupBlock.error) {
      lines.push("");
      lines.push(
        `**• Duplicate** – ⚠️ ${rDupBlock.errorMessage || "ตรวจไม่ได้"}`
      );
    } else if (Array.isArray(rDupBlock.results)) {
      const items = rDupBlock.results;
      let hasDup = false;
      const detail = [];

      items.forEach((it) => {
        const list = Array.isArray(it.duplicates) ? it.duplicates : [];
        if (list.length > 1) {
          hasDup = true;
          detail.push(`- ${it.url || "ไม่ทราบ URL"}: พบ ${list.length} รายการซ้ำ`);
          list.slice(0, 5).forEach((u) => {
            detail.push(`   • ${u}`);
          });
        }
      });

      lines.push("");
      lines.push(
        `**• Duplicate** – ${hasDup
          ? "⚠️ พบเนื้อหาหรือไฟล์ที่ซ้ำกันหลายที่"
          : "✅ ยังไม่พบความซ้ำที่น่ากังวล"
        }`
      );

      lines.push("```");
      if (detail.length) {
        lines.push(detail.join("\n"));
      } else {
        lines.push("- ไม่พบกลุ่มลิงก์/ไฟล์ที่ซ้ำกันชัดเจน");
      }
      lines.push("```");
    } else {
      lines.push("");
      lines.push("**• Duplicate** – (ไม่มีข้อมูลการทดสอบ)");
    }
  } else {
    lines.push("");
    lines.push("**• Duplicate** – (ไม่ได้เปิดการทดสอบ)");
  }

  // ---------------- 3) SEO ----------------
  if (
    rSeoBlock &&
    Array.isArray(rSeoBlock.results) &&
    rSeoBlock.results.length
  ) {
    const item = rSeoBlock.results[0];
    const reachable = item.reachable ?? true;
    const meta = item.meta || {};
    const p1 = meta.priority1 || {};
    const other = meta.other || {};
    const canonical = meta.canonical || {};
    const lang = meta.lang || {};
    const headings = meta.headings || {};
    const schema = meta.schema || {};
    const links = meta.links || {};
    const hints = meta.seoHints || {};

    const hasIssue =
      !reachable ||
      !hints.titleLengthOk ||
      !hints.descriptionLengthOk ||
      !hints.hasCanonical ||
      !hints.hasHtmlLang ||
      !hints.hasH1 ||
      hints.multipleH1;

    lines.push("");
    lines.push(
      `**• SEO** – ${hasIssue ? "⚠️ มีจุดที่ควรปรับปรุง" : "✅ ภาพรวมถือว่าโอเค"
      }`
    );

    const detail = [];

    detail.push("Basic");
    detail.push(`- title: ${p1.title || "⛔ ไม่มี"}`);
    detail.push(`- description: ${p1.description || "⛔ ไม่มี"}`);
    detail.push(
      `- title length: ${hints.titleLength ?? 0
      } chars (${hints.titleLengthOk ? "เหมาะสม" : "ควรปรับ"})`
    );
    detail.push(
      `- description length: ${hints.descriptionLength ?? 0
      } chars (${hints.descriptionLengthOk ? "เหมาะสม" : "ควรปรับ"})`
    );

    detail.push("");
    detail.push("Indexing");
    detail.push(
      `- canonical: ${canonical.status || (hints.hasCanonical ? "✅ มี" : "⛔ ไม่มี")}`
    );
    detail.push(
      `- html lang: ${lang.htmlLang ? `✅ ${lang.htmlLang}` : hints.hasHtmlLang ? "✅ ตั้งค่าแล้ว" : "⛔ ไม่มี"
      }`
    );
    detail.push(`- robots.txt: ${other["robots.txt"] || "⛔ Not found"}`);
    detail.push(`- sitemap.xml: ${other["sitemap.xml"] || "⛔ Not found"}`);

    detail.push("");
    detail.push("Structure");
    detail.push(
      `- H1: ${headings.h1Count ?? 0} (${hints.hasH1 ? "มี" : "ไม่มี"})`
    );
    if (hints.multipleH1) {
      detail.push("- ⚠️ มี H1 มากกว่า 1 ตัว");
    }
    detail.push(
      `- Headings: H1=${headings.h1Count ?? 0}, H2=${headings.h2Count ?? 0}, H3=${headings.h3Count ?? 0}`
    );

    detail.push("");
    detail.push("Social / Schema / Links");
    detail.push(
      `- OpenGraph: ${hints.hasOpenGraph ? "✅ มี" : "⛔ ไม่มี"}`
    );
    detail.push(
      `- Twitter Card: ${hints.hasTwitterCard ? "✅ มี" : "⛔ ไม่มี"}`
    );
    detail.push(
      `- Schema.org: ${schema.types?.length ? "✅ " + schema.types.join(", ") : "⛔ ไม่พบ"
      }`
    );
    detail.push(
      `- links: total=${links.total ?? 0}, internal=${links.internal ?? 0}, external=${links.external ?? 0}`
    );

    lines.push("```");
    lines.push(detail.join("\n"));
    lines.push("```");
  } else if (rSeoBlock && rSeoBlock.error) {
    lines.push("");
    lines.push(
      `**• SEO** – ⚠️ ${rSeoBlock.errorMessage || "วิเคราะห์ SEO ไม่สำเร็จ"}`
    );
  } else {
    lines.push("");
    lines.push("**• SEO** – (ไม่มีข้อมูลการทดสอบ)");
  }

  return lines.join("\n");
}

// ======================= Discord Bot main =======================
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
      if (!content.toLowerCase().startsWith("!check ")) return;

      const rawUrl = content.slice("!check ".length).trim();
      const normalized = normalizeUrl(rawUrl);

      if (!normalized) {
        await message.reply(
          "รูปแบบ URL ดูจะไม่ถูกต้องนะครับ 🙏\n" +
          "ตัวอย่างที่ถูกต้อง: `!check https://example.com` หรือ `!check example.com`"
        );
        return;
      }

      const waitingMsg = await message.reply(
        `กำลังตรวจลิงก์ให้คุณนะครับ...\n<${normalized}>`
      );

      const apiBase = DROPURL_API_BASE || "https://dropurl.vercel.app";
      const resp = await fetch(`${apiBase}/api/check-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: [normalized],
          checks: { all: true },
        }),
      });

      if (!resp.ok) {
        await waitingMsg.edit(
          `⚠️ เรียก API ไม่สำเร็จ: HTTP ${resp.status} ${resp.statusText}`
        );
        return;
      }

      const data = await resp.json();

      if (data.error) {
        await waitingMsg.edit(
          `⚠️ ตรวจลิงก์ไม่สำเร็จ: ${data.errorMessage || "unknown error"}`
        );
        return;
      }

      const report = buildDiscordReport(normalized, data.result || {});
      await waitingMsg.edit(report);
    } catch (err) {
      console.error("bot messageCreate error:", err);
      try {
        await message.reply("⚠️ มีข้อผิดพลาดภายในบอท ลองใหม่อีกครั้งนะครับ");
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
