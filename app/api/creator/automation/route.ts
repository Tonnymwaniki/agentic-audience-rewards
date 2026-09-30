import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { requiresPro } from '@/lib/entitlements'
import { normalizeConfidence } from '@/lib/confidence'
import { logError } from '@/lib/logger'

/** Kept in sync with migration 52's DEFAULT and the auto-reply cron's exclusion. */
const NEVER_AUTO_SEND_CATEGORIES = new Set(['complaint'])

/** The categories this platform actually drafts for — the allow-list a creator
 * can pick from is bounded to these, minus the ones automation can never touch. */
const DRAFTABLE_CATEGORIES = ['question', 'purchase_intent', 'complaint']
const SELECTABLE_AUTOMATION_CATEGORIES = DRAFTABLE_CATEGORIES.filter(c => !NEVER_AUTO_SEND_CATEGORIES.has(c))

const AUTOMATION_COLUMNS =
  'reply_automation_enabled, reply_automation_categories, reply_automation_min_confidence, reply_automation_max_per_run'

function isMissingColumnError(error: { code?: string; message?: string } | null) {
  return !!error && (error.code === 'PGRST204' || error.code === '42703')
}

/** Reads the creator's current auto-reply automation settings. */
export async function GET() {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const { data, error } = await supabase.from('creators').select(AUTOMATION_COLUMNS).eq('id', creatorId).maybeSingle()

    if (error) {
      if (isMissingColumnError(error)) {
        // Migration 52 hasn't run against this database yet — report automation
        // as off rather than erroring the whole settings panel.
        return NextResponse.json({
          enabled: false,
          categories: [],
          minConfidence: 'high',
          maxPerRun: 20,
          selectableCategories: SELECTABLE_AUTOMATION_CATEGORIES,
          migrated: false,
          proOnly: await requiresPro(supabase, creatorId),
        })
      }
      logError('api/creator/automation', error, { creator_id: creatorId, stage: 'fetch' })
      return NextResponse.json({ error: 'Failed to load automation settings' }, { status: 500 })
    }

    return NextResponse.json({
      enabled: !!data?.reply_automation_enabled,
      categories: (data?.reply_automation_categories as string[] | null) ?? [],
      minConfidence: (data?.reply_automation_min_confidence as string | null) ?? 'high',
      maxPerRun: (data?.reply_automation_max_per_run as number | null) ?? 20,
      selectableCategories: SELECTABLE_AUTOMATION_CATEGORIES,
      migrated: true,
      proOnly: await requiresPro(supabase, creatorId),
    })
  } catch (err) {
    logError('api/creator/automation', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

/**
 * Updates the creator's auto-reply automation settings. Pro-only: a Free
 * creator can never turn this on, since unattended sending isn't part of the
 * free trial (which is manual-approval-only, one video).
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const body = await request.json()
    const { enabled, categories, minConfidence, maxPerRun } = body ?? {}

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }

    if (enabled === true && (await requiresPro(supabase, creatorId))) {
      return NextResponse.json(
        { error: 'Auto-reply automation is a Pro feature. Upgrade to enable it.' },
        { status: 403 }
      )
    }

    const update: Record<string, unknown> = {}

    if (enabled !== undefined) update.reply_automation_enabled = enabled

    if (categories !== undefined) {
      if (
        !Array.isArray(categories) ||
        !categories.every(c => typeof c === 'string' && SELECTABLE_AUTOMATION_CATEGORIES.includes(c))
      ) {
        return NextResponse.json(
          { error: `categories must be a subset of ${SELECTABLE_AUTOMATION_CATEGORIES.join(', ')}` },
          { status: 400 }
        )
      }
      // 'complaint' is filtered out here too, belt-and-suspenders with the cron's
      // own hard-coded exclusion — this setting should never even be able to
      // store it, regardless of what the client sends.
      update.reply_automation_categories = categories.filter((c: string) => !NEVER_AUTO_SEND_CATEGORIES.has(c))
    }

    if (minConfidence !== undefined) {
      const normalized = normalizeConfidence(minConfidence)
      if (!normalized) {
        return NextResponse.json({ error: "minConfidence must be one of 'high', 'medium', 'low'" }, { status: 400 })
      }
      update.reply_automation_min_confidence = normalized
    }

    if (maxPerRun !== undefined) {
      if (typeof maxPerRun !== 'number' || !Number.isInteger(maxPerRun) || maxPerRun < 1 || maxPerRun > 200) {
        return NextResponse.json({ error: 'maxPerRun must be a whole number from 1 to 200' }, { status: 400 })
      }
      update.reply_automation_max_per_run = maxPerRun
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { error } = await supabase.from('creators').update(update).eq('id', creatorId)

    if (error) {
      if (isMissingColumnError(error)) {
        return NextResponse.json(
          { error: 'Automation settings are not available yet on this deployment — the pending migration needs to run.' },
          { status: 503 }
        )
      }
      logError('api/creator/automation', error, { creator_id: creatorId, stage: 'update' })
      return NextResponse.json({ error: 'Failed to update automation settings' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    logError('api/creator/automation', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
