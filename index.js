import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getRuntimeConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  completeWithPreparedSimpleCompletionModel,
  extractAssistantText,
  prepareSimpleCompletionModelForAgent
} from "openclaw/plugin-sdk/simple-completion-runtime";
import { sendMessageZalouser } from "/Users/cya/.openclaw/npm/node_modules/@openclaw/zalouser/dist/test-api.js";

const CHANNEL_ID = "zalouser";
const LOG_PATH = join(process.env.HOME ?? ".", ".openclaw", "logs", "faq-autoreply.jsonl");
const AGENT_ID = "main";
const AI_CONFIDENCE_THRESHOLD = 0.85;
const FAQS = [
  { question: "hello", aliases: ["hi", "hey", "heyy", "helo", "heloo"], answer: "Hi! How can I help you today?" },
  { question: "how are you", aliases: ["how r u", "how are u", "hows it going", "how's it going", "how do you do"], answer: "I'm doing great. Thanks for asking!" },
  { question: "what is your name", aliases: ["whats your name", "what's your name", "your name", "who are you"], answer: "My name is Kataa Bot." },
  { question: "who created you", aliases: ["who made you", "who built you", "who is your creator"], answer: "I was created by my developer using OpenClaw." },
  { question: "what can you do", aliases: ["what do you do", "your features", "your abilities", "help me"], answer: "I can automatically reply to approved questions." },
  { question: "where are you from", aliases: ["where do you live", "where are you located"], answer: "I'm running from a cloud server." },
  { question: "good morning", aliases: ["gm", "morning", "gud morning", "goood morning"], answer: "Good morning! Hope you have a great day." },
  { question: "good night", aliases: ["gn", "nite", "goodnite", "good nite", "night"], answer: "Good night! Sleep well." },
  { question: "bye", aliases: ["goodbye", "cya", "see you", "see ya", "ttyl", "bbye"], answer: "Goodbye! See you again soon." },
  { question: "hola", aliases: ["ola", "holla"], answer: "kataa" }
];

const processedMessages = new Map();
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
let preparedClassifierPromise;

function normalizeText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
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
  return raw.replace(/^(zalouser:group:|zalouser:)/i, "").trim();
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

function writeDecisionLog({ event, ctx, incoming, matchedFaq, reply, confidence, reason }) {
  const record = {
    timestamp: timestampFromEvent(event),
    sender: senderFromEvent(event, ctx),
    incomingMessage: incoming,
    matchedFaq: matchedFaq?.question ?? null,
    confidence: typeof confidence === "number" ? confidence : null,
    reply: reply ?? null,
    reason: reason ?? null
  };
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
  console.log("[faq-autoreply] " + JSON.stringify(record));
}

function buildFaqClassifierPrompt(message) {
  const faqLines = FAQS.map((faq, index) => {
    const aliases = faq.aliases?.length ? ` (also: ${faq.aliases.join(", ")})` : "";
    return `${index + 1}. ${faq.question}${aliases}`;
  }).join("\n");
  return `Incoming message:
${message}

Approved FAQ questions (with common aliases and variations):
${faqLines}

Match by meaning — accept typos, paraphrases, and synonyms. Assign confidence 0.0–1.0 based on semantic similarity.
Return JSON only with this shape: {"faqNumber": number|null, "confidence": number, "reason": string}.`;
}

function getPreparedClassifier() {
  preparedClassifierPromise ??= (async () => {
    const cfg = await getRuntimeConfig();
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg,
      agentId: AGENT_ID,
      modelRef: "openai/gpt-5.4-mini",
      allowBundledStaticCatalogFallback: true,
      skipPiDiscovery: true
    });
    if ("error" in prepared) throw new Error(prepared.error);
    return { cfg, model: prepared.model, auth: prepared.auth };
  })();
  return preparedClassifierPromise;
}

function parseClassifierJson(text) {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith("{")
    ? trimmed
    : trimmed.match(/\{[\s\S]*\}/)?.[0] ?? "";
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

async function classifyFaqWithAi(incoming) {
  const prepared = await getPreparedClassifier();
  const result = await completeWithPreparedSimpleCompletionModel({
    cfg: prepared.cfg,
    model: prepared.model,
    auth: prepared.auth,
    context: {
      systemPrompt: [
        "You are a semantic FAQ classifier.",
        "Compare the incoming message to the approved FAQ questions and their aliases by MEANING, not exact text.",
        "Accept typos, paraphrases, synonyms, and informal phrasing as matches when the intent is the same.",
        "Assign a confidence score from 0.0 to 1.0 reflecting how closely the meaning matches.",
        "Select a FAQ only when semantic similarity is clear; do not guess on ambiguous messages.",
        "Do not answer the user.",
        "Do not invent new FAQs.",
        "Return JSON only."
      ].join(" "),
      messages: [{
        role: "user",
        content: buildFaqClassifierPrompt(incoming),
        timestamp: Date.now()
      }]
    },
    options: {
      maxTokens: 120,
      reasoning: "low"
    }
  });
  const parsed = parseClassifierJson(extractAssistantText(result) ?? "");
  const faqNumber = Number(parsed?.faqNumber);
  const confidence = Number(parsed?.confidence);
  if (!Number.isInteger(faqNumber) || faqNumber < 1 || faqNumber > FAQS.length) {
    return {
      matchedFaq: null,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      reason: typeof parsed?.reason === "string" ? parsed.reason : "no faq selected"
    };
  }
  return {
    matchedFaq: FAQS[faqNumber - 1],
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason: typeof parsed?.reason === "string" ? parsed.reason : null
  };
}

async function sendFaqReply(event, ctx, reply) {
  const threadId = threadIdFromEvent(event, ctx);
  if (!threadId) throw new Error("Missing Zalo thread id");
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
    writeDecisionLog({ event, ctx, incoming, matchedFaq: null, reply: null, reason: "own message" });
    return { handled: true };
  }

  if (!rememberMessage(messageId)) return { handled: true };

  let classification;
  try {
    classification = await classifyFaqWithAi(incoming);
  } catch (error) {
    const reason = "ai classification failed: " + (error instanceof Error ? error.message : String(error));
    writeDecisionLog({ event, ctx, incoming, matchedFaq: null, reply: null, confidence: 0, reason });
    return { handled: true };
  }

  const { matchedFaq, confidence, reason } = classification;
  const reply = matchedFaq && confidence >= AI_CONFIDENCE_THRESHOLD ? matchedFaq.answer : null;
  writeDecisionLog({ event, ctx, incoming, matchedFaq: reply ? matchedFaq : null, reply, confidence, reason });

  if (!reply) return { handled: true };

  await sleep(randomReplyDelayMs());
  try {
    await sendFaqReply(event, ctx, reply);
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
