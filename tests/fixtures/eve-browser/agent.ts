import { defineAgent } from 'eve';
import { mockModel } from 'eve/evals';

export default defineAgent({
  defaultTools: false,
  modelContextWindowTokens: 128_000,
  build: { externalDependencies: ['playwright', 'playwright-core', '@sparticuz/chromium'] },
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (toolResults.length) return JSON.stringify(toolResults.map(result => result.output));
    const input = JSON.parse(lastUserMessage ?? '{}');
    return { toolCalls: [{ name: input.name, input: { url: input.url } }] };
  }),
});
