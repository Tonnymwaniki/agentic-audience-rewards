import { NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'

export async function GET() {
  try {
    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    const { data: posts, error } = await supabase
      .from('posts')
      .select('external_post_id')
      .eq('creator_id', creatorId)

    if (error) {
      console.error('Analyzed videos fetch error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
      return NextResponse.json({ error: 'Failed to fetch analyzed videos' }, { status: 500 })
    }

    return NextResponse.json({ videoIds: (posts || []).map(p => p.external_post_id) })
  } catch (err) {
    console.error('Analyzed videos error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
