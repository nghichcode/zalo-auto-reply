import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import Fuse from "fuse.js";

const ZALOUSER_TEST_API = pathToFileURL(
  join(homedir(), ".openclaw", "npm", "node_modules", "@openclaw", "zalouser", "dist", "test-api.js")
).href;

let _sendMessageZalouser;
async function getSendMessageZalouser() {
  if (!_sendMessageZalouser) {
    const mod = await import(ZALOUSER_TEST_API);
    _sendMessageZalouser = mod.sendMessageZalouser;
  }
  return _sendMessageZalouser;
}

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const FAQ_PATH = join(PLUGIN_ROOT, "faq.json");
const CHANNEL_ID = "zalouser";
const LOG_PATH = join(process.env.HOME ?? ".", ".openclaw", "logs", "faq-autoreply.jsonl");
const MAX_SCORE = 0.35;
const AMBIGUITY_GAP = 0.08;
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;

const processedMessages = new Map();

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function removeDiacritics(str) {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

function normalizeForFuzzy(value) {
  return removeDiacritics(normalizeText(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomReplyDelayMs() {
  return 1000 + Math.floor(Math.random() * 2001);
}

function timestampFromEvent(event) {
  const raw = typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
    ? event.timestamp
    : Date.now();
  return new Date(raw < 1e12 ? raw * 1000 : raw).toISOString();
}

function senderFromEvent(event, ctx) {
  return event.senderName
    ?? event.senderUsername
    ?? event.senderId
    ?? ctx.senderId
    ?? event.metadata?.from
    ?? "unknown";
}

function messageIdFromEvent(event, ctx, incoming) {
  return event.messageId
    ?? ctx.messageId
    ?? event.metadata?.messageId
    ?? [event.channel, event.conversationId, event.senderId ?? ctx.senderId, event.timestamp, incoming].join(":");
}

function threadIdFromEvent(event, ctx) {
  const raw = event.conversationId
    ?? ctx.conversationId
    ?? event.metadata?.originatingTo
    ?? event.metadata?.to
    ?? event.metadata?.from
    ?? event.senderId
    ?? ctx.senderId;
  if (typeof raw !== "string") return "";
  return raw.replace(/^(zalouser:group:|zalouser:|group:)/i, "").trim();
}

function isOwnMessage(event, ctx) {
  if (event.isSelf === true || event.metadata?.isSelf === true) return true;
  const from = event.metadata?.from;
  const to = event.metadata?.to ?? event.metadata?.originatingTo;
  if (from && to && from === to) return true;
  return Boolean(event.senderId && ctx.accountId && event.senderId === ctx.accountId);
}

function rememberMessage(messageId) {
  const now = Date.now();
  for (const [key, seenAt] of processedMessages) {
    if (now - seenAt > DEDUPE_TTL_MS) processedMessages.delete(key);
  }
  if (processedMessages.has(messageId)) return false;
  processedMessages.set(messageId, now);
  return true;
}

function loadFaqs() {
  try {
    const raw = JSON.parse(readFileSync(FAQ_PATH, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => {
        const question = typeof entry?.question === "string" ? entry.question : "";
        const answer = typeof entry?.answer === "string" ? entry.answer : "";
        const aliases = Array.isArray(entry?.aliases)
          ? entry.aliases.filter((a) => typeof a === "string")
          : [];
        if (!question.trim() || !answer) return null;
        const nq = normalizeText(question);
        const na = aliases.map(normalizeText).filter(Boolean);
        return {
          question,
          aliases,
          answer,
          normalizedQuestion: nq,
          normalizedAliases: na,
          fuzzyQuestion: removeDiacritics(nq),
          fuzzyAliases: na.map(removeDiacritics).filter(Boolean)
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findFaqMatch(messageText) {
  const faqs = loadFaqs();
  const normalized = normalizeText(messageText);
  const normalizedStripped = removeDiacritics(normalized);

  if (!normalized) return { faq: null, score: null, matchType: null, skippedReason: "empty_message" };
  if (faqs.length === 0) return { faq: null, score: null, matchType: null, skippedReason: "no_faqs" };

  // Exact match — thử cả có dấu lẫn không dấu
  for (const faq of faqs) {
    if (faq.normalizedQuestion === normalized || faq.fuzzyQuestion === normalizedStripped)
      return { faq, score: 0, matchType: "exact_question", skippedReason: null };
    if (faq.normalizedAliases.includes(normalized) || faq.fuzzyAliases.includes(normalizedStripped))
      return { faq, score: 0, matchType: "exact_alias", skippedReason: null };
  }

  // Fuzzy match — dùng text đã bỏ dấu để khớp cả khi user gõ không dấu
  const rows = faqs.flatMap((faq) => [
    { text: faq.fuzzyQuestion, kind: "question", faq },
    ...faq.fuzzyAliases.map((alias) => ({ text: alias, kind: "alias", faq }))
  ]);

  const fuse = new Fuse(rows, {
    keys: ["text"],
    includeScore: true,
    ignoreLocation: true,
    threshold: MAX_SCORE,
    minMatchCharLength: 1
  });

  const results = fuse.search(normalizedStripped, { limit: 4 });
  const best = results[0];

  if (!best) return { faq: null, score: null, matchType: "fuzzy", skippedReason: "no_fuzzy_match" };

  const bestScore = typeof best.score === "number" ? best.score : 1;
  if (bestScore > MAX_SCORE) return { faq: null, score: bestScore, matchType: "fuzzy", skippedReason: "weak_match" };

  const competing = results.find((r) => r.item.faq !== best.item.faq);
  if (competing && typeof competing.score === "number" && competing.score - bestScore < AMBIGUITY_GAP) {
    return { faq: null, score: bestScore, matchType: "fuzzy", skippedReason: "ambiguous_match" };
  }

  return {
    faq: best.item.faq,
    score: bestScore,
    matchType: best.item.kind === "question" ? "fuzzy_question" : "fuzzy_alias",
    skippedReason: null
  };
}

function writeDecisionLog({ event, ctx, incoming, matchedFaq, reply, fuseScore, matchType, skippedReason }) {
  const record = {
    timestamp: timestampFromEvent(event),
    sender: senderFromEvent(event, ctx),
    incomingMessage: incoming,
    matchedFaq: matchedFaq?.question ?? null,
    fuseScore: fuseScore ?? null,
    matchType: matchType ?? null,
    reply: reply ?? null,
    skippedReason: skippedReason ?? null
  };
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
  console.log("[faq-autoreply] " + JSON.stringify(record));
}

async function sendFaqReply(event, ctx, reply) {
  const threadId = threadIdFromEvent(event, ctx);
  if (!threadId) throw new Error("Missing Zalo thread id");
  const sendMessageZalouser = await getSendMessageZalouser();
  const result = await sendMessageZalouser(threadId, reply, {
    profile: ctx.accountId ?? event.accountId ?? "default",
    isGroup: event.isGroup === true
  });
  if (!result?.ok) throw new Error(result?.error || "Zalo send failed");
  return result;
}

async function handleFaq(event, ctx = {}) {
  const channelId = ctx.channelId ?? event.channel;
  if (channelId !== CHANNEL_ID) return;

  const incoming = event.bodyForAgent ?? event.body ?? event.content ?? "";
  const normalized = normalizeText(incoming);
  const messageId = messageIdFromEvent(event, ctx, normalized);

  if (isOwnMessage(event, ctx)) {
    writeDecisionLog({ event, ctx, incoming, matchedFaq: null, reply: null, skippedReason: "own_message" });
    return { handled: true };
  }

  if (!rememberMessage(messageId)) return { handled: true };

  const { faq, score, matchType, skippedReason } = findFaqMatch(incoming);
  writeDecisionLog({
    event, ctx, incoming,
    matchedFaq: faq ?? null,
    reply: faq?.answer ?? null,
    fuseScore: score,
    matchType,
    skippedReason
  });

  if (!faq) return { handled: true };

  await sleep(randomReplyDelayMs());
  try {
    await sendFaqReply(event, ctx, faq.answer);
  } catch (error) {
    console.error("[faq-autoreply] send failed: " + (error instanceof Error ? error.message : String(error)));
  }
  return { handled: true };
}

export default definePluginEntry({
  id: "hola-autoreply",
  name: "FAQ Autoreply",
  description: "Strict Zalo FAQ auto-replies with predefined answers only.",
  register(api) {
    api.on("inbound_claim", handleFaq, { priority: Number.MAX_SAFE_INTEGER });
    api.on("before_dispatch", handleFaq, { priority: Number.MAX_SAFE_INTEGER });
  }
});
