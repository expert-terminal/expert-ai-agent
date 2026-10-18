// Opt-in compatibility probe. Uses the same gateway session as the desktop app;
// never prints the credential or writes to the user's agent history.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';

const token = process.env.EXPERT_AI_SESSION_TOKEN;
if (!token) {
  console.error('Set EXPERT_AI_SESSION_TOKEN to run this opt-in live gateway probe.');
  process.exitCode = 2;
} else {
  const models = createModels();
  models.setProvider(createProvider({
    id: 'expert-ai-gateway',
    name: 'Expert AI',
    baseUrl: 'https://api.ssv.asia/v1',
    auth: { apiKey: { name: 'Expert AI session', resolve: async () => ({ auth: { apiKey: token } }) } },
    models: [{
      id: 'openrouter/unlimited', name: 'Expert AI', api: 'openai-completions',
      provider: 'expert-ai-gateway', baseUrl: 'https://api.ssv.asia/v1',
      reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    }],
    api: openAICompletionsApi(),
  }));
  const start = performance.now();
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'expert-ai-gateway', modelId: 'openrouter/unlimited' } },
    });
    const submission = await conversation.submit({ type: 'input', content: 'Hi', requestId: 'durable-smoke-hi' }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    const elapsedMs = Math.round(performance.now() - start);
    if (settled.status !== 'done' || settled.type !== 'input') {
      console.error(JSON.stringify({ status: settled.status, type: settled.type, reason: settled.reason, elapsedMs }));
      process.exitCode = 1;
    } else {
      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
      const reply = answer?.model?.[0]?.content?.filter((part) => part.type === 'text')
        .map((part) => part.text).join('') ?? '';
      console.log(JSON.stringify({ status: 'done', elapsedMs, reply }));
    }
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}
