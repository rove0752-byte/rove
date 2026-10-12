import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
  defaultTools: false,
  build: { externalDependencies: ['playwright', 'playwright-core', '@sparticuz/chromium'] },
  limits: { maxInputTokensPerSession: 30000, maxOutputTokensPerSession: 4000, maxTokenCostUsdPerSession: 0.25, sessionTimeoutMs: 120000 },
});
