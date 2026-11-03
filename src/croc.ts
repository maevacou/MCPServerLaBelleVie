import type { AuthInfo, CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { registerTools } from './tools';

/**
 * REST bridge for the Croc Eat web app (Vercel + Supabase).
 *
 * The browser sends `{ tool, arguments, householdId }` with its Supabase
 * access token. We check the token with Supabase itself (`/auth/v1/user`),
 * then check — with the caller's own token, so Row Level Security decides —
 * that the caller belongs to that household. The household then gets one
 * La Belle Vie connection shared by its members, linked once through the
 * usual one-time /connect page. No La Belle Vie credential ever transits here.
 *
 * Tools are the exact MCP handlers from `registerTools`, captured in-process.
 */

type ToolCtx = { http?: { authInfo?: AuthInfo; req?: Request } };
type Handler = (args: unknown, ctx: ToolCtx) => Promise<CallToolResult>;
type Tool = { schema?: z.ZodType; handler: Handler };

let tools: Map<string, Tool> | undefined;

/** All registered tools, captured once with a minimal registerTool shim. */
export function crocTools(): Map<string, Tool> {
  if (!tools) {
    const map = new Map<string, Tool>();
    const shim = {
      registerTool(name: string, config: { inputSchema?: z.ZodType }, handler: Handler) {
        map.set(name, { schema: config.inputSchema, handler });
      },
    };
    registerTools(shim as unknown as McpServer);
    tools = map;
  }
  return tools;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CrocConfig {
  supabaseUrl: string;
  anonKey: string;
  origins: string[];
}

export function crocConfig(): CrocConfig | null {
  const supabaseUrl = process.env.CROC_SUPABASE_URL?.trim().replace(/\/+$/, '');
  const anonKey = process.env.CROC_SUPABASE_ANON_KEY?.trim();
  const origins = (process.env.CROC_EAT_ORIGIN || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!supabaseUrl || !anonKey || origins.length === 0) return null;
  return { supabaseUrl, anonKey, origins };
}

/** CORS headers, only ever echoing an allow-listed origin. */
export function corsHeaders(req: Request, config: CrocConfig | null): Record<string, string> {
  const origin = req.headers.get('origin');
  const base: Record<string, string> = { vary: 'Origin', 'cache-control': 'no-store' };
  if (!config || !origin || !config.origins.includes(origin)) return base;
  return {
    ...base,
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  });
}

async function supabaseUserId(config: CrocConfig, token: string): Promise<string | null> {
  const res = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: config.anonKey },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const user = (await res.json().catch(() => null)) as { id?: unknown } | null;
  return typeof user?.id === 'string' && UUID.test(user.id) ? user.id : null;
}

async function isMember(config: CrocConfig, token: string, householdId: string, userId: string): Promise<boolean> {
  const url =
    `${config.supabaseUrl}/rest/v1/household_members?select=household_id` +
    `&household_id=eq.${householdId}&user_id=eq.${userId}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, apikey: config.anonKey, accept: 'application/json' },
  }).catch(() => null);
  if (!res || !res.ok) return false;
  const rows = await res.json().catch(() => null);
  return Array.isArray(rows) && rows.length > 0;
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function crocOptions(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req, crocConfig()) });
}

export async function crocPost(req: Request): Promise<Response> {
  const config = crocConfig();
  const headers = corsHeaders(req, config);
  if (!config) return json({ error: 'not_configured' }, 503, headers);
  const origin = req.headers.get('origin');
  if (origin && !config.origins.includes(origin)) return json({ error: 'forbidden_origin' }, 403, headers);

  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1];
  if (!token) return json({ error: 'unauthorized' }, 401, headers);

  const body = (await req.json().catch(() => null)) as
    | { tool?: unknown; arguments?: unknown; householdId?: unknown }
    | null;
  const name = typeof body?.tool === 'string' ? body.tool : '';
  const householdId = typeof body?.householdId === 'string' ? body.householdId : '';
  if (!UUID.test(householdId)) return json({ error: 'bad_request', message: 'householdId manquant' }, 400, headers);
  const tool = crocTools().get(name);
  if (!tool) return json({ error: 'unknown_tool' }, 404, headers);

  const userId = await supabaseUserId(config, token);
  if (!userId) return json({ error: 'unauthorized' }, 401, headers);
  if (!(await isMember(config, token, householdId, userId))) return json({ error: 'forbidden' }, 403, headers);

  const parsed = tool.schema ? tool.schema.safeParse(body?.arguments ?? {}) : { success: true, data: {} };
  if (!parsed.success) return json({ error: 'bad_request', message: 'Arguments invalides' }, 400, headers);

  const authInfo: AuthInfo = {
    token,
    clientId: 'croc-eat',
    scopes: ['groceries'],
    extra: { crocHousehold: householdId },
  };
  const result = await tool.handler(parsed.data, { http: { authInfo, req } });
  return json(
    { payload: result.structuredContent ?? textOf(result), isError: Boolean(result.isError) },
    200,
    headers,
  );
}
