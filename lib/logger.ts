/**
 * Structured logging.
 *
 * Primarily server-side, but the module is pure — it touches nothing but
 * `console` and `Date` — so the handful of client components that report a failed
 * fetch import it too and emit the identical shape in the browser console. The
 * server/browser split lives entirely in `forwardToMonitoring` below, which is
 * where a Node SDK and a browser SDK would differ.
 *
 * Every log line is a single line of JSON on stdout/stderr. That is the format
 * Vercel, Datadog, Sentry and every other collector can ingest without a custom
 * parser, and it is the reason this exists: the 177 hand-rolled `console.error`
 * calls this replaces each invented their own shape, so nothing could be searched
 * by route, by creator, or by error code.
 *
 * Deliberately single-line JSON in development too. A prettier local format would
 * mean the thing you debug against is not the thing production emits, which is
 * exactly how format bugs survive to production.
 *
 * NOT an external service. `forwardToMonitoring` below is the single seam where
 * Sentry (or anything else) gets wired in later; nothing else in the app needs to
 * change when that happens.
 */

export type LogLevel = 'error' | 'warn' | 'info'

/** Free-form structured fields. Keep them flat and serialisable. */
export type LogMetadata = Record<string, unknown>

/**
 * Keys whose values never belong in a log line, matched case-insensitively as a
 * substring. Logs travel further than the data they describe — into third-party
 * collectors and retained archives — so a bearer token in a stack trace is a
 * durable leak. `claim_token` in particular is directly redeemable for a reward.
 */
const REDACTED_KEY_PATTERNS = [
  'claim_token',
  'claimtoken',
  'password',
  'secret',
  'api_key',
  'apikey',
  'authorization',
  'private_key',
  'privatekey',
  'service_role',
  'access_token',
  'refresh_token',
  'cookie',
]

const REDACTED = '[redacted]'

function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase()
  return REDACTED_KEY_PATTERNS.some(pattern => lower.includes(pattern))
}

/**
 * Deep-copies a value for logging: redacts sensitive keys, drops functions, caps
 * runaway strings and arrays, and survives circular references.
 *
 * A logger that throws is worse than no logger — it turns a handled error into an
 * unhandled one — so this never throws on odd input.
 */
function sanitize(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value instanceof Date) return value.toISOString()

  if (depth > 6) return '[max depth]'

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[circular]'
    seen.add(value as object)

    if (Array.isArray(value)) {
      const capped = value.length > 50 ? value.slice(0, 50) : value
      const items: unknown[] = capped.map(item => sanitize(item, seen, depth + 1))
      if (value.length > 50) items.push(`…${value.length - 50} more`)
      return items
    }

    const out: Record<string, unknown> = {}
    // Own property names, not just enumerable keys: Error and Supabase's
    // PostgrestError both carry their useful fields non-enumerably, which is why
    // a plain JSON.stringify of them produces "{}".
    for (const key of Object.getOwnPropertyNames(value)) {
      if (isRedactedKey(key)) {
        out[key] = REDACTED
        continue
      }
      const sanitized = sanitize((value as Record<string, unknown>)[key], seen, depth + 1)
      if (sanitized !== undefined) out[key] = sanitized
    }
    return out
  }

  return String(value)
}

type NormalizedError = {
  message: string
  name?: string
  stack?: string
  /** Supabase/Postgres error code, e.g. "PGRST204", "23505". */
  code?: string
  details?: unknown
  hint?: unknown
}

/**
 * Turns anything throwable into consistent fields.
 *
 * Three shapes actually occur in this codebase and none is a subclass of another:
 * a real `Error`, a Supabase `PostgrestError` (a plain object with
 * message/code/details/hint and no prototype chain to Error), and a bare string.
 * Treating them uniformly is most of the value of this module — `error.code` is
 * how a PGRST204 gets found later, and it was being stringified away before.
 */
export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string; details?: unknown; hint?: unknown }
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
      ...(withCode.code ? { code: String(withCode.code) } : {}),
      ...(withCode.details !== undefined ? { details: sanitize(withCode.details) } : {}),
      ...(withCode.hint !== undefined ? { hint: sanitize(withCode.hint) } : {}),
    }
  }

  if (typeof error === 'string') return { message: error }

  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>
    return {
      message: typeof obj.message === 'string' ? obj.message : JSON.stringify(sanitize(obj)),
      ...(typeof obj.name === 'string' ? { name: obj.name } : {}),
      ...(typeof obj.stack === 'string' ? { stack: obj.stack } : {}),
      ...(obj.code !== undefined ? { code: String(obj.code) } : {}),
      ...(obj.details !== undefined ? { details: sanitize(obj.details) } : {}),
      ...(obj.hint !== undefined ? { hint: sanitize(obj.hint) } : {}),
    }
  }

  return { message: String(error) }
}

export type LogEntry = {
  timestamp: string
  level: LogLevel
  /** Route or operation, e.g. "api/reward/mint" or "rewards.evaluate". */
  context: string
  message: string
  error?: NormalizedError
  metadata?: LogMetadata
}

/**
 * The one seam for an external monitoring service.
 *
 * Wiring Sentry later means calling its capture here and nothing else: every
 * call site already passes a context, a normalized error and metadata, which is
 * precisely what a Sentry event wants. Kept synchronous and non-throwing so a
 * monitoring outage can never take a request down with it.
 */
function forwardToMonitoring(entry: LogEntry): void {
  void entry
  // Intentionally empty. Example of what goes here:
  //   Sentry.captureException(entry.error, { tags: { context: entry.context }, extra: entry.metadata })
}

function emit(entry: LogEntry): void {
  let line: string
  try {
    line = JSON.stringify(entry)
  } catch {
    // Last resort: never let logging throw.
    line = JSON.stringify({
      timestamp: entry.timestamp,
      level: entry.level,
      context: entry.context,
      message: entry.message,
      serialization_failed: true,
    })
  }

  if (entry.level === 'error') console.error(line)
  else if (entry.level === 'warn') console.warn(line)
  else console.log(line)

  try {
    forwardToMonitoring(entry)
  } catch {
    // A broken monitoring hook must not break the request.
  }
}

function build(
  level: LogLevel,
  context: string,
  message: string,
  error: unknown,
  metadata?: LogMetadata
): LogEntry {
  const normalized = error === undefined ? undefined : normalizeError(error)
  const cleanMetadata =
    metadata && Object.keys(metadata).length > 0
      ? (sanitize(metadata) as LogMetadata)
      : undefined

  return {
    timestamp: new Date().toISOString(),
    level,
    context,
    // A caller who passes only an error still gets a useful message line.
    message: message || normalized?.message || 'Unspecified error',
    ...(normalized ? { error: normalized } : {}),
    ...(cleanMetadata ? { metadata: cleanMetadata } : {}),
  }
}

/**
 * Logs a handled failure.
 *
 * `context` should name the route or operation and stay stable, because it is the
 * field you will group and alert on: "api/reward/mint", not "Mint failed at 3pm".
 * Put identifiers (creator_id, post_id, member_id) in `metadata` rather than in
 * the message, so they stay queryable instead of being baked into prose.
 */
export function logError(context: string, error: unknown, metadata?: LogMetadata): void {
  emit(build('error', context, '', error, metadata))
}

/** Same shape, for a recoverable condition that is not a failure. */
export function logWarn(context: string, message: string, metadata?: LogMetadata): void {
  emit(build('warn', context, message, undefined, metadata))
}

/** Notable lifecycle events worth keeping — a mint sent, an analysis finished. */
export function logInfo(context: string, message: string, metadata?: LogMetadata): void {
  emit(build('info', context, message, undefined, metadata))
}
