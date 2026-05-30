import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getRuntimeConfig } from "openclaw/plugin-sdk/config-runtime";
import { completeWithPreparedSimpleCompletionModel, extractAssistantText, prepareSimpleCompletionModelForAgent } from "openclaw/plugin-sdk/simple-completion-runtime";

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

let _preparedClassifierPromise;
function getPreparedClassifier() {
  _preparedClassifierPromise ??= (async () => {
    const cfg = await getRuntimeConfig();
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg,
      agentId: AGENT_ID,
      allowBundledStaticCatalogFallback: true,
      skipPiDiscovery: true
    });
    if ("error" in prepared) throw new Error(prepared.error);
    return { cfg, model: prepared.model, auth: prepared.auth };
  })();
  return _preparedClassifierPromise;
}

async function classifyWithAi(incoming, faqs, history = []) {
  const prepared = await getPreparedClassifier();
  const faqList = faqs
    .map((faq, i) => `${i + 1}. Q: ${faq.question}\n   A: ${faq.answer}`)
    .join("\n\n");

  const historyMessages = history.map(msg => ({
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp
  }));

  const result = await completeWithPreparedSimpleCompletionModel({
    cfg: prepared.cfg,
    model: prepared.model,
    auth: prepared.auth,
    context: {
      systemPrompt: [
        "Bạn là hệ thống trả lời FAQ.",
        "Chỉ được dùng thông tin trong danh sách FAQ bên dưới.",
        "TUYỆT ĐỐI không dùng kiến thức bên ngoài, không tra mạng, không tự bịa thêm.",
        "Dựa vào lịch sử hội thoại (nếu có) để hiểu ngữ cảnh của câu hỏi hiện tại.",
        "Nếu câu hỏi liên quan: trả về faqIndex của mục phù hợp nhất và trích nguyên câu trả lời A của mục đó vào answer.",
        "Nếu không liên quan đến bất kỳ FAQ nào: faqIndex null, answer null.",
        "Chỉ trả JSON."
      ].join(" "),
      messages: [
        ...historyMessages,
        {
          role: "user",
          content: `Tin nhắn: "${incoming}"\n\nDanh sách FAQ:\n${faqList}\n\nTrả về JSON: {"faqIndex": number|null, "answer": string|null, "confidence": number (0.0-1.0)}`,
          timestamp: Date.now()
        }
      ]
    },
    options: { maxTokens: 300, reasoning: "low" }
  });

  const text = extractAssistantText(result) ?? "";
  const jsonStr = text.trim().startsWith("{") ? text.trim() : (text.match(/\{[\s\S]*\}/) ?? [""])[0];
  try {
    const parsed = JSON.parse(jsonStr);
    const confidence = Number(parsed?.confidence) || 0;
    const idx = Number(parsed?.faqIndex);
    // Dùng answer từ AI (đã được nhắc chỉ trích từ FAQ), fallback về faq.answer nếu có index hợp lệ
    const aiAnswer = typeof parsed?.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : null;
    if (!Number.isInteger(idx) || idx < 1 || idx > faqs.length) {
      if (!aiAnswer) return { faq: null, confidence, reason: "no faq selected" };
      return { faq: { question: null, answer: aiAnswer }, confidence, reason: null };
    }
    return { faq: { ...faqs[idx - 1], answer: aiAnswer ?? faqs[idx - 1].answer }, confidence, reason: null };
  } catch {
    return { faq: null, confidence: 0, reason: "json parse error" };
  }
}

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const FAQ_PATH = join(PLUGIN_ROOT, "faq.csv");
const CHANNEL_ID = "zalouser";
const LOG_PATH = join(process.env.HOME ?? ".", ".openclaw", "logs", "faq-autoreply.jsonl");
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const AGENT_ID = "main";
const AI_CONFIDENCE_THRESHOLD = 0.4;
const CONV_TTL_MS = 30 * 60 * 1000;
const MAX_CONV_MESSAGES = 10;

const processedMessages = new Map();
const conversationHistory = new Map();

function getConvHistory(threadId) {
  const entry = conversationHistory.get(threadId);
  if (!entry) return [];
  if (Date.now() - entry.lastActivity > CONV_TTL_MS) {
    conversationHistory.delete(threadId);
    return [];
  }
  return entry.messages;
}

function updateConvHistory(threadId, userMessage, botReply) {
  const entry = conversationHistory.get(threadId) ?? { messages: [], lastActivity: 0 };
  entry.messages.push({ role: "user", content: userMessage, timestamp: Date.now() });
  if (botReply) {
    entry.messages.push({ role: "assistant", content: botReply, timestamp: Date.now() });
  }
  if (entry.messages.length > MAX_CONV_MESSAGES) {
    entry.messages = entry.messages.slice(-MAX_CONV_MESSAGES);
  }
  entry.lastActivity = Date.now();
  conversationHistory.set(threadId, entry);
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
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

function parseCsv(text) {
  const rows = [];
  let field = "";
  let inQuotes = false;
  let row = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ""; }
      else if (ch === '\r' && next === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
      else field += ch;
    }
  }
  if (row.length > 0 || field) { row.push(field); if (row.some(f => f.trim())) rows.push(row); }
  return rows;
}

function loadFaqs() {
  try {
    const rows = parseCsv(readFileSync(FAQ_PATH, "utf8"));
    if (rows.length < 2) return [];
    return rows.slice(1).map((row) => {
      const question = (row[0] ?? "").trim();
      const answer = (row[1] ?? "").trim();
      if (!question || !answer) return null;
      return { question, answer };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function findFaqMatchWithAi(messageText, threadId = "") {
  const faqs = loadFaqs();
  if (faqs.length === 0) return { faq: null, score: null, matchType: null, skippedReason: "no_faqs" };

  const history = getConvHistory(threadId);
  let aiResult;
  try {
    aiResult = await classifyWithAi(messageText, faqs, history);
  } catch (error) {
    console.error("[faq-autoreply] AI error: " + (error instanceof Error ? error.message : String(error)));
    return { faq: null, score: null, matchType: "ai", skippedReason: "ai_error" };
  }

  const { faq, confidence } = aiResult;
  if (!faq || confidence < AI_CONFIDENCE_THRESHOLD) {
    return { faq: null, score: confidence ?? null, matchType: "ai", skippedReason: `ai_low_confidence:${(confidence ?? 0).toFixed(2)}` };
  }
  return { faq, score: confidence, matchType: "ai", skippedReason: null };
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

  if (!normalized) return { handled: true };
  if (!rememberMessage(messageId)) return { handled: true };

  const threadId = threadIdFromEvent(event, ctx);
  const { faq, score, matchType, skippedReason } = await findFaqMatchWithAi(incoming, threadId);
  writeDecisionLog({
    event, ctx, incoming,
    matchedFaq: faq ?? null,
    reply: faq?.answer ?? null,
    fuseScore: score,
    matchType,
    skippedReason
  });

  if (!faq) {
    updateConvHistory(threadId, incoming, null);
    return { handled: true };
  }

  await sleep(randomReplyDelayMs());
  try {
    await sendFaqReply(event, ctx, faq.answer);
    updateConvHistory(threadId, incoming, faq.answer);
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
