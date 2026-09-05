import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import ResearchChat from './ResearchChat'

export const dynamic = 'force-dynamic'

const AMBIENT_FRAGMENT_COUNT = 18
const AMBIENT_FRAGMENT_MAX_LENGTH = 60

function truncateFragment(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length > AMBIENT_FRAGMENT_MAX_LENGTH
    ? `${trimmed.slice(0, AMBIENT_FRAGMENT_MAX_LENGTH).trim()}…`
    : trimmed
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export default async function ResearchPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: creator, error: creatorError } = await supabase
    .from('creators')
    .select('id')
    .eq('user_id', user.id)
    .single()

  if (creatorError || !creator) {
    redirect('/login')
  }

  // Ambient background text — a lightweight, capped-size sample (not the full
  // comment set) purely for decorative drifting fragments behind the chat.
  const { data: posts } = await supabase
    .from('posts')
    .select('id')
    .eq('creator_id', creator.id)

  const postIds = (posts || []).map(p => p.id)
  let ambientFragments: string[] = []

  if (postIds.length > 0) {
    const { data: sampleComments, error: sampleError } = await supabase
      .from('comments')
      .select('text')
      .in('post_id', postIds)
      .limit(200)

    if (sampleError) {
      console.error('Research ambient sample fetch error:', JSON.stringify(sampleError, Object.getOwnPropertyNames(sampleError), 2))
    } else {
      const pool = (sampleComments || [])
        .map(c => c.text)
        .filter(text => text && text.trim().length > 5)

      ambientFragments = shuffle(pool)
        .slice(0, AMBIENT_FRAGMENT_COUNT)
        .map(truncateFragment)
    }
  }

  return <ResearchChat creatorId={creator.id} ambientFragments={ambientFragments} />
}
