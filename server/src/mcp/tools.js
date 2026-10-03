// MCP server definition: tools, prompts and resources that let Claude produce music.
// Works on top of a user-scoped "backend" (see ../backend.js), so the same tools serve both the
// Streamable HTTP endpoint (/mcp) and the stdio bridge.
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { summarizeProject } from '@greanteadawy/core';
import { GUIDE, INSTRUCTIONS } from './guide.js';
import { registerProjectTools } from './tools/projects.js';
import { registerSoundTools } from './tools/sounds.js';
import { registerNoteTools } from './tools/notes.js';
import { registerArrangeTools } from './tools/arrange.js';
import { registerMixTools } from './tools/mix.js';
import { registerSampleTools } from './tools/samples.js';
import { registerProductionTools } from './tools/production.js';
import { registerExportTools } from './tools/export.js';
import { registerSpatialTools } from './tools/spatial.js';
import { registerPluginTools } from './tools/plugins.js';
import { registerPrompts } from './prompts.js';

export { GUIDE };

/** The server's version (from server/package.json, so a release only bumps package versions). */
export const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/** Build the MCP server for one user. `backend` is a local or remote user-scoped backend. */
export function createMcpServer(backend) {
  const server = new McpServer(
    { name: 'greanteadawy', title: 'GreanTeaDawy', version: VERSION },
    { instructions: INSTRUCTIONS }
  );

  async function resolveProjectId(projectId) {
    if (projectId) return projectId;
    const id = await backend.getActiveId();
    if (!id) throw new Error('No active project. Use create_project or open_project first.');
    return id;
  }
  async function load(projectId) {
    return backend.getProject(await resolveProjectId(projectId));
  }

  /** registerTool with uniform error reporting (errors become isError results, never protocol errors). */
  function tool(name, config, handler) {
    server.registerTool(name, config, async (args, extra) => {
      try {
        return await handler(args || {}, extra);
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    });
  }

  const ctx = { server, backend, tool, load, resolveProjectId };
  registerProjectTools(ctx);
  registerSoundTools(ctx);
  registerNoteTools(ctx);
  registerArrangeTools(ctx);
  registerMixTools(ctx);
  registerSampleTools(ctx);
  registerProductionTools(ctx);
  registerExportTools(ctx);
  registerSpatialTools(ctx);
  registerPluginTools(ctx);
  registerPrompts(ctx);

  server.registerResource('guide', 'greanteadawy://guide', {
    title: 'GreanTeaDawy guide', description: 'Concepts, time units and notation used by the tools', mimeType: 'text/markdown'
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }] }));

  server.registerResource('active-project', 'greanteadawy://project/active', {
    title: 'Active project', description: 'Summary of the project currently open', mimeType: 'text/plain'
  }, async (uri) => {
    const p = await load();
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: summarizeProject(p) }] };
  });

  return server;
}
