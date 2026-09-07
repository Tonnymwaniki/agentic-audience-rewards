import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  generateDraftReply,
  loadStyleExamples,
  BUSINESS_PROFILE_COLUMNS,
  type BusinessProfile,
} from '@/lib/categorize'

export async function POST(request: NextRequest) {
  try {
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
      .select('text, comment_categories (category), posts (creator_id)')
      .eq('id', comment_id)
      .single()

    if (!comment) {
      return NextResponse.json(
        { error: 'Comment not found' },
        { status: 404 }
      )
    }

    const category = (comment.comment_categories as unknown as { category: string } | null)?.category || 'purchase_intent'

    // Regenerated replies get the same business-profile grounding as the ones
    // drafted during categorization — otherwise hitting "Regenerate" would quietly
    // downgrade a reply containing real contact details into a generic one.
    const creatorId = (comment.posts as unknown as { creator_id: string } | null)?.creator_id
    let businessProfile: BusinessProfile | null = null

    if (creatorId) {
      const { data: creator, error: profileError } = await supabase
        .from('creators')
        .select(BUSINESS_PROFILE_COLUMNS)
        .eq('id', creatorId)
        .single()

      if (profileError) {
        console.error('Fetch business profile error:', JSON.stringify(profileError, Object.getOwnPropertyNames(profileError), 2))
      } else if (creator) {
        businessProfile = creator as unknown as BusinessProfile
      }
    }

    // Same reasoning as the profile above: without this, "Regenerate" would strip
    // the creator's learned voice back out of an otherwise calibrated reply.
    const styleExamples = creatorId ? await loadStyleExamples(supabase, creatorId) : []

    const draftReply = await generateDraftReply(comment.text, category, businessProfile, styleExamples)

    await supabase
      .from('comment_categories')
      .update({ draft_reply: draftReply, draft_reply_created_at: new Date().toISOString() })
      .eq('comment_id', comment_id)

    return NextResponse.json({ draft_reply: draftReply })
  } catch (err) {
    console.error('Draft reply error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: 'Failed to generate draft reply' },
      { status: 500 }
    )
  }
}
