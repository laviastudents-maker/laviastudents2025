import { getStore } from "@netlify/blobs";
import OpenAI from "openai";
import crypto from "node:crypto";

const SITE_URL = process.env.URL || "https://laviastudents2025.netlify.app";
const MAX_SOURCE_CHARS = 10000;
const KEEP_UPDATES = 24;

const URL_OVERRIDES = {
  "visa-for-italy": "https://vistoperitalia.esteri.it/",
  "units": "https://portale.units.it/en/international/destination-units/degree-seekers",
  "iuav": "https://www.iuav.it/it/international-students/non-eu-applicants-residing-abroad",
  "edisu": "https://www.edisu.piemonte.it/borse-e-contributi/benefici-economici/borsa-di-studio"
};

const SKIP_IDS = new Set([
  "mur-news",
  "portale-immigrazione"
]);

const clean = html => html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/\s+/g, " ")
  .trim();

const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);

async function loadSources() {
  const r = await fetch(new URL("/data/sources.json", SITE_URL), { cache: "no-store" });
  if (!r.ok) throw new Error(`sources.json ${r.status}`);

  const raw = await r.json();

  return raw
    .filter(s => s?.id && s?.url && !SKIP_IDS.has(s.id))
    .map(s => ({
      ...s,
      url: URL_OVERRIDES[s.id] || s.url
    }));
}

async function fetchSource(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const r = await fetch(source.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "LaViaItalyStudyMonitor/3.0 (+https://laviastudents2025.netlify.app)",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const text = clean(await r.text()).slice(0, MAX_SOURCE_CHARS);

    if (text.length < 180) {
      throw new Error("content too short");
    }

    return {
      ...source,
      text,
      hash: sha(text)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function seedUpdates() {
  try {
    const r = await fetch(new URL("/data/updates.json", SITE_URL), { cache: "no-store" });
    return r.ok ? await r.json() : [];
  } catch {
    return [];
  }
}

export default async () => {
  const sources = await loadSources();

  const rank = {
    critical: 0,
    high: 1,
    normal: 2
  };

  sources.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9));

  const state = getStore("la-via-source-state-v3");
  const updatesStore = getStore("la-via-updates");

  const results = await Promise.allSettled(
    sources.map(fetchSource)
  );

  const fetched = results
    .map(result => result.status === "fulfilled" ? result.value : null)
    .filter(Boolean);

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        `Source failed: ${sources[index].name}`,
        result.reason?.message || result.reason
      );
    }
  });

  if (!fetched.length) {
    console.error("No official sources could be read.");
    return;
  }

  const changed = [];
  let previousCount = 0;

  for (const source of fetched) {
    const previous = await state.get(
      source.id,
      {
        type: "json",
        consistency: "strong"
      }
    );

    if (previous?.hash) {
      previousCount += 1;

      if (previous.hash !== source.hash) {
        changed.push({
          ...source,
          previousText: previous.text || ""
        });
      }
    }

    await state.setJSON(
      source.id,
      {
        hash: source.hash,
        text: source.text,
        checkedAt: new Date().toISOString(),
        name: source.name,
        url: source.url,
        type: source.type,
        priority: source.priority
      }
    );
  }

  // First V3 run: create a clean baseline only.
  if (previousCount === 0) {
    console.log(
      `Baseline created for ${fetched.length}/${sources.length} active official sources.`
    );
    return;
  }

  if (!changed.length) {
    console.log(
      `No changes detected. Checked ${fetched.length}/${sources.length} active official sources.`
    );
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY missing");
    return;
  }

  const payload = changed.slice(0, 12).map(source => ({
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.type,
    priority: source.priority,
    defaultCategory: source.category,
    sourceUrl: source.url,
    previousText: source.previousText.slice(0, 7000),
    currentText: source.text.slice(0, 7000)
  }));

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  let response;

  try {
    response = await client.responses.create({
      model: "gpt-5-mini",
      reasoning: {
        effort: "low"
      },
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `You verify official study-in-Italy updates for La Via.
Compare PREVIOUS and CURRENT text from the same official page.
Publish only a material NEW change affecting prospective/incoming international students: admissions, Universitaly, visa, embassy procedure, required documents, deadlines, language/B2, tuition, scholarship/DSU, residence permit/Questura, immigration office/Sportello Unico, codice fiscale, SSN, or arrival procedure.
Do not republish facts present in both versions.
Ignore layout changes, cookie text, navigation changes and general news.
Never infer beyond supplied official text.
For university sources, ignore research/general news and publish only student-procedure changes.
Write concise Arabic.
confidence=high only when the NEW change is explicit in CURRENT and absent from PREVIOUS.
If uncertain, return material=false.`
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(payload)
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "la_via_updates_v3",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              updates: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    sourceId: {
                      type: "string"
                    },
                    material: {
                      type: "boolean"
                    },
                    category: {
                      type: "string",
                      enum: [
                        "Visa",
                        "Universitaly",
                        "University",
                        "Scholarship",
                        "Language",
                        "Residence",
                        "Immigration",
                        "General"
                      ]
                    },
                    urgent: {
                      type: "boolean"
                    },
                    title: {
                      type: "string"
                    },
                    summary: {
                      type: "string"
                    },
                    audience: {
                      type: "string"
                    },
                    confidence: {
                      type: "string",
                      enum: [
                        "high",
                        "medium",
                        "low"
                      ]
                    },
                    effectiveDate: {
                      type: "string"
                    }
                  },
                  required: [
                    "sourceId",
                    "material",
                    "category",
                    "urgent",
                    "title",
                    "summary",
                    "audience",
                    "confidence",
                    "effectiveDate"
                  ]
                }
              }
            },
            required: [
              "updates"
            ]
          }
        }
      }
    });
  } catch (error) {
    console.error(
      "OpenAI analysis failed:",
      error?.code || error?.status || error?.message || error
    );
    return;
  }

  let parsed;

  try {
    parsed = JSON.parse(response.output_text);
  } catch (error) {
    console.error("parse failed", error);
    return;
  }

  const sourceMap = new Map(
    sources.map(source => [
      source.id,
      source
    ])
  );

  const approved = (parsed.updates || [])
    .filter(update =>
      update.material === true &&
      update.confidence === "high" &&
      sourceMap.has(update.sourceId)
    )
    .map(update => {
      const source = sourceMap.get(update.sourceId);

      const date = /^\d{4}-\d{2}-\d{2}$/.test(update.effectiveDate)
        ? update.effectiveDate
        : today();

      return {
        id: sha(
          `${update.sourceId}|${update.title}|${date}`
        ).slice(0, 16),
        category: update.category || source.category,
        date,
        urgent: Boolean(update.urgent),
        title: update.title.trim(),
        summary: update.summary.trim(),
        audience: update.audience.trim(),
        sourceUrl: source.url,
        sourceName: source.name,
        sourceType: source.type,
        priority: source.priority,
        published: true,
        detectedAt: new Date().toISOString()
      };
    });

  if (!approved.length) {
    console.log(
      `${changed.length} changed source(s), no high-confidence material update.`
    );
    return;
  }

  let existing = await updatesStore.get(
    "published",
    {
      type: "json",
      consistency: "strong"
    }
  );

  if (!Array.isArray(existing) || !existing.length) {
    existing = await seedUpdates();
  }

  const seen = new Set();
  const unique = [];

  for (const item of [...approved, ...existing]) {
    const key =
      item.id ||
      sha(
        `${item.sourceUrl}|${item.title}|${item.date}`
      ).slice(0, 16);

    if (seen.has(key)) continue;

    seen.add(key);

    unique.push({
      ...item,
      id: key
    });
  }

  unique.sort(
    (a, b) =>
      String(b.date).localeCompare(String(a.date))
  );

  await updatesStore.setJSON(
    "published",
    unique.slice(0, KEEP_UPDATES)
  );

  console.log(
    `Published ${approved.length} verified update(s). Checked ${fetched.length}/${sources.length} active official sources.`
  );
};
