// Telegram bot: answers questions about India's official bilateral trade data
// (from the Dept. of Commerce TIA Portal) in Hindi written in English script.
//
// Design: Gemini is used ONLY to (1) understand the question and match it to a
// country name, and (2) phrase the final reply. It is never allowed to invent
// numbers - every figure it phrases is looked up directly from data/countries.json
// (kept fresh by the scraper's weekly GitHub Action) and handed to it verbatim.

const GEMINI_MODEL = "gemini-2.5-flash"; // swap here if Google retires this model - see README

const WELCOME_TEXT =
  "Namaste! Main aapka trade data assistant hoon - India ke official Ministry of " +
  "Commerce (TIA Portal) ke data se jawab deta hoon.\n\n" +
  "Aap mujhse kuch bhi pooch sakte hain jaise:\n" +
  "- \"America ko India kitna export karta hai?\"\n" +
  "- \"China se sabse zyada kya import hota hai?\"\n" +
  "- \"UAE ke saath trade balance kya hai?\"\n\n" +
  "Bas desh ka naam le kar poochiye, main Hindi mein (English letters mein) jawab dunga.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response("Bot is alive.", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleWebhook(request, env, ctx) {
  // Verify the request actually came from Telegram.
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Always ack Telegram immediately; do the real work in the background so
  // Telegram doesn't retry the webhook while we're waiting on Gemini.
  ctx.waitUntil(processUpdate(update, env).catch((err) => console.error("processUpdate error:", err)));
  return new Response("OK", { status: 200 });
}

async function processUpdate(update, env) {
  const message = update.message;
  if (!message || typeof message.text !== "string") return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start" || text === "/help") {
    await sendTelegramMessage(env, chatId, WELCOME_TEXT);
    return;
  }

  const data = await fetchCountryData(env);
  if (!data || data.countries.length === 0) {
    await sendTelegramMessage(
      env,
      chatId,
      "Maaf kijiye, abhi data load nahi ho paya. Thodi der baad phir try kijiye."
    );
    return;
  }

  const countryNames = data.countries.map((c) => c.country);

  let intent;
  try {
    intent = await extractIntent(env, text, countryNames);
  } catch (err) {
    console.error("extractIntent failed:", err);
    await sendTelegramMessage(
      env,
      chatId,
      "Maaf kijiye, aapka sawaal samajhne mein dikkat hui. Kripya desh ka naam le kar dobara poochiye."
    );
    return;
  }

  if (!intent.country) {
    await sendTelegramMessage(
      env,
      chatId,
      "Kis desh ke baare mein poochna chahte hain? Desh ka naam bata dijiye, jaise USA, China, ya UAE."
    );
    return;
  }

  const record = data.countries.find(
    (c) => c.country.toLowerCase() === intent.country.toLowerCase()
  );

  if (!record) {
    await sendTelegramMessage(
      env,
      chatId,
      `Maaf kijiye, "${intent.country}" ka data abhi mere paas nahi hai. Kripya kisi doosre desh ka naam try kijiye.`
    );
    return;
  }

  let answer;
  try {
    answer = await composeAnswer(env, text, record, data.lastUpdated);
  } catch (err) {
    console.error("composeAnswer failed:", err);
    answer = fallbackAnswer(record);
  }

  await sendTelegramMessage(env, chatId, answer);
}

async function fetchCountryData(env) {
  const resp = await fetch(env.DATA_URL, {
    cf: { cacheTtl: 300, cacheEverything: true }, // edge-cache for 5 min, this data only refreshes weekly
  });
  if (!resp.ok) return null;
  return resp.json();
}

async function extractIntent(env, userText, countryNames) {
  const system =
    "You match a Hindi (written in Latin/English script, i.e. Hinglish) or English question " +
    "about India's foreign trade to exactly one country name from a fixed list. " +
    "Respond with ONLY a compact JSON object, no markdown fences, no extra text, matching this shape: " +
    '{"country": "<exact name from the list, or null if none/unclear>"}. ' +
    "Match colloquial/phonetic spellings (e.g. 'amreeka', 'yookay', 'chiin') to the closest list entry. " +
    "If the question doesn't clearly name a country from the list, return null for country.\n\n" +
    "Valid country names:\n" + countryNames.join(", ");

  const raw = await callGemini(env, { system, userText, jsonMode: true });
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  return { country: parsed.country || null };
}

async function composeAnswer(env, userText, record, lastUpdated) {
  const system =
    "Tum ek friendly trade-data assistant ho, jo ek Indian father ke sawaalon ka jawab deta hai. " +
    "SIRF Hindi bolo, lekin English/Roman script mein likho (Devanagari script bilkul mat likho). " +
    "Jawab sirf neeche diye gaye JSON data ke numbers par based ho - koi naya number mat banao. " +
    "Simple, warm, seedhi bhasha use karo (jaise ek beta apne pita ko samjhata hai). " +
    "Jawab 3-5 lines se zyada lamba mat rakho, jab tak zaroorat na ho.";

  const userPrompt =
    `Sawaal: "${userText}"\n\n` +
    `India-${record.country} trade data (source: DGCIS, TIA Portal, as of ${lastUpdated}):\n` +
    JSON.stringify(record, null, 2);

  const raw = await callGemini(env, { system, userText: userPrompt, jsonMode: false });
  return raw.trim();
}

async function callGemini(env, { system, userText, jsonMode }) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
  };
  if (jsonMode) {
    body.generationConfig = { responseMimeType: "application/json" };
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    throw new Error(`Gemini API error ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
  return text;
}

function fallbackAnswer(record) {
  // Used only if the Gemini phrasing call itself fails - a plain, correct answer
  // beats no answer.
  return (
    `${record.country} ke saath India ka trade:\n` +
    `Export: $${record.totalExportUSDMillion} million\n` +
    `Import: $${record.totalImportUSDMillion} million\n` +
    `Trade balance: $${record.tradeBalanceUSDMillion} million`
  );
}

async function sendTelegramMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
