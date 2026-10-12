import { defineEval } from 'eve/evals';
import { equals } from 'eve/evals/expect';
import type config from './evals.config';

export default defineEval<typeof config>({
  timeoutMs: 90_000,
  async test(t) {
    for (const name of ['browser__navigate', 'browser__snapshot', 'inspect_page']) {
      const turn = await t.send(JSON.stringify({ name, url: t.context.origin }));
      turn.succeeded();
      turn.calledTool(name, { count: 1, status: 'completed', output: (value: any) => {
        if (value?.title !== 'Eve isolated fixture' || value?.mode !== 'read_only_no_javascript') return false;
        if (name === 'inspect_page') return !!value.evidenceId && /^[a-f0-9]{64}$/.test(value.screenshotSha256);
        return value.elements?.some((element: any) => element.role === 'textbox' && element.accessibility.includes('Your name')) &&
          value.elements.some((element: any) => element.accessibility.includes('Accessible action')) &&
          value.elements.some((element: any) => element.disabled && element.accessibility.includes('Unavailable')) &&
          !value.elements.some((element: any) => element.accessibility.includes('Hidden control'));
      } });
      t.log(`${name}: ${turn.message}`);
    }
    t.noFailedActions();
    t.maxToolCalls(3);
    t.check(t.context.requests.every(request => request === 'GET /'), equals(true));
    t.log(`Fixture requests: ${JSON.stringify(t.context.requests)}`);
  },
});
