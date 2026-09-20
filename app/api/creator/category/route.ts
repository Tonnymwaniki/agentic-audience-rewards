import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/api-auth'
import { isBusinessCategory } from '@/lib/business-categories'

export async function POST(request: NextRequest) {
  try {
    const { business_category } = await request.json()

    // Validated against the known list rather than stored as free text, so the
    // field stays groupable when benchmarking is eventually built on top of it.
    if (!isBusinessCategory(business_category)) {
      return NextResponse.json({ error: 'Invalid business_category' }, { status: 400 })
    }

    const authResult = await requireCreator()
    if (!authResult.ok) return authResult.response
    const { supabase, creatorId } = authResult.auth

    // .select() so the response proves a row was actually written. Without it a
    // zero-row update is indistinguishable from a successful one.
    const { data: updated, error: updateError } = await supabase
      .from('creators')
      .update({ business_category })
      .eq('id', creatorId)
      .select('id')

    if (!updateError && (updated?.length ?? 0) === 0) {
      console.error('Update business_category wrote no rows for creator', creatorId)
      return NextResponse.json({ error: 'Failed to save category' }, { status: 500 })
    }

    if (updateError) {
      console.error('Update business_category error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
      return NextResponse.json({ error: 'Failed to save category' }, { status: 500 })
    }

    return NextResponse.json({ success: true, business_category })
  } catch (err) {
    console.error('Save business_category error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
