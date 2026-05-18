/**
 * main_browser.js
 *
 * Launches Chrome → opens Zalo Web → polls for new messages →
 * replies with predefined FAQ answers using semantic AI matching.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node main_browser.js
 *
 * First run: Zalo QR code will appear — scan it once. Login is saved to ./userdataa.
 */

import { launch } from "puppeteer-core";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ── Configuration ─────────────────────────────────────────────────────────────

const CHROME_PATH =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const USER_DATA_DIR = resolve("./userdataa");
const ZALO_URL = "https://chat.zalo.me";
const POLL_MS = 3000;                   // how often to check for new messages
const AI_CONFIDENCE_THRESHOLD = 0.85;   // same rule as index.js

// Names exactly as they appear in Zalo (left sidebar).
// Leave as an empty Set to allow ALL senders.
const ALLOWED_SENDERS = new Set([
  // "Nguyen Van A",
  // "Team Dev",
]);

const FAQS = [
  { question: "hello",              aliases: ["hi", "hey", "heyy", "helo", "heloo"],                               answer: "Hi! How can I help you today?" },
  { question: "how are you",        aliases: ["how r u", "how are u", "hows it going", "how do you do"],           answer: "I'm doing great. Thanks for asking!" },
  { question: "what is your name",  aliases: ["whats your name", "what's your name", "your name", "who are you"], answer: "My name is Kataa Bot." },
  { question: "who created you",    aliases: ["who made you", "who built you", "who is your creator"],             answer: "I was created by my developer using OpenClaw." },
  { question: "what can you do",    aliases: ["what do you do", "your features", "your abilities", "help me"],    answer: "I can automatically reply to approved questions." },
  { question: "where are you from", aliases: ["where do you live", "where are you located"],                      answer: "I'm running from a cloud server." },
  { question: "good morning",       aliases: ["gm", "morning", "gud morning", "goood morning"],                   answer: "Good morning! Hope you have a great day." },
  { question: "good night",         aliases: ["gn", "nite", "goodnite", "good nite", "night"],                    answer: "Good night! Sleep well." },
  { question: "bye",                aliases: ["goodbye", "cya", "see you", "see ya", "ttyl", "bbye"],             answer: "Goodbye! See you again soon." },
  { question: "hola",               aliases: ["ola", "holla"],                                                     answer: "kataa" },
];

// ── Zalo Web DOM selectors ────────────────────────────────────────────────────
//
// If Zalo updates their markup, open DevTools on chat.zalo.me and adjust these.
//
const SEL = {
  // Left sidebar: one item per conversation
  convItem:    '[class*="conv-item"], [class*="ThreadItem"], [class*="chat-item"]',
  // Name label inside a conversation item
  convName:    '[class*="displayName"], [class*="conv-name"], [class*="title-name"]',
  // Unread badge / dot
  unread:      '[class*="unread"], [class*="badge"]',
  // Messages in the open conversation (chronological)
  msgItem:     '[class*="message-item"], [class*="MessageItem"], [class*="msg-item"]',
  // Text content of a message bubble
  msgText:     '[class*="message-text"], [class*="msg-text"], [class*="content-message"]',
  // Class present on messages sent by ME (self)
  msgSelf:     '[class*="-self"], [class*="owner"], [class*="fromMe"], [class*="from-me"]',
  // Typing area (contenteditable)
  chatInput:   'div[contenteditable="true"]',
};

// ── AI classifier (Anthropic) ─────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function classifyFaq(incoming) {
  const faqLines = FAQS.map((f, i) => {
    const aliases = f.aliases?.length ? ` (also: ${f.aliases.join(", ")})` : "";
    return `${i + 1}. ${f.question}${aliases}`;
  }).join("\n");

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 120,
    system: [
      "You are a semantic FAQ classifier.",
      "Compare the incoming message to the approved FAQ questions and their aliases by MEANING, not exact text.",
      "Accept typos, paraphrases, synonyms, and informal phrasing when the intent is the same.",
      "Assign confidence 0.0–1.0 based on semantic similarity.",
      "Only select a FAQ when the match is clear. Do not answer the user. Do not invent FAQs.",
      "Return JSON only.",
    ].join(" "),
    messages: [{
      role: "user",
      content:
        `Incoming message:\n${incoming}\n\n` +
        `Approved FAQs (with aliases):\n${faqLines}\n\n` +
        `Return JSON: {"faqNumber": number|null, "confidence": number, "reason": string}`,
    }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  const jsonStr = text.trim().startsWith("{")
    ? text.trim()
    : (text.match(/\{[\s\S]*\}/) ?? [""])[0];

  try {
    const parsed = JSON.parse(jsonStr);
    const n = parseInt(parsed.faqNumber);
    const confidence = parseFloat(parsed.confidence) || 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";

    if (!Number.isInteger(n) || n < 1 || n > FAQS.length) {
      return { faq: null, confidence, reason: reason || "no faq selected" };
    }
    return { faq: FAQS[n - 1], confidence, reason };
  } catch {
    return { faq: null, confidence: 0, reason: "json parse error" };
  }
}

// ── Zalo page helpers ─────────────────────────────────────────────────────────

/**
 * Returns conversation items that have an unread badge AND are from allowed senders.
 */
async function getUnreadAllowed(page) {
  return page.evaluate(
    (sel, allowedNames, allowAll) => {
      const items = [...document.querySelectorAll(sel.convItem)];
      return items
        .filter((el) => el.querySelector(sel.unread))
        .map((el) => ({
          name: el.querySelector(sel.convName)?.textContent?.trim() ?? "",
        }))
        .filter(({ name }) => name && (allowAll || allowedNames.includes(name)));
    },
    SEL,
    [...ALLOWED_SENDERS],
    ALLOWED_SENDERS.size === 0,
  );
}

/**
 * Clicks a conversation item by its display name.
 */
async function openConversation(page, name) {
  await page.evaluate(
    (sel, targetName) => {
      const item = [...document.querySelectorAll(sel.convItem)].find(
        (el) => el.querySelector(sel.convName)?.textContent?.trim() === targetName,
      );
      item?.click();
    },
    SEL,
    name,
  );
  await sleep(700);
}

/**
 * Returns the last message that was NOT sent by self.
 * Uses a stable key: data-id attribute, falling back to trimmed text.
 */
async function getLastIncoming(page) {
  return page.evaluate((sel) => {
    const msgs = [...document.querySelectorAll(sel.msgItem)];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const el = msgs[i];

      // Skip own messages
      if (el.matches(sel.msgSelf) || el.querySelector(sel.msgSelf)) continue;

      const text = el.querySelector(sel.msgText)?.textContent?.trim();
      if (!text) continue;

      const msgId =
        el.getAttribute("data-id") ??
        el.getAttribute("data-msgid") ??
        el.getAttribute("data-message-id") ??
        text.slice(0, 60);

      return { text, msgId };
    }
    return null;
  }, SEL);
}

/**
 * Types `reply` into the chat input and presses Enter.
 */
async function sendReply(page, reply) {
  const inputHandle = await page.$(SEL.chatInput);
  if (!inputHandle) throw new Error("Chat input not found — check SEL.chatInput");

  await inputHandle.click();

  // Clear existing content then type the reply
  await page.evaluate((el) => {
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
  }, inputHandle);

  await page.keyboard.type(reply, { delay: 20 });
  await page.keyboard.press("Enter");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function replyDelay() {
  return 1000 + Math.floor(Math.random() * 2000);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[fatal] ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log("[browser] Launching Chrome...");
  const browser = await launch({
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA_DIR,
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log("[browser] Opening Zalo Web...");
  await page.goto(ZALO_URL, { waitUntil: "networkidle2", timeout: 60_000 });

  console.log("[browser] Waiting for login... (scan QR if first run)");
  await page.waitForSelector(SEL.convItem, { timeout: 120_000 });
  console.log("[browser] Logged in. Listening for messages...");

  // Tracks processed message IDs to prevent duplicate replies
  const processed = new Set();

  // Main polling loop
  while (true) {
    try {
      const conversations = await getUnreadAllowed(page);

      for (const { name } of conversations) {
        await openConversation(page, name);

        const msg = await getLastIncoming(page);
        if (!msg) continue;

        const dedupKey = `${name}::${msg.msgId}`;
        if (processed.has(dedupKey)) continue;
        processed.add(dedupKey);

        console.log(`[faq] [${name}] "${msg.text}"`);

        let classification;
        try {
          classification = await classifyFaq(msg.text);
        } catch (err) {
          console.error("[faq] AI error:", err.message);
          continue;
        }

        const { faq, confidence, reason } = classification;
        console.log(
          `[faq] confidence=${confidence.toFixed(2)} ` +
          `faq="${faq?.question ?? "none"}" reason="${reason}"`,
        );

        if (!faq || confidence < AI_CONFIDENCE_THRESHOLD) {
          console.log("[faq] Below threshold — no reply");
          continue;
        }

        await sleep(replyDelay());

        try {
          await sendReply(page, faq.answer);
          console.log(`[faq] Replied: "${faq.answer}"`);
        } catch (err) {
          console.error("[faq] Send failed:", err.message);
        }
      }
    } catch (err) {
      console.error("[poll] Error:", err.message);
    }

    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
