// src/server.js
import express from "express";
import cors from "cors";
import { check404 } from "../test/404.js";
import { checkDuplicate } from "../test/duplicate.js";
import { checkSeo } from "../test/read-elements.js"; // ← ไฟล์ SEO ที่คุณเพิ่งแก้

import { Client, GatewayIntentBits, Partials } from "discord.js";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DROPURL_API_BASE = process.env.DROPURL_API_BASE;


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

  // รวมค่า all → check404/duplicate/seo
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

  // 2) DUPLICATE
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

// ===== Discord Bot =====
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
      // ไม่ตอบตัวเอง หรือบอทอื่น
      if (message.author.bot) return;

      // ฟังคำสั่ง !check <url>
      const content = message.content.trim();
      if (!content.toLowerCase().startsWith("!check ")) return;

      const url = content.slice("!check ".length).trim();
      if (!url) {
        await message.reply("โปรดใส่ URL ด้วยนะ เช่น `!check https://example.com`");
        return;
      }

      // ส่งข้อความบอกว่ากำลังตรวจ
      const waitingMsg = await message.reply(
        `กำลังตรวจลิงก์นี้ให้คุณนะครับ...\n<${url}>`
      );

      // เรียก DropURL API
      const apiBase = DROPURL_API_BASE || "https://dropurl.vercel.app"; // fallback ถ้าไม่ได้ตั้ง
      const resp = await fetch(`${apiBase}/api/check-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: [url],
          checks: { all: true },
        }),
      });

      const data = await resp.json();

      if (data.error) {
        await waitingMsg.edit(
          `⚠️ ตรวจลิงก์ไม่สำเร็จ: ${data.errorMessage || "unknown error"}`
        );
        return;
      }

      const result = data.result || {};
      const r404 = result.check404?.results?.[0];
      const rDup = result.duplicate;
      const rSeo = result.seo?.results?.[0];

      const lines = [];
      lines.push(`🔍 **ผลตรวจสำหรับ:** <${url}>`);

      // 404
      if (r404) {
        const status = r404.pageStatus ?? "no response";
        const isError = status === 404 || status === 500 || status === 0;
        lines.push(
          `• 404: \`${status}\` ${isError ? "⚠️ มีปัญหาหรือเข้าไม่ได้" : "✅ ปกติ"}`
        );
      } else {
        lines.push("• 404: (ไม่มีข้อมูล)");
      }

      // Duplicate
      if (rDup) {
        if (rDup.error) {
          lines.push(`• Duplicate: ⚠️ ${rDup.errorMessage || "ตรวจไม่ได้"}`);
        } else if (Array.isArray(rDup.results) && rDup.results.length > 0) {
          const hasDup = rDup.results.some(
            (it) => Array.isArray(it.duplicates) && it.duplicates.length > 1
          );
          lines.push(
            `• Duplicate: ${hasDup
              ? "⚠️ พบลิงก์หรือแบนเนอร์ที่เนื้อหาเหมือนกันหลายที่"
              : "✅ ยังไม่พบความซ้ำที่น่ากังวล"
            }`
          );
        } else {
          lines.push("• Duplicate: ✅ ไม่มีข้อมูล หรือไม่มีปัญหา");
        }
      } else {
        lines.push("• Duplicate: (ไม่ได้เปิดทดสอบ / ไม่มีข้อมูล)");
      }

      // SEO
      if (rSeo && rSeo.meta?.seoHints) {
        const h = rSeo.meta.seoHints;
        lines.push(
          `• SEO: title ${h.titleLengthOk ? "✅" : "⚠️"} | desc ${h.descriptionLengthOk ? "✅" : "⚠️"
          } | canonical ${h.hasCanonical ? "✅" : "⚠️ ไม่มี"
          } | html lang ${h.hasHtmlLang ? "✅" : "⚠️ ไม่มี"}`
        );
      } else if (rSeo && rSeo.error) {
        lines.push(
          `• SEO: ⚠️ ${rSeo.errorMessage || "วิเคราะห์ SEO ไม่สำเร็จ"}`
        );
      } else {
        lines.push("• SEO: (ไม่มีข้อมูล)");
      }

      await waitingMsg.edit(lines.join("\n"));
    } catch (err) {
      console.error("bot messageCreate error:", err);
      try {
        await message.reply("⚠️ มีข้อผิดพลาดภายในบอท ลองใหม่อีกครั้งนะครับ");
      } catch { }
    }
  });

  client
    .login(DISCORD_BOT_TOKEN)
    .catch((err) => console.error("Discord login failed:", err));
}

// เรียกใช้บอท
setupDiscordBot();
