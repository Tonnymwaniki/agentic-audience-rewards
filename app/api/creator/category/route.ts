import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { isBusinessCategory } from '@/lib/business-categories'

export async function POST(request: NextRequest) {
  try {
    const { business_category } = await request.json()

    // Validated against the known list rather than stored as free text, so the
    // field stays groupable when benchmarking is eventually built on top of it.
    if (!isBusinessCategory(business_category)) {
      return NextResponse.json({ error: 'Invalid business_category' }, { status: 400 })
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

    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { data: creator, error: creatorError } = await supabase
      .from('creators')
      .select('id')
      .eq('user_id', user.id)
      .single()

    if (creatorError || !creator) {
      return NextResponse.json({ error: 'Creator not found' }, { status: 404 })
    }

    const { error: updateError } = await supabase
      .from('creators')
      .update({ business_category })
      .eq('id', creator.id)

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
