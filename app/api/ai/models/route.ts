/**
 * @fileoverview AI Models API
 *
 * Retorna a lista de modelos disponíveis para o provider solicitado,
 * buscando diretamente da API do provider com a chave configurada no banco.
 *
 * @module app/api/ai/models/route
 */

import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { isAllowedOrigin } from '@/lib/security/sameOrigin';

// =============================================================================
// Types
// =============================================================================

export interface AIModelInfo {
  id: string;
  name: string;
  provider: 'google' | 'openai';
  /** true = alias auto-atualizado (ex: gemini-flash-latest) */
  isAlias: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Padrões de modelos a excluir do fetch do Google
const GOOGLE_EXCLUDED_PATTERNS = [
  'tts',
  'image',
  'robotics',
  'computer-use',
  'deep-research',
  'lyria',
  'gemma',
  'embedding',
  'aqa',
];

// Padrões de modelos a excluir do fetch da OpenAI
const OPENAI_EXCLUDED_PATTERNS = [
  'audio',
  'image',
  'realtime',
  'search',
  'codex',
  'deep-research',
  'embedding',
  'tts',
  'whisper',
  'davinci',
  'babbage',
  'moderation',
  'transcribe',
  'preview',
];

function isExcluded(id: string): boolean {
  return GOOGLE_EXCLUDED_PATTERNS.some((p) => id.includes(p));
}

function isOpenAIExcluded(id: string): boolean {
  return OPENAI_EXCLUDED_PATTERNS.some((p) => id.includes(p));
}

// IDs com sufixo de data (ex: gpt-4o-2024-08-06) são snapshots fixos;
// sem data são aliases auto-atualizados (ex: gpt-4o, o3-mini)
const DATE_SUFFIX_RE = /\d{4}-\d{2}-\d{2}$/;

async function fetchGoogleModels(apiKey: string): Promise<AIModelInfo[]> {
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    { headers: { 'x-goog-api-key': apiKey } }
  );
  if (!res.ok) throw new Error(`Google API error: HTTP ${res.status}`);

  const data = await res.json() as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };

  const all: AIModelInfo[] = (data.models ?? [])
    .filter((m) => {
      const id = m.name.replace('models/', '');
      return (
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent') &&
        !isExcluded(id)
      );
    })
    .map((m) => {
      const id = m.name.replace('models/', '');
      return {
        id,
        name: m.displayName || id,
        provider: 'google' as const,
        isAlias: id.endsWith('-latest'),
      };
    });

  // Aliases primeiro (sempre atualizados), depois versões fixas mais recente → mais antigo
  const aliases = all.filter((m) => m.isAlias);
  const pinned = all
    .filter((m) => !m.isAlias)
    .sort((a, b) => b.id.localeCompare(a.id));

  return [...aliases, ...pinned];
}

async function fetchOpenAIModels(apiKey: string): Promise<AIModelInfo[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenAI API error: HTTP ${res.status}`);

  const data = await res.json() as { data?: Array<{ id: string }> };

  // Snapshots no formato MMDD (ex: gpt-4-0613)
  const MMDD_SUFFIX_RE = /\d{4}$/;

  return (data.data ?? [])
    .filter((m) => {
      const id = m.id;
      const isChat = id.startsWith('gpt-4') || id.startsWith('gpt-5');
      const isSnapshot = DATE_SUFFIX_RE.test(id) || MMDD_SUFFIX_RE.test(id);
      const isLegacy = id === 'gpt-4';
      return isChat && !isOpenAIExcluded(id) && !isSnapshot && !isLegacy;
    })
    .map((m) => ({
      id: m.id,
      name: m.id,
      provider: 'openai' as const,
      isAlias: true,
    }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

// =============================================================================
// GET /api/ai/models?provider=google|openai
// =============================================================================

export async function GET(request: NextRequest) {
  if (!isAllowedOrigin(request)) {
    return json({ error: 'Forbidden' }, 403);
  }

  const provider = new URL(request.url).searchParams.get('provider');

  if (provider !== 'google' && provider !== 'openai') {
    return json(
      { error: 'Parâmetro "provider" inválido. Use "google" ou "openai".' },
      400
    );
  }

  const supabase = await createClient();

  // Autenticar
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return json({ error: 'Não autenticado' }, 401);
  }

  // Buscar organization_id via profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.organization_id) {
    return json({ models: [] });
  }

  // Buscar API key da organização
  const keyColumn = provider === 'google' ? 'ai_google_key' : 'ai_openai_key';

  const { data: settings, error: settingsError } = await supabase
    .from('organization_settings')
    .select(keyColumn)
    .eq('organization_id', profile.organization_id)
    .maybeSingle();

  if (settingsError || !settings) {
    return json({ models: [] });
  }

  const apiKey = settings[keyColumn as keyof typeof settings] as string | null;

  if (!apiKey) {
    return json({ models: [] });
  }

  try {
    const models =
      provider === 'google'
        ? await fetchGoogleModels(apiKey)
        : await fetchOpenAIModels(apiKey);

    return json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido';
    console.error(`[api/ai/models] ${message}`);
    return json({ error: `Falha ao buscar modelos: ${message}` }, 502);
  }
}
