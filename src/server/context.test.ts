import assert from "node:assert/strict";
import test from "node:test";
import { ContextManager, parseHistorySearch } from "./context.js";
import { AppDatabase } from "./db.js";

test("parseHistorySearch accepts only a standalone bounded directive", () => {
  assert.equal(parseHistorySearch("[[search-history: orchid cache decision]]"), "orchid cache decision");
  assert.equal(parseHistorySearch("I will check [[search-history: orchid cache decision]]"), null);
  assert.equal(parseHistorySearch("[[search-history: no]]"), null);
});

test("context compresses older history while preserving and retrieving the full log", () => {
  const db = new AppDatabase(":memory:");
  const decision = db.insertMessage({
    roomId: "room-studio",
    authorType: "human",
    authorId: "user-sam",
    authorUsername: "sam",
    content: "Decision: use the orchid cache for launch memory because exact references matter.",
    parentMessageId: null,
    aiDepth: 0
  });
  for (let index = 0; index < 28; index += 1) {
    db.insertMessage({
      roomId: "room-studio",
      authorType: "human",
      authorId: "user-sam",
      authorUsername: "sam",
      content: `Project discussion ${index}: confirm the release checklist and review owner assignments.`,
      parentMessageId: null,
      aiDepth: 0
    });
  }
  const source = db.insertMessage({
    roomId: "room-studio",
    authorType: "human",
    authorId: "user-sam",
    authorUsername: "sam",
    content: "What did we decide about the orchid cache?",
    parentMessageId: null,
    aiDepth: 0
  });
  const countBefore = db.countMessages("room-studio");
  const context = new ContextManager(db, {
    recentMessageLimit: 6,
    summaryChunkSize: 10,
    summaryMinMessages: 4,
    historySearchResults: 6
  });
  const plan = context.build(db.getRoom("room-studio"), source.id, 4_000);

  assert.equal(db.countMessages("room-studio"), countBefore);
  assert.ok(plan.recentMessages.length <= 6);
  assert.ok(plan.summaries.length >= 1);
  assert.ok(plan.retrievedMessages.some((message) => message.id === decision.id));
  assert.ok(db.getContextStatus("room-studio").summarizedMessageCount >= 4);
  assert.ok(context.searchFullHistory("room-studio", "orchid cache", new Set()).some((message) => message.id === decision.id));
  db.close();
});
