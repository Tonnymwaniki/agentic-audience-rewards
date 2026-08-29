import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export async function GET(request: NextRequest) {
  const postId = request.nextUrl.searchParams.get('post_id')

  if (!postId) {
    return NextResponse.json(
      { error: 'Missing post_id' },
      { status: 400 }
    )
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('posts')
    .select('analysis_status, analysis_stage, comments_total, comments_categorized, members_total, members_evaluated')
    .eq('id', postId)
    .single()

  if (error || !data) {
    return NextResponse.json(
      { error: 'Post not found' },
      { status: 404 }
    )
  }

  return NextResponse.json(data)
}
