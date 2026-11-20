import assert from "node:assert/strict";
import test from "node:test";
import { chunkNote, compactDiff, normalizeVaultPath, rankHybrid, summarizeContext, tokenize } from "../src/core";

test("vault path validation prevents absolute paths, traversal, and Obsidian settings edits", () => {
  assert.equal(normalizeVaultPath("Drafts\\Book.md"), "Drafts/Book.md");
  for (const value of ["../outside.md", "Drafts/../../outside.md", "/etc/passwd", "C:\\notes\\x.md", ".obsidian/plugins/x/main.js"]) {
    assert.throws(() => normalizeVaultPath(value), /not allowed|vault-relative|settings files/i, value);
  }
});

test("chunking keeps heading context and strips frontmatter", () => {
  const chunks = chunkNote("Projects/Novel.md", "---\ntitle: River\ntags: [novel]\n---\n# River City\nA story about a flood.\n\n## Characters\nMira is a cartographer.");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, "River City");
  assert.match(chunks[1].text, /Characters/);
  assert.doesNotMatch(chunks[0].text, /title: River/);
});

test("hybrid retrieval ranks relevant passages and keeps snippets bounded", () => {
  const chunks = [
    ...chunkNote("Projects/Novel.md", "# River City\nA story about a flood and a map maker."),
    ...chunkNote("Work/Invoices.md", "# Invoices\nPayment was due last Friday."),
  ];
  const lexical = rankHybrid("story about flood", chunks, undefined, 4);
  assert.equal(lexical[0].path, "Projects/Novel.md");
  const vectors = [0.1, 0.2, 0.7];
  const semanticChunks = chunks.map((chunk, index) => ({ ...chunk, vector: index === 0 ? [1, 0, 0] : [0, 1, 0] }));
  const semantic = rankHybrid("a memory of water", semanticChunks, [1, 0, 0], 2);
  assert.equal(semantic[0].path, "Projects/Novel.md");
  assert.ok(semantic[0].excerpt.length <= 900);
});

test("context remains compact and change diff isolates only changed text", () => {
  const text = summarizeContext("edit the opening", [{ path: "Novel.md", heading: "Opening", excerpt: "A concise relevant passage.", score: 0.9 }], []);
  assert.match(text, /\[\[Novel\]\]/);
  assert.ok(text.length < 1200);
  assert.deepEqual(compactDiff("Before sentence. After unchanged.", "Revised sentence. After unchanged."), { removed: "Before", added: "Revised" });
  assert.deepEqual(tokenize("River, river! map-maker 42"), ["river", "river", "map-maker", "42"]);
});
