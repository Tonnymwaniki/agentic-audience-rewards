import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { loadCustomProfileFields, customFieldsToContext } from '@/lib/custom-profile-fields'
import {
  generateDraftReply,
  loadStyleExamples,
  BUSINESS_PROFILE_COLUMNS,
  type BusinessProfile,
} from '@/lib/categorize'
import { requireCreator } from '@/lib/api-auth'
import { logError, logInfo } from '@/lib/logger'
import { checkPostVerification, VERIFY_OWNERSHIP_MESSAGE, VERIFY_OWNERSHIP_PATH } from '@/lib/channel-verification'

export async function POST(request: NextRequest) {
  try {
    // Generates a reply with a paid Anthropic call. The comment id names the row,
    // so ownership is checked through the comment's post below.
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response

    const { comment_id } = await request.json()

    if (!comment_id) {
      return NextResponse.json(
        { error: 'Missing comment_id' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    const { data: comment } = await supabase
      .from('comments')
      .select('text, post_id, comment_categories (category), posts (creator_id)')
      .eq('id', comment_id)
      .single()

    if (!comment) {
      return NextResponse.json(
        { error: 'Comment not found' },
        { status: 404 }
      )
    }

    const ownerId = (comment.posts as unknown as { creator_id: string } | null)?.creator_id

    // 404 rather than 403: a comment belonging to someone else should be
    // indistinguishable from one that does not exist.
    if (!ownerId || ownerId !== authResult.auth.creatorId) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    }

    // CAPABILITY GATE. Same rule as categorization-time drafting: a reply written
    // in the owner's voice requires proof of ownership. 403 with an actionable
    // message, not a silent empty draft, so the UI can offer the verify link.
    const verification = await checkPostVerification(
      authResult.auth.supabase,
      authResult.auth.creatorId,
      comment.post_id as string
    )
    if (!verification.verified) {
      logInfo('api/draft-reply', 'Refused: channel ownership not verified', {
        creator_id: authResult.auth.creatorId,
        comment_id,
        channel_id: verification.channelId,
        reason: verification.reason,
      })
      return NextResponse.json(
        { error: VERIFY_OWNERSHIP_MESSAGE, reason: verification.reason, verify_url: VERIFY_OWNERSHIP_PATH },
        { status: 403 }
      )
    }

    const category = (comment.comment_categories as unknown as { category: string } | null)?.category || 'purchase_intent'

    // Regenerated replies get the same business-profile grounding as the ones
    // drafted during categorization — otherwise hitting "Regenerate" would quietly
    // downgrade a reply containing real contact details into a generic one.
    const creatorId = ownerId
    let businessProfile: BusinessProfile | null = null

    if (creatorId) {
      const { data: creator, error: profileError } = await supabase
        .from('creators')
        .select(BUSINESS_PROFILE_COLUMNS)
        .eq('id', creatorId)
        .single()

      if (profileError) {
        logError('api/draft-reply', profileError, { creator_id: creatorId, stage: 'fetch_business_profile' })
      } else if (creator) {
        businessProfile = creator as unknown as BusinessProfile
      }
    }

    // Same reasoning as the profile above: without this, "Regenerate" would strip
    // the creator's learned voice back out of an otherwise calibrated reply.
    const styleExamples = creatorId ? await loadStyleExamples(supabase, creatorId) : []
    // And the same for the creator's own custom fields, so a single "Regenerate"
    // produces a reply with the same facts available as the batch path.
    const customFieldContext = creatorId
      ? customFieldsToContext(await loadCustomProfileFields(supabase, creatorId))
      : []

    const draft = await generateDraftReply(comment.text, category, businessProfile, styleExamples, customFieldContext)

    await supabase
      .from('comment_categories')
      .update({
        draft_reply: draft.text,
        draft_confidence: draft.confidence,
        draft_reply_created_at: new Date().toISOString(),
      })
      .eq('comment_id', comment_id)

    return NextResponse.json({ draft_reply: draft.text, draft_confidence: draft.confidence })
  } catch (err) {
    logError('api/draft-reply', err, { stage: 'request' })
    return NextResponse.json(
      { error: 'Failed to generate draft reply' },
      { status: 500 }
    )
  }
}
