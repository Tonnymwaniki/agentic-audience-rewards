import { getValidAccessToken } from '@/lib/youtube-oauth'
import { logError, logWarn } from '@/lib/logger'

/**
 * YouTube Analytics for a creator's VERIFIED channel: aggregate audience
 * demographics, top countries, watch time and traffic sources.
 *
 * Everything here is aggregate and non-identifying by construction — the
 * Analytics API reports percentages and totals, never individual viewers, and
 * YouTube itself withholds demographic breakdowns until a channel has enough
 * viewers for them to stay anonymous. That withholding is a normal state, not an
 * error: a small channel gets empty demographics with HTTP 200, and the UI says
 * so plainly rather than showing a broken chart.
 *
 * Scope: the consent flow now requests yt-analytics.readonly. Measured against
 * Google on 2026-09-26, youtube.readonly ALSO authorizes these (non-revenue)
 * reports, so grants made before the scope was added keep working. That is why
 * re-consent is triggered only by Google actually refusing a call for scope —
 * never by reading the stored scope string, which would hide data that works.
 */

const REPORTS_ENDPOINT = 'https://youtubeanalytics.googleapis.com/v2/reports'

export type DateRange = { startDate: string; endDate: string }

/** The last `days` days ending today, as the YYYY-MM-DD strings the API expects. */
export function lastDays(days: number, now = new Date()): DateRange {
  const end = new Date(now)
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) }
}

export type AgeGroupShare = { ageGroup: string; label: string; percent: number }
export type GenderShare = { gender: string; label: string; percent: number }
export type CountryShare = { code: string; name: string; views: number; share: number }
export type TrafficSourceShare = { type: string; label: string; views: number; share: number }

export type ChannelAnalytics = {
  channelId: string
  range: DateRange
  totals: {
    views: number
    minutesWatched: number
    averageViewDurationSeconds: number
    averageViewPercentage: number | null
  }
  /** null when YouTube withheld demographics (too few viewers to stay anonymous). */
  demographics: { ageGroups: AgeGroupShare[]; genders: GenderShare[] } | null
  countries: CountryShare[]
  trafficSources: TrafficSourceShare[]
}

// --- Errors ------------------------------------------------------------------

export type AnalyticsFailure =
  /** Google refused the call for scope: the grant must be re-consented. */
  | 'reconsent_required'
  /** The grant itself is gone or unusable (revoked, expired with no refresh, 401). */
  | 'reconnect_required'
  /** The YouTube Analytics API is not enabled on the Google Cloud project. */
  | 'api_disabled'
  /** Google refused because this account cannot read this channel's analytics. */
  | 'forbidden'
  | 'no_grant'
  | 'failed'

export class YouTubeAnalyticsError extends Error {
  readonly kind: AnalyticsFailure
  readonly status: number
  readonly googleReason: string | null

  constructor(kind: AnalyticsFailure, status: number, googleReason: string | null, message: string) {
    super(message)
    this.name = 'YouTubeAnalyticsError'
    this.kind = kind
    this.status = status
    this.googleReason = googleReason
  }
}

type GoogleErrorBody = {
  error?: {
    code?: number
    status?: string
    message?: string
    errors?: Array<{ reason?: string; domain?: string }>
    details?: Array<{ '@type'?: string; reason?: string }>
  }
}

/**
 * Maps Google's error response to what the creator should be told.
 *
 * Google reports the same condition in two formats: the legacy `errors[].reason`
 * list and the newer `details[].reason` (google.rpc.ErrorInfo), so both are read.
 * Insufficient scope is `ACCESS_TOKEN_SCOPE_INSUFFICIENT` / `insufficientPermissions`
 * (HTTP 403); a disabled API is `SERVICE_DISABLED` / `accessNotConfigured` (also
 * 403, so the status alone cannot tell them apart — and they need opposite fixes:
 * one is the creator's, the other is ours).
 */
export function classifyAnalyticsError(status: number, body: GoogleErrorBody | null): { kind: AnalyticsFailure; reason: string | null } {
  const reasons = [
    ...(body?.error?.errors ?? []).map(e => e.reason),
    ...(body?.error?.details ?? []).map(d => d.reason),
  ].filter((r): r is string => Boolean(r))
  const message = body?.error?.message ?? ''
  const has = (...want: string[]) => reasons.find(r => want.includes(r)) ?? null

  const scope = has('ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions')
  if (scope || /insufficient authentication scopes/i.test(message)) {
    return { kind: 'reconsent_required', reason: scope ?? 'insufficient_scopes' }
  }
  const disabled = has('SERVICE_DISABLED', 'accessNotConfigured')
  if (disabled) return { kind: 'api_disabled', reason: disabled }
  if (status === 401) return { kind: 'reconnect_required', reason: has('authError', 'ACCESS_TOKEN_EXPIRED', 'CREDENTIALS_MISSING') ?? 'unauthenticated' }
  if (status === 403) return { kind: 'forbidden', reason: reasons[0] ?? body?.error?.status ?? 'forbidden' }
  return { kind: 'failed', reason: reasons[0] ?? body?.error?.status ?? null }
}

// --- Parsing -----------------------------------------------------------------

type ReportResponse = {
  columnHeaders?: Array<{ name: string }>
  rows?: Array<Array<string | number>>
}

/** Turns the API's column/row arrays into objects keyed by column name. */
export function reportRows(report: ReportResponse): Array<Record<string, string | number>> {
  const names = (report.columnHeaders ?? []).map(h => h.name)
  return (report.rows ?? []).map(row => Object.fromEntries(names.map((name, i) => [name, row[i]])))
}

const AGE_LABELS: Record<string, string> = {
  'age13-17': '13–17',
  'age18-24': '18–24',
  'age25-34': '25–34',
  'age35-44': '35–44',
  'age45-54': '45–54',
  'age55-64': '55–64',
  'age65-': '65+',
}
const AGE_ORDER = Object.keys(AGE_LABELS)

const GENDER_LABELS: Record<string, string> = {
  female: 'Women',
  male: 'Men',
  user_specified: 'Self-described',
}

const TRAFFIC_LABELS: Record<string, string> = {
  YT_SEARCH: 'YouTube search',
  SUGGESTED_VIDEO: 'Suggested videos',
  RELATED_VIDEO: 'Suggested videos',
  BROWSE: 'Browse features (Home)',
  SUBSCRIBER: 'Subscriptions feed',
  NOTIFICATION: 'Notifications',
  EXT_URL: 'External websites & apps',
  NO_LINK_OTHER: 'Direct or unknown',
  NO_LINK_EMBEDDED: 'Embedded players',
  PLAYLIST: 'Playlists',
  YT_PLAYLIST_PAGE: 'Playlist pages',
  YT_CHANNEL: 'Your channel pages',
  YT_OTHER_PAGE: 'Other YouTube pages',
  END_SCREEN: 'End screens',
  ANNOTATION: 'Cards & annotations',
  CAMPAIGN_CARD: 'Campaign cards',
  SHORTS: 'Shorts feed',
  SHORTS_CONTENT_LINKS: 'Shorts content links',
  HASHTAGS: 'Hashtag pages',
  SOUND_PAGE: 'Sound pages',
  VIDEO_REMIXES: 'Remixes',
  LIVE_REDIRECT: 'Live redirects',
  ADVERTISING: 'Advertising',
  PRODUCT_PAGE: 'Product pages',
  IMMERSIVE_LIVE: 'Immersive live',
}

function titleCase(code: string): string {
  return code.toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)

/**
 * Structures the four raw reports. Pure, so it is tested against recorded
 * responses without calling Google.
 */
export function buildChannelAnalytics(
  channelId: string,
  range: DateRange,
  raw: { totals: ReportResponse; demographics: ReportResponse; countries: ReportResponse; traffic: ReportResponse }
): ChannelAnalytics {
  const t = reportRows(raw.totals)[0] ?? {}

  // viewerPercentage rows are (ageGroup, gender) cells summing to ~100; the age
  // and gender splits are the marginal sums of that grid.
  const demoRows = reportRows(raw.demographics)
  let demographics: ChannelAnalytics['demographics'] = null
  if (demoRows.length > 0) {
    const byAge = new Map<string, number>()
    const byGender = new Map<string, number>()
    for (const row of demoRows) {
      const pct = num(row.viewerPercentage)
      byAge.set(String(row.ageGroup), (byAge.get(String(row.ageGroup)) ?? 0) + pct)
      byGender.set(String(row.gender), (byGender.get(String(row.gender)) ?? 0) + pct)
    }
    demographics = {
      ageGroups: [...byAge.entries()]
        .map(([ageGroup, percent]) => ({ ageGroup, label: AGE_LABELS[ageGroup] ?? ageGroup, percent: round1(percent) }))
        .sort((a, b) => AGE_ORDER.indexOf(a.ageGroup) - AGE_ORDER.indexOf(b.ageGroup)),
      genders: [...byGender.entries()]
        .map(([gender, percent]) => ({ gender, label: GENDER_LABELS[gender] ?? titleCase(gender), percent: round1(percent) }))
        .sort((a, b) => b.percent - a.percent),
    }
  }

  const countryRows = reportRows(raw.countries)
  const countryTotal = countryRows.reduce((s, r) => s + num(r.views), 0)
  const trafficRows = reportRows(raw.traffic)
  const trafficTotal = trafficRows.reduce((s, r) => s + num(r.views), 0)

  return {
    channelId,
    range,
    totals: {
      views: num(t.views),
      minutesWatched: num(t.estimatedMinutesWatched),
      averageViewDurationSeconds: num(t.averageViewDuration),
      averageViewPercentage: t.averageViewPercentage === undefined ? null : round1(num(t.averageViewPercentage)),
    },
    demographics,
    countries: countryRows.map(r => ({
      code: String(r.country),
      name: countryName(String(r.country)),
      views: num(r.views),
      share: countryTotal > 0 ? round1((num(r.views) / countryTotal) * 100) : 0,
    })),
    trafficSources: trafficRows.map(r => ({
      type: String(r.insightTrafficSourceType),
      label: TRAFFIC_LABELS[String(r.insightTrafficSourceType)] ?? titleCase(String(r.insightTrafficSourceType)),
      views: num(r.views),
      share: trafficTotal > 0 ? round1((num(r.views) / trafficTotal) * 100) : 0,
    })),
  }
}

/**
 * One plain-language sentence from whatever YouTube released, e.g.
 * "62% of your viewers are 25–34, mostly from Kenya." Returns null when there is
 * nothing it can say truthfully.
 */
export function audienceHeadline(a: ChannelAnalytics): string | null {
  const topAge = a.demographics?.ageGroups.reduce<AgeGroupShare | null>((best, g) => (!best || g.percent > best.percent ? g : best), null) ?? null
  const topCountry = a.countries[0] ?? null
  // "mostly from" only when it is actually most of them.
  const where = topCountry
    ? topCountry.share >= 50
      ? `mostly from ${topCountry.name}`
      : `with ${topCountry.name} the top country (${Math.round(topCountry.share)}% of views)`
    : null

  if (topAge) return `${Math.round(topAge.percent)}% of your viewers are ${topAge.label}${where ? `, ${where}` : ''}.`
  if (where && topCountry) return topCountry.share >= 50 ? `Most of your views come from ${topCountry.name}.` : `${topCountry.name} is your top country (${Math.round(topCountry.share)}% of views).`
  return null
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// --- Google call -------------------------------------------------------------

async function queryReport(accessToken: string, channelId: string, range: DateRange, params: Record<string, string>): Promise<ReportResponse> {
  const url = new URL(REPORTS_ENDPOINT)
  // The specific verified channel rather than channel==MINE, so a token can
  // never quietly report on a different channel than the one it was verified for.
  url.searchParams.set('ids', `channel==${channelId}`)
  url.searchParams.set('startDate', range.startDate)
  url.searchParams.set('endDate', range.endDate)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' })
  const body = (await response.json().catch(() => null)) as (ReportResponse & GoogleErrorBody) | null
  if (!response.ok) {
    const { kind, reason } = classifyAnalyticsError(response.status, body)
    throw new YouTubeAnalyticsError(kind, response.status, reason, body?.error?.message ?? `Analytics API returned ${response.status}`)
  }
  return body ?? {}
}

/**
 * Calls reports.query four times for one channel and structures the result.
 * Throws YouTubeAnalyticsError, classified from Google's response. Takes an
 * access token as given: callers should obtain it from getValidAccessToken
 * (loadChannelAnalytics below does).
 */
export async function fetchChannelAnalytics(accessToken: string, channelId: string, dateRange: DateRange): Promise<ChannelAnalytics> {
  const [totals, demographics, countries, traffic] = await Promise.all([
    queryReport(accessToken, channelId, dateRange, {
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage',
    }),
    queryReport(accessToken, channelId, dateRange, {
      dimensions: 'ageGroup,gender',
      metrics: 'viewerPercentage',
      sort: 'gender,ageGroup',
    }),
    queryReport(accessToken, channelId, dateRange, {
      dimensions: 'country',
      metrics: 'views,estimatedMinutesWatched',
      sort: '-views',
      maxResults: '5',
    }),
    queryReport(accessToken, channelId, dateRange, {
      dimensions: 'insightTrafficSourceType',
      metrics: 'views,estimatedMinutesWatched',
      sort: '-views',
      maxResults: '6',
    }),
  ])
  return buildChannelAnalytics(channelId, dateRange, { totals, demographics, countries, traffic })
}

// --- Loader for pages ----------------------------------------------------------

export type AnalyticsResult =
  | { ok: true; data: ChannelAnalytics }
  | { ok: false; reason: AnalyticsFailure }

// Analytics move daily, and each page view would otherwise spend four API calls.
const CACHE_TTL_MS = 30 * 60 * 1000
const cache = new Map<string, { at: number; data: ChannelAnalytics }>()

/**
 * Fresh token → four reports → structured result, with every failure turned into
 * a reason the UI can explain. Never throws.
 *
 * `supabase` must be a service-role client (youtube_oauth_tokens is service-only),
 * and creatorId must come from the session — the grant lookup is keyed by it.
 */
export async function loadChannelAnalytics(
  supabase: { from: (table: string) => any },
  creatorId: string,
  channelId: string,
  dateRange: DateRange
): Promise<AnalyticsResult> {
  const key = `${creatorId}:${channelId}:${dateRange.startDate}:${dateRange.endDate}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ok: true, data: hit.data }

  const token = await getValidAccessToken(supabase, creatorId, channelId)
  if (!token.ok) {
    if (token.reason === 'no_grant') return { ok: false, reason: 'no_grant' }
    if (token.reason === 'revoked' || token.reason === 'no_refresh_token') return { ok: false, reason: 'reconnect_required' }
    logWarn('youtubeAnalytics.load', 'Could not obtain an access token', { creator_id: creatorId, channel_id: channelId, reason: token.reason })
    return { ok: false, reason: 'failed' }
  }

  try {
    const data = await fetchChannelAnalytics(token.accessToken, channelId, dateRange)
    cache.set(key, { at: Date.now(), data })
    return { ok: true, data }
  } catch (err) {
    if (err instanceof YouTubeAnalyticsError) {
      const meta = { creator_id: creatorId, channel_id: channelId, status: err.status, google_reason: err.googleReason, kind: err.kind }
      // A disabled API or an unexplained failure is OUR problem, so it is an error
      // in the logs; a creator-side grant problem is expected and only a warning.
      if (err.kind === 'api_disabled' || err.kind === 'failed') logError('youtubeAnalytics.load', err, meta)
      else logWarn('youtubeAnalytics.load', 'Analytics call refused', meta)
      return { ok: false, reason: err.kind }
    }
    logError('youtubeAnalytics.load', err, { creator_id: creatorId, channel_id: channelId })
    return { ok: false, reason: 'failed' }
  }
}
