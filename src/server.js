// src/server.js
import express from "express";
import cors from "cors";
import { check404 } from "../test/404.js";
import { checkDuplicate } from "../test/duplicate.js";
import { checkSeo } from "../test/read-elements.js"; // ← ไฟล์ SEO ที่คุณเพิ่งแก้

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
