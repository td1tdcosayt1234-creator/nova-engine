/* ============ Nova Engine — AI providers (Bring-Your-Own-Key + local Ollama) ============
   All providers funnel through chatComplete() with:
   • AbortController timeout (browser fetch) / racing timeout (desktop bridge)
   • 1 automatic retry with backoff on timeouts, network failures & transient HTTP (408/429/5xx)
   • Human-readable error messages (invalid key vs rate limit vs network vs wrong model) */

export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'groq' | 'ollama' | 'custom'

export interface AISettings {
  provider: ProviderKind
  baseUrl: string
  apiKey: string
  model: string
}

export const PROVIDER_INFO: Record<ProviderKind, {
  label: string
  needsKey: boolean
  defaultBase: string
  defaultModel: string
  models: string[]
  note: string
}> = {
  openai: {
    label: 'OpenAI',
    needsKey: true,
    defaultBase: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    note: 'platform.openai.com theke API key nao.'
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    needsKey: true,
    defaultBase: 'https://api.anthropic.com',
    defaultModel: 'claude-3-5-haiku-latest',
    models: ['claude-3-5-haiku-latest', 'claude-sonnet-4-20250514', 'claude-sonnet-4-5'],
    note: 'console.anthropic.com theke API key nao.'
  },
  gemini: {
    label: 'Google Gemini',
    needsKey: true,
    defaultBase: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'],
    note: 'aistudio.google.com/apikey theke free key pao.'
  },
  openrouter: {
    label: 'OpenRouter (300+ models)',
    needsKey: true,
    defaultBase: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o-mini', 'deepseek/deepseek-chat', 'meta-llama/llama-3.1-8b-instruct'],
    note: 'openrouter.ai/keys theke key nao — ek key diye sob model.'
  },
  groq: {
    label: 'Groq (ultra fast)',
    needsKey: true,
    defaultBase: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-8b-instant',
    models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'qwen2.5-coder-32b'],
    note: 'console.groq.com/keys theke free key pao.'
  },
  ollama: {
    label: 'Ollama (Local — free)',
    needsKey: false,
    defaultBase: 'http://localhost:11434',
    defaultModel: 'llama3.1',
    models: ['llama3.1', 'llama3.2', 'qwen2.5-coder', 'mistral', 'phi3', 'gemma2', 'deepseek-r1'],
    note: 'Local e cholle — key lagbe na. `ollama serve` chalu thakte hobe (model: "ollama pull llama3.1").'
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    needsKey: false,
    defaultBase: 'http://localhost:8080/v1',
    defaultModel: 'default',
    models: ['default'],
    note: 'Jekono OpenAI-compatible server (vLLM, LM Studio, LiteLLM...) — Base URL set koro.'
  }
}

const LS_KEY = 'nova.ai.settings'
const KNOWN: ProviderKind[] = ['openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'ollama', 'custom']

export function loadAISettings(): AISettings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const p = JSON.parse(raw) || {}
      const s: AISettings = {
        provider: KNOWN.includes(p.provider) ? p.provider : 'openai',
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
        apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
        model: typeof p.model === 'string' ? p.model : ''
      }
      // remember latest settings even while this session edits them:
      return Object.assign({ provider: 'openai', baseUrl: '', apiKey: '', model: '' }, s)
    }
  } catch { /* corrupted settings — fall through to defaults */ }
  return { provider: 'openai', baseUrl: '', apiKey: '', model: '' }
}

export function saveAISettings(s: AISettings) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model
    }))
  } catch { /* storage full / disabled */ }
}

export function normalizeSettings(s: AISettings): AISettings {
  const provider: ProviderKind = KNOWN.includes(s.provider) ? s.provider : 'openai'
  const info = PROVIDER_INFO[provider]
  let base = (s.baseUrl || '').trim()
  if (provider === 'ollama') {
    // Ollama talks native /api/chat here; strip a legacy OpenAI-compat "/v1" suffix.
    base = base.replace(/\/v1\/?$/i, '')
  }
  return {
    provider,
    baseUrl: base || info.defaultBase,
    apiKey: (s.apiKey || '').trim(),
    model: (s.model || '').trim() || info.defaultModel
  }
}

export function aiConfigured(s: AISettings): boolean {
  const n = normalizeSettings(s)
  const info = PROVIDER_INFO[n.provider]
  if (info.needsKey && !n.apiKey) return false
  return true
}

/* ---------- structured errors ---------- */

export class AIError extends Error {
  kind: 'http' | 'timeout' | 'network' | 'parse'
  status: number
  constructor(kind: AIError['kind'], message: string, status = 0) {
    super(message)
    this.name = 'AIError'
    this.kind = kind
    this.status = status
  }
}

function friendlyHttp(status: number, body: string, provider: ProviderKind): string {
  const info = PROVIDER_INFO[provider]
  const detail = (body || '').replace(/\s+/g, ' ').slice(0, 240)
  if (status === 401 || status === 403)
    return `Invalid or unauthorized API key (HTTP ${status}) — check your ${info.label} key in AI Settings.`
  if (status === 402)
    return `Out of credit / payment required (HTTP 402) for ${info.label}.`
  if (status === 404)
    return `Not found (HTTP 404) — wrong Base URL or unknown model. Check model & Base URL in AI Settings.`
  if (status === 408) return `Server timed out our request (HTTP 408) — try again.`
  if (status === 429)
    return `Rate limited (HTTP 429) — hit the quota; wait a bit or lower your usage.`
  if (status >= 500)
    return `${info.label} server error (HTTP ${status})${detail ? ':' + ' ' + detail : ''} — try again shortly.`
  return `AI request failed: HTTP ${status}${detail ? ' — ' + detail : ''}`
}

/* ---------- transport with timeout ---------- */

interface TransportRes { ok: boolean; status: number; text: string }

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new AIError('timeout', `${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) },
      e => { clearTimeout(t); reject(e) })
  })
}

async function transport(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<TransportRes> {
  const desktop = (window as any).nova?.aiFetch
  if (desktop) {
    // Electron main-process bridge (CORS-free). Can't abort the underlying request,
    // but we race a timeout so UI never hangs forever.
    try {
      return await withTimeout(desktop({ url, headers, body }), timeoutMs, 'AI request')
    } catch (err: any) {
      if (err instanceof AIError) throw err
      throw new AIError('network', `Desktop AI bridge error: ${String(err?.message || err).slice(0, 200)}`)
    }
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: ctl.signal })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } catch (err: any) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'))
      throw new AIError('timeout', `AI request timed out after ${Math.round(timeoutMs / 1000)}s`)
    throw new AIError('network', `Network error: ${String(err?.message || err).slice(0, 200)} (offline, DNS fail, or CORS-blocked — desktop app avoids CORS)`)
  } finally {
    clearTimeout(timer)
  }
}

interface ChatMsg { role: 'user' | 'assistant'; content: string }

export interface ChatOpts { timeoutMs?: number; retries?: number }

const DEFAULT_TIMEOUT = 120_000
const TEST_TIMEOUT = 30_000

export async function chatComplete(
  sRaw: AISettings,
  system: string,
  messages: ChatMsg[],
  temperature = 0.7,
  opts: ChatOpts = {}
): Promise<string> {
  const s = normalizeSettings(sRaw)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
  const retries = Math.max(0, opts.retries ?? 1)
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await wait(attempt === 1 ? 900 : 2200)
    try {
      return await chatAttempt(s, system, messages, temperature, timeoutMs)
    } catch (err) {
      lastErr = err
      const e = err as AIError
      const retriable = e instanceof AIError &&
        (e.kind === 'timeout' || e.kind === 'network' || (e.kind === 'http' && (e.status === 408 || e.status === 429 || e.status >= 500)))
      if (!retriable || attempt === retries) break
    }
  }
  throw lastErr
}

function wait(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

async function chatAttempt(s: AISettings, system: string, messages: ChatMsg[], temperature: number, timeoutMs: number): Promise<string> {
  const base = (s.baseUrl || '').replace(/\/+$/, '')
  let url = ''
  const headers: Record<string, string> = {}
  let body: any

  if (s.provider === 'anthropic') {
    url = `${base}/v1/messages`
    headers['x-api-key'] = s.apiKey
    headers['anthropic-version'] = '2023-06-02'
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
    body = { model: s.model, max_tokens: 8192, temperature, system, messages }
  } else if (s.provider === 'gemini') {
    if (!base.includes('/models')) {
      url = `${base}/models/${s.model}:generateContent?key=${encodeURIComponent(s.apiKey)}`
    } else {
      url = `${base}/${s.model}:generateContent?key=${encodeURIComponent(s.apiKey)}`
    }
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { temperature, maxOutputTokens: 8192 }
    }
  } else if (s.provider === 'ollama') {
    // Native Ollama: POST {base}/api/chat — no key, no /v1.
    url = `${base}/api/chat`
    body = {
      model: s.model,
      stream: false,
      messages: [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))],
      options: { temperature, num_ctx: 8192 }
    }
  } else {
    // OpenAI-compatible: openai / openrouter / groq / custom
    url = `${base}/chat/completions`
    if (s.apiKey) headers['Authorization'] = `Bearer ${s.apiKey}`
    if (s.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://nova-engine.local'
      headers['X-Title'] = 'Nova Engine'
    }
    body = { model: s.model, temperature, max_tokens: 8192, messages: [{ role: 'system', content: system }, ...messages] }
  }

  const res = await transport(url, headers, JSON.stringify(body), timeoutMs)
  if (!res.ok) throw new AIError('http', friendlyHttp(res.status, res.text, s.provider), res.status)

  let j: any
  try { j = JSON.parse(res.text) } catch {
    throw new AIError('parse', `Bad response from ${PROVIDER_INFO[s.provider].label}: "${res.text.slice(0, 160)}"`)
  }
  const detail = j?.error?.message || j?.error || j?.message
  if (j && typeof detail === 'string' && res.text.length < 4000 && !j.choices && !j.content && !j.candidates && !j.message?.content)
    throw new AIError('http', friendlyHttp(res.status, detail, s.provider), res.status)

  if (s.provider === 'anthropic') return (j.content || []).map((c: any) => c.text || '').join('')
  if (s.provider === 'gemini') return (j.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('')
  if (s.provider === 'ollama') {
    if (j.error) throw new AIError('http', `Ollama: ${String(j.error)}`, 500)
    if (!j.message?.content) throw new AIError('parse', 'Ollama returned no message content — is the model pulled? ("ollama pull ' + s.model + '")')
    return j.message.content
  }
  return j.choices?.[0]?.message?.content ?? ''
}

/* ---------- Test Connection (used by AI Settings modal) ---------- */

export async function testConnection(s: AISettings, timeoutMs = TEST_TIMEOUT): Promise<string> {
  const reply = await chatComplete(s, 'You are a connection test echo. Reply with exactly "NOVA OK" and nothing else.',
    [{ role: 'user', content: 'ping' }], 0, { timeoutMs, retries: 0 })
  return reply.trim().slice(0, 100) || '(empty reply)'
}
