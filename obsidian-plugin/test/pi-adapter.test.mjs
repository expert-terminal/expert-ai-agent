import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test("Pi adapter registers Obsidian tools and injects only short local context for the paired vault", async () => {
  const extensionPath = new URL("../dist/obsidian-pi-extension.mjs", import.meta.url);
  const extensionFile = fileURLToPath(extensionPath);
  const bridgeFile = join(dirname(extensionFile), "bridge.json");
  const port = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ""; req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        assert.equal(req.headers.authorization, "Bearer test-token");
        res.writeHead(200, { "content-type": "application/json" });
        const parsed = JSON.parse(body);
        res.end(JSON.stringify({ ok: true, result: parsed.action === "context" ? { text: "Local note snippet" } : { ok: true, action: parsed.action } }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    test.after(() => new Promise((done) => server.close(done)));
  });
  const bridge = { port, token: "test-token", vaultPath: "C:/vault" };
  await writeFile(bridgeFile, JSON.stringify(bridge));
  const { default: extension } = await import(pathToFileURL(extensionFile).href + `?test=${Date.now()}`);
  const tools = new Map(); const events = new Map();
  extension({ registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { events.set(name, handler); } });
  for (const name of ["obsidian_search", "obsidian_read", "obsidian_write", "obsidian_capture", "obsidian_move", "obsidian_history", "obsidian_undo", "obsidian_status", "obsidian_batch", "obsidian_workspace"]) assert.ok(tools.has(name), name);
  assert.equal(typeof tools.get("obsidian_write").execute, "function");
  assert.match(tools.get("obsidian_undo").description, /preview.*confirm=true/i);
  const result = await events.get("before_agent_start")({ prompt: "edit the chapter", systemPrompt: "base", systemPromptOptions: { cwd: "c:/vault/Novel" } });
  assert.match(result.systemPrompt, /Local note snippet/);
  const unrelated = await events.get("before_agent_start")({ prompt: "edit code", systemPrompt: "base", systemPromptOptions: { cwd: "c:/code" } });
  assert.match(unrelated.systemPrompt, /Local note snippet/, "connected vault retrieval is available even when the Agent working directory is elsewhere");
  assert.match(unrelated.systemPrompt, /vault-relative note paths as citations/);
  assert.match(unrelated.systemPrompt, /obsidian_batch/);
  const tool = await tools.get("obsidian_status").execute("id", {}, undefined, () => {}, {});
  assert.match(tool.content[0].text, /status/);
  await rm(bridgeFile, { force: true });
});
