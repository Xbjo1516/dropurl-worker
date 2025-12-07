// src/server.js
import express from "express";
import cors from "cors";
import { check404 } from "../test/404.js";
// ถ้าฟังก์ชันพวกนี้ยังไม่พร้อม ให้คอมเมนต์ไว้ก่อน
// import { checkDuplicate } from "../test/duplicate.js";
// import { checkSeo } from "../test/read-elements.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// route test เฉย ๆ
app.get("/", (_req, res) => {
  res.send("DropURL worker is running");
});

// เส้นหลักที่ Next.js เรียก
app.post("/run-checks", async (req, res) => {
  const { urls, checks } = req.body || {};

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({
      error: true,
      errorMessage: "urls must be a non-empty array",
    });
  }

  // normalize checks
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

  // 1) 404 – ใช้ของจริง
  if (normChecks.check404) {
    result.check404 = await safeRun("404", () => check404(urls));
  }

  // 2) DUPLICATE – ตอนนี้ยังให้ตอบ stub ไว้ก่อน
  if (normChecks.duplicate) {
    result.duplicate = {
      error: true,
      errorMessage:
        "Duplicate scanning is not implemented on this worker version yet.",
      results: [],
    };
    // ถ้าอยากใช้ของจริงแล้วค่อยเปลี่ยนเป็น:
    // result.duplicate = await safeRun("duplicate", () => checkDuplicate(urls));
  }

  // 3) SEO – ตอนนี้ยังให้ตอบ stub ไว้ก่อน
  if (normChecks.seo) {
    result.seo = {
      error: true,
      errorMessage:
        "SEO analysis is not implemented on this worker version yet.",
      results: [],
    };
    // ถ้าอยากใช้ของจริงแล้วค่อยเปลี่ยนเป็น:
    // result.seo = await safeRun("seo", () => checkSeo(urls));
  }

  return res.json({ error: false, result });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("DropURL worker listening on port", PORT);
});
