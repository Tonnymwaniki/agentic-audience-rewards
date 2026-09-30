import { NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { createServiceClient } from '@/lib/supabase/service'
import { getChannelVerificationSummary, UNKNOWN_CHANNEL_ID } from '@/lib/channel-verification'
import { logError } from '@/lib/logger'

/**
 * Every channel this creator has ever analyzed — their own verified channel(s)
 * plus every "paste any channel URL" research target — for client components that
 * need to let the creator pick one, like the Research chat scope selector.
 */
export async function GET() {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { creatorId } = authResult.auth

    // Service client: the summary reads youtube_oauth_tokens (RLS-only, no
    // policies), same reasoning as My Videos' own use of this function.
    const summary = await getChannelVerificationSummary(createServiceClient(), creatorId)

    return NextResponse.json({
      channels: summary
        .filter(c => c.channelId !== UNKNOWN_CHANNEL_ID)
        .map(c => ({
          channelId: c.channelId,
          title: c.title,
          postCount: c.postCount,
          verified: c.verified,
        })),
    })
  } catch (err) {
    logError('api/creator/channels', err, { stage: 'request' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
