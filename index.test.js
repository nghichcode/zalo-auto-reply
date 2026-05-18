import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// ─── hoist mock handles so they're available inside vi.mock factories ───────
const { mockSend, mockExtractText } = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue({ ok: true }),
  mockExtractText: vi.fn(() => null),
}));

// ─── mock all external dependencies ─────────────────────────────────────────

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  // return the raw config so we can call plugin.register() ourselves
  definePluginEntry: (config) => config,
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  getRuntimeConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  prepareSimpleCompletionModelForAgent: vi.fn().mockResolvedValue({ model: "test-model", auth: "test-auth" }),
  completeWithPreparedSimpleCompletionModel: vi.fn().mockResolvedValue({}),
  extractAssistantText: mockExtractText,
}));

vi.mock("/Users/cya/.openclaw/npm/node_modules/@openclaw/zalouser/dist/test-api.js", () => ({
  sendMessageZalouser: mockSend,
}));

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

// ─── import plugin (mocks already in place via hoisting) ────────────────────
import plugin from "./index.js";

// Extract handleFaq through the plugin registration API
let handleFaq;
plugin.register({
  on: (event, handler) => {
    if (event === "inbound_claim") handleFaq = handler;
  },
});

// ─── helpers ─────────────────────────────────────────────────────────────────

let msgCounter = 0;

/** Build a minimal inbound event for the zalouser channel. */
function makeEvent(body, overrides = {}) {
  return {
    channel: "zalouser",
    body,
    messageId: `test-msg-${++msgCounter}`, // unique per call → avoids cross-test dedup
    conversationId: "thread-1",
    senderId: "user-1",
    isGroup: false,
    isSelf: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

const BASE_CTX = { channelId: "zalouser", accountId: "bot-1" };

/** Tell the mocked AI which FAQ to return and with what confidence. */
function setAiResponse(faqNumber, confidence = 0.95) {
  mockExtractText.mockReturnValue(
    JSON.stringify({ faqNumber, confidence, reason: "test" })
  );
}

/** Run handleFaq, advance fake timers to skip the reply delay, assert send. */
async function expectReply(event, ctx, expectedAnswer) {
  const p = handleFaq(event, ctx);
  await vi.runAllTimersAsync();
  await p;
  expect(mockSend).toHaveBeenCalledOnce();
  expect(mockSend).toHaveBeenCalledWith("thread-1", expectedAnswer, expect.any(Object));
}

/** Run handleFaq, advance fake timers, assert nothing was sent. */
async function expectNoReply(event, ctx) {
  const p = handleFaq(event, ctx);
  await vi.runAllTimersAsync();
  await p;
  expect(mockSend).not.toHaveBeenCalled();
}

// ─── test suite ──────────────────────────────────────────────────────────────

describe("FAQ autoreply: question → answer", () => {
  beforeAll(() => vi.useFakeTimers());
  afterAll(() => vi.useRealTimers());
  beforeEach(() => {
    mockSend.mockClear();
    mockExtractText.mockReturnValue(null);
  });

  // ── table: [input, expectedAnswer, faqNumber] ───────────────────────────
  const cases = [
    // FAQ 1 – hello
    ["hello",               "Hi! How can I help you today?",                  1],
    ["hi",                  "Hi! How can I help you today?",                  1],
    ["hey",                 "Hi! How can I help you today?",                  1],
    ["helo",                "Hi! How can I help you today?",                  1], // typo
    ["heloo",               "Hi! How can I help you today?",                  1], // typo

    // FAQ 2 – how are you
    ["how are you",         "I'm doing great. Thanks for asking!",            2],
    ["how r u",             "I'm doing great. Thanks for asking!",            2],
    ["hows it going",       "I'm doing great. Thanks for asking!",            2],
    ["how do you do",       "I'm doing great. Thanks for asking!",            2],

    // FAQ 3 – what is your name
    ["what is your name",   "My name is Kataa Bot.",                          3],
    ["whats your name",     "My name is Kataa Bot.",                          3],
    ["your name",           "My name is Kataa Bot.",                          3],
    ["who are you",         "My name is Kataa Bot.",                          3],

    // FAQ 4 – who created you
    ["who created you",     "I was created by my developer using OpenClaw.",  4],
    ["who made you",        "I was created by my developer using OpenClaw.",  4],
    ["who built you",       "I was created by my developer using OpenClaw.",  4],

    // FAQ 5 – what can you do
    ["what can you do",     "I can automatically reply to approved questions.", 5],
    ["what do you do",      "I can automatically reply to approved questions.", 5],
    ["help me",             "I can automatically reply to approved questions.", 5],

    // FAQ 6 – where are you from
    ["where are you from",  "I'm running from a cloud server.",               6],
    ["where do you live",   "I'm running from a cloud server.",               6],

    // FAQ 7 – good morning
    ["good morning",        "Good morning! Hope you have a great day.",       7],
    ["gm",                  "Good morning! Hope you have a great day.",       7],
    ["gud morning",         "Good morning! Hope you have a great day.",       7], // typo
    ["morning",             "Good morning! Hope you have a great day.",       7],

    // FAQ 8 – good night
    ["good night",          "Good night! Sleep well.",                        8],
    ["gn",                  "Good night! Sleep well.",                        8],
    ["nite",                "Good night! Sleep well.",                        8],
    ["goodnite",            "Good night! Sleep well.",                        8], // typo

    // FAQ 9 – bye
    ["bye",                 "Goodbye! See you again soon.",                   9],
    ["goodbye",             "Goodbye! See you again soon.",                   9],
    ["see you",             "Goodbye! See you again soon.",                   9],
    ["ttyl",                "Goodbye! See you again soon.",                   9],
    ["cya",                 "Goodbye! See you again soon.",                   9],

    // FAQ 10 – hola
    ["hola",                "kataa",                                          10],
    ["ola",                 "kataa",                                          10],
    ["holla",               "kataa",                                          10],
  ];

  it.each(cases)('"%s" → "%s"', async (input, expectedAnswer, faqNumber) => {
    setAiResponse(faqNumber);
    await expectReply(makeEvent(input), BASE_CTX, expectedAnswer);
  });

  // ── guard rails ──────────────────────────────────────────────────────────

  it("does not reply when confidence < 0.85", async () => {
    mockExtractText.mockReturnValue(
      JSON.stringify({ faqNumber: 1, confidence: 0.80, reason: "low confidence" })
    );
    await expectNoReply(makeEvent("hello"), BASE_CTX);
  });

  it("does not reply when confidence equals exactly 0.85 boundary minus epsilon", async () => {
    mockExtractText.mockReturnValue(
      JSON.stringify({ faqNumber: 1, confidence: 0.849, reason: "just below threshold" })
    );
    await expectNoReply(makeEvent("hello"), BASE_CTX);
  });

  it("replies when confidence equals exactly 0.85", async () => {
    mockExtractText.mockReturnValue(
      JSON.stringify({ faqNumber: 1, confidence: 0.85, reason: "at threshold" })
    );
    await expectReply(makeEvent("hello"), BASE_CTX, "Hi! How can I help you today?");
  });

  it("does not reply to own messages", async () => {
    setAiResponse(1);
    await expectNoReply(makeEvent("hello", { isSelf: true }), BASE_CTX);
  });

  it("does not reply on wrong channel", async () => {
    setAiResponse(1);
    await expectNoReply(
      makeEvent("hello", { channel: "telegram" }),
      { channelId: "telegram", accountId: "bot-1" }
    );
  });

  it("does not reply when AI returns no matching FAQ", async () => {
    mockExtractText.mockReturnValue(
      JSON.stringify({ faqNumber: null, confidence: 0.90, reason: "no match" })
    );
    await expectNoReply(makeEvent("random gibberish xyz"), BASE_CTX);
  });

  it("does not reply when AI response is unparseable", async () => {
    mockExtractText.mockReturnValue("not valid json at all");
    await expectNoReply(makeEvent("hello"), BASE_CTX);
  });

  it("deduplicates the same message ID", async () => {
    setAiResponse(1);
    const event = makeEvent("hello"); // fixed messageId for this test

    const p1 = handleFaq(event, BASE_CTX);
    await vi.runAllTimersAsync();
    await p1;
    expect(mockSend).toHaveBeenCalledOnce();

    mockSend.mockClear();
    setAiResponse(1);

    const p2 = handleFaq(event, BASE_CTX); // same event object → same messageId
    await vi.runAllTimersAsync();
    await p2;
    expect(mockSend).not.toHaveBeenCalled();
  });
});
