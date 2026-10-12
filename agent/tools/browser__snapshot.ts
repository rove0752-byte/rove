import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { navigate } from '../lib/browser';
export default defineTool({
  description: 'Capture a fresh read-only accessibility inventory of up to 60 visible interactive elements at a public URL. Requires a URL: no browser state persists between calls. JavaScript, interactions, uploads, downloads and submissions are disabled.',
  inputSchema: z.object({ url: z.string().url().max(2048) }).strict(),
  execute: ({ url }) => navigate(url),
});
