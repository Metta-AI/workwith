// Just enough of MCP's streamable-HTTP transport to hand the lead agent a
// few tools: JSON-RPC over POST, answered with plain JSON (no SSE needed).

import type { IncomingMessage, ServerResponse } from 'node:http'

export type Tool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: any): Promise<unknown> | unknown
}

async function readBody(req: IncomingMessage): Promise<string> {
  let s = ''
  for await (const c of req) s += c
  return s
}

async function handleOne(m: any, tools: Tool[]): Promise<unknown> {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result })
  switch (m.method) {
    case 'initialize':
      return ok({
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'codinger', version: '0.1.0' },
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = tools.find((t) => t.name === m.params?.name)
      if (!tool) return ok({ content: [{ type: 'text', text: `Unknown tool ${m.params?.name}` }], isError: true })
      try {
        const r = await tool.run(m.params?.arguments ?? {})
        return ok({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] })
      } catch (e) {
        return ok({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true })
      }
    }
    default:
      return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } }
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, tools: Tool[]) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
  let body: any
  try { body = JSON.parse(await readBody(req)) } catch { res.writeHead(400).end(); return }
  const batch = Array.isArray(body) ? body : [body]
  const out = []
  for (const m of batch) if (m?.id !== undefined && m?.method) out.push(await handleOne(m, tools))
  if (!out.length) { res.writeHead(202).end(); return }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(body) ? out : out[0]))
}
