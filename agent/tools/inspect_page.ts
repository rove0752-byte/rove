import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { inspectPage } from '../lib/browser';
export default defineTool({
  description:'Read a public web page and return text, links and screenshot evidence. JavaScript, submissions, downloads and non-GET requests are disabled. Each call opens an isolated browser. Follow links by inspecting their URLs.',
  inputSchema:z.object({url:z.string().url().max(2048)}),
  execute:({url})=>inspectPage(url),
  toModelOutput(output) { const {screenshotBase64,...evidence}=output; return {type:'json',value:evidence}; },
});
