import { NextResponse } from 'next/server';
import { authPublicApi } from '@/lib/public-api/auth';
import { createStaticAdminClient } from '@/lib/supabase/server';
import { buildCrmMcpRegistry } from '@/lib/mcp/crmRegistry';
import { zodToJsonSchema2020 } from '@/lib/mcp/zodToJsonSchema';

export const runtime = 'nodejs';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
};

function jsonRpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function getApiKeyFromHeaders(request: Request) {
  const headerKey = request.headers.get('x-api-key');
  if (headerKey?.trim()) return headerKey.trim();

  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m?.[1]?.trim()) return m[1].trim();

  return '';
}

async function authMcp(request: Request) {
  const apiKey = getApiKeyFromHeaders(request);
  if (!apiKey) return { ok: false as const, status: 401, body: { error: 'Missing API key', code: 'AUTH_MISSING' } };

  // `authPublicApi` expects X-Api-Key. Most MCP clients use Authorization: Bearer, so we normalize here.
  const headers = new Headers(request.headers);
  headers.set('x-api-key', apiKey);
  const normalized = new Request(request.url, { method: request.method, headers });

  return await authPublicApi(normalized);
}

function toToolResult(payload: unknown, opts?: { isError?: boolean }) {
  const isError = !!opts?.isError || (payload && typeof payload === 'object' && !Array.isArray(payload) && 'error' in (payload as any));
  const text = JSON.stringify(payload, null, 2);

  // MCP guidance: when returning structuredContent, also include serialized JSON in a text block.
  const structuredContent =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;

  return {
    content: [{ type: 'text', text }],
    ...(structuredContent ? { structuredContent } : {}),
    isError,
  };
}

async function resolveApiKeyOwnerUserId(opts: { apiKeyId: string; organizationId: string }) {
  const sb = createStaticAdminClient();
  const { data, error } = await sb
    .from('api_keys')
    .select('id, organization_id, created_by')
    .eq('id', opts.apiKeyId)
    .maybeSingle();

  if (error || !data) return null;
  if (data.organization_id !== opts.organizationId) return null;
  return data.created_by as string | null;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    name: 'crmia-next-mcp',
    endpoint: '/api/mcp',
    auth: 'Authorization: Bearer <API_KEY> (or X-Api-Key header)',
    protocolVersion: '2025-11-25',
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as JsonRpcRequest | null;
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return NextResponse.json(jsonRpcError(null, -32600, 'Invalid Request'), { status: 400 });
  }

  // initialize and notifications/initialized are public — MCP clients probe without auth
  if (body.method === 'initialize') {
    return NextResponse.json(
      jsonRpcResult(body.id, {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'crmia-next-mcp', version: '0.1.0' },
        capabilities: { tools: { listChanged: false } },
      })
    );
  }

  if (body.method === 'notifications/initialized') {
    return new NextResponse(null, { status: 204 });
  }

  // All other methods require authentication
  const auth = await authMcp(request);
  if (!auth.ok) {
    return NextResponse.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32001, message: auth.body.error, data: auth.body } }, { status: auth.status });
  }

  const userId = await resolveApiKeyOwnerUserId({ apiKeyId: auth.apiKeyId, organizationId: auth.organizationId });
  if (!userId) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32001, message: 'Invalid API key owner', data: { code: 'AUTH_OWNER_INVALID' } } },
      { status: 401 }
    );
  }

  // Minimal context for MCP execution. Tool args can still include boardId/dealId/etc.
  const registry = buildCrmMcpRegistry({
    context: { organizationId: auth.organizationId },
    userId,
  });

  if (body.method === 'tools/list') {
    const tools = registry.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: zodToJsonSchema2020(t.inputSchemaZod),
    }));

    return NextResponse.json(jsonRpcResult(body.id, { tools }));
  }

  if (body.method === 'tools/call') {
    const toolName = body.params?.name;
    const args = body.params?.arguments ?? {};
    if (typeof toolName !== 'string' || !toolName) {
      return NextResponse.json(jsonRpcError(body.id, -32602, 'Invalid params: missing tool name'), { status: 400 });
    }

    const tool = registry.toolByMcpName[toolName];
    if (!tool) {
      return NextResponse.json(jsonRpcError(body.id, -32602, `Unknown tool: ${toolName}`), { status: 400 });
    }

    // Validate inputs using the underlying Zod schema when available.
    const schema: any = (tool as any).inputSchema;
    if (schema && typeof schema.safeParse === 'function') {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const msg = parsed.error?.issues?.map((i: any) => i?.message).filter(Boolean).join('; ') || 'Invalid tool arguments';
        return NextResponse.json(jsonRpcResult(body.id, toToolResult({ error: msg }, { isError: true })));
      }

      try {
        const out = await (tool as any).execute(parsed.data);
        return NextResponse.json(jsonRpcResult(body.id, toToolResult(out)));
      } catch (e: any) {
        return NextResponse.json(jsonRpcResult(body.id, toToolResult({ error: e?.message || 'Tool execution failed' }, { isError: true })));
      }
    }

    // No schema: best-effort execute.
    try {
      const out = await (tool as any).execute(args);
      return NextResponse.json(jsonRpcResult(body.id, toToolResult(out)));
    } catch (e: any) {
      return NextResponse.json(jsonRpcResult(body.id, toToolResult({ error: e?.message || 'Tool execution failed' }, { isError: true })));
    }
  }

  return NextResponse.json(jsonRpcError(body.id, -32601, `Method not found: ${body.method}`), { status: 404 });
}

