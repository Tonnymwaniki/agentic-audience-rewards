import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())
import { createServiceClient } from '../lib/supabase/service'
import { computeLevel } from '../lib/levels'
async function main() {
  const s = createServiceClient()
  const counts = new Map<string, number>()
  for (let from = 0; ; from += 1000) {
    const { data } = await s.from('reward_events').select('audience_member_id').order('id').range(from, from + 999)
    for (const r of data ?? []) if (r.audience_member_id) counts.set(r.audience_member_id, (counts.get(r.audience_member_id) ?? 0) + 1)
    if (!data || data.length < 1000) break
  }
  const twicePlus = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])
  console.log(`people recognized 2+ times in real data: ${twicePlus.length}`)
  console.log('(these are exactly the ones the lowered threshold promotes)\n')
  for (const [id, n] of twicePlus) {
    const { data: m } = await s.from('audience_members').select('display_name, level, segment').eq('id', id).maybeSingle()
    const { data: cm } = await s.from('comments').select('post_id').eq('audience_member_id', id)
    const videos = new Set((cm ?? []).map(c => c.post_id))
    const expected = computeLevel({ totalComments: (cm ?? []).length, distinctPosts: videos.size, recognitionCount: n })
    console.log(`  ${String(m?.display_name).slice(0, 26).padEnd(26)} recognized ${n}x, ${(cm ?? []).length} comment(s)/${videos.size} video(s)`)
    console.log(`      expected=${expected.padEnd(10)} stored=${String(m?.level).padEnd(10)} ${m?.level === expected ? 'MATCH' : 'awaiting backfill'}   segment=${m?.segment ?? 'null'}`)
  }
}
main()
