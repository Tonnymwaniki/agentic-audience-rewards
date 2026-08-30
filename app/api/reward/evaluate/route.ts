import { NextRequest, NextResponse } from 'next/server'
import { evaluateRewards } from '@/lib/rewards/evaluate'

export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const { creator_id, post_id } = await request.json()

    if (!creator_id) {
      return NextResponse.json(
        { error: 'Missing creator_id' },
        { status: 400 }
      )
    }

    const result = await evaluateRewards(creator_id, post_id)

    return NextResponse.json(result)
  } catch (err) {
    console.error('Reward evaluate error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
