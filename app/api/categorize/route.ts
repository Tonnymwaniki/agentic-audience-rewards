import { NextRequest, NextResponse } from 'next/server'
import { categorizePost } from '@/lib/categorize'

export async function POST(request: NextRequest) {
  try {
    const { post_id } = await request.json()

    if (!post_id) {
      return NextResponse.json(
        { error: 'Missing post_id' },
        { status: 400 }
      )
    }

    const result = await categorizePost(post_id)

    return NextResponse.json(result)
  } catch (err) {
    console.error('Categorize error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
