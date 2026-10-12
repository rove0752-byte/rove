import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { navigate } from '../lib/browser';
export default defineTool({
  description: 'Navigate to a public HTTP(S) URL and discover up to 60 visible interactive elements by accessibility role and name. Read-only, JavaScript disabled; no clicking, uploads, downloads or form submissions. At most five redirects. Browser closes after each call.',
  inputSchema: z.object({ url: z.string().url().max(2048) }).strict(),
  execute: ({ url }) => navigate(url),
});
