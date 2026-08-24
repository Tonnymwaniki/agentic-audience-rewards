import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { categorizeComments } from '@/lib/categorize'

export async function POST(request: NextRequest) {
  try {
    const { post_id } = await request.json()

    if (!post_id) {
      return NextResponse.json(
        { error: 'Missing post_id' },
        { status: 400 }
      )
    }

    const cookieStore = await cookies()

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll() {},
        },
      }
    )

    const { data: comments, error: commentsError } = await supabase
      .from('comments')
      .select('id, text')
      .eq('post_id', post_id)

    if (commentsError) {
      console.error('Fetch comments error:', JSON.stringify(commentsError, null, 2))
      return NextResponse.json(
        { error: 'Failed to fetch comments' },
        { status: 500 }
      )
    }

    if (!comments || comments.length === 0) {
      return NextResponse.json({ success: true, categorized: 0 })
    }

    const { data: existingCategories, error: categoriesError } = await supabase
      .from('comment_categories')
      .select('comment_id')

    if (categoriesError) {
      console.error('Fetch categories error:', JSON.stringify(categoriesError, null, 2))
      return NextResponse.json(
        { error: 'Failed to fetch existing categories' },
        { status: 500 }
      )
    }

    const categorizedIds = new Set(
      existingCategories?.map(c => c.comment_id) || []
    )
    const uncategorized = comments.filter(c => !categorizedIds.has(c.id))

    if (uncategorized.length === 0) {
      return NextResponse.json({ success: true, categorized: 0 })
    }

    const categorized = await categorizeComments(uncategorized)

    if (categorized.length === 0) {
      return NextResponse.json({ success: true, categorized: 0 })
    }

    const upsertData = categorized.map(c => ({
      comment_id: c.id,
      category: c.category,
      topic: c.topic,
      confidence: c.confidence,
    }))

    const { error: upsertError } = await supabase
      .from('comment_categories')
      .upsert(upsertData, { onConflict: 'comment_id' })

    if (upsertError) {
      console.error('Upsert categories error:', JSON.stringify(upsertError, null, 2))
      return NextResponse.json(
        { error: 'Failed to upsert categories' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      categorized: categorized.length,
    })
  } catch (err) {
    console.error('Categorize error:', JSON.stringify(err, null, 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
