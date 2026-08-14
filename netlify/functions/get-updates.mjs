import { getStore } from "@netlify/blobs";

const SITE_URL = process.env.URL || "https://laviastudents2025.netlify.app";

async function fallbackUpdates() {
  try {
    const response = await fetch(
      new URL("/data/updates.json", SITE_URL),
      { cache: "no-store" }
    );

    if (!response.ok) return [];

    const data = await response.json();

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export default async () => {
  try {
    const updatesStore = getStore("la-via-updates");

    let updates = await updatesStore.get(
      "published",
      {
        type: "json",
        consistency: "strong"
      }
    );

    if (!Array.isArray(updates) || !updates.length) {
      updates = await fallbackUpdates();
    }

    updates = updates
      .filter(item => item && item.published !== false)
      .sort((a, b) =>
        String(b.date || "").localeCompare(
          String(a.date || "")
        )
      );

    return new Response(
      JSON.stringify(updates),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store, max-age=0",
          "access-control-allow-origin": "*"
        }
      }
    );

  } catch (error) {
    console.error(
      "get-updates failed",
      error?.message || error
    );

    const updates = await fallbackUpdates();

    return new Response(
      JSON.stringify(updates),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store, max-age=0",
          "access-control-allow-origin": "*"
        }
      }
    );
  }
};
