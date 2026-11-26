import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "./db.js";
import { parseMentions } from "./queue.js";

test("parseMentions normalizes names and ignores email addresses", () => {
  assert.deepEqual([...parseMentions("Ask @AI-Sol and @all-ai; email a@b.com")], ["ai-sol", "all-ai"]);
});

test("jobs are deduplicated and claimed in FIFO order", () => {
  const db = new AppDatabase(":memory:");
  const first = db.insertMessage({
    roomId: "room-studio", authorType: "human", authorId: "user-sam", authorUsername: "sam",
    content: "@all-ai review this", parentMessageId: null, aiDepth: 0
  });
  const agents = db.listRoomAgents("room-studio");
  assert.equal(agents.length, 2);
  assert.ok(db.enqueueJob("room-studio", first.id, agents[0]!.id, 1));
  assert.equal(db.enqueueJob("room-studio", first.id, agents[0]!.id, 1), null);
  assert.ok(db.enqueueJob("room-studio", first.id, agents[1]!.id, 1));
  assert.equal(db.claimNextJob("room-studio")?.agentId, agents[0]!.id);
  assert.equal(db.claimNextJob("room-studio")?.agentId, agents[1]!.id);
  db.close();
});
