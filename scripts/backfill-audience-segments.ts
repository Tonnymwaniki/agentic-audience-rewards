/**
 * Computes and stores the segment for every audience member.
 *
 * Pure arithmetic over comments already stored — no model calls, so this is fast and
 * free, and re-running it is the cheapest way to refresh segments in bulk after new
 * comments arrive. Day to day it isn't needed: lib/audience-memory.ts recomputes a
 * person's segment whenever their profile is refreshed.
 *
 * Writes ONLY audience_members.segment.
 *
 * Requires migration 20240101000028_audience_segments.sql.
 *
 * Run:
 *   npx tsx scripts/backfill-audience-segments.ts             # compute and write
 *   npx tsx scripts/backfill-audience-segments.ts --dry-run   # report only
 */

import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { createServiceClient } from '../lib/supabase/service'
import { computeSegment, signalsFromComments, SEGMENTS, type AudienceSegment } from '../lib/segments'

const dryRun = process.argv.includes('--dry-run')

async function main() {
  const supabase = createServiceClient()

  if (!dryRun) {
    const probe = await supabase.from('audience_members').select('segment').limit(1)
    if (probe.error) {
      console.error(`audience_members.segment is not available (${probe.error.code}: ${probe.error.message}).`)
      console.error('Run supabase/migrations/20240101000028_audience_segments.sql in the Supabase SQL editor first.')
      process.exit(1)
    }
  }

  // Every comment with its category, in pages: one pass, grouped in memory, so a
  // channel with thousands of members costs a handful of queries rather than one
  // per person.
  const comments: Array<{ audience_member_id: string | null; post_id: string; comment_categories: { category: string | null; sentiment?: string | null } | null }> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('comments')
      .select('audience_member_id, post_id, comment_categories ( category, sentiment )')
      .order('id')
      .range(from, from + 999)
    if (error) throw new Error(`Could not load comments: ${error.message}`)
    comments.push(...((data ?? []) as unknown as typeof comments))
    if (!data || data.length < 1000) break
  }

  const byMember = new Map<string, typeof comments>()
  for (const c of comments) {
    if (!c.audience_member_id) continue
    byMember.set(c.audience_member_id, [...(byMember.get(c.audience_member_id) ?? []), c])
  }

  const tally: Record<string, number> = Object.fromEntries(SEGMENTS.map(s => [s, 0]))
  let written = 0
  const updates: Array<{ id: string; segment: AudienceSegment }> = []
  for (const [memberId, memberComments] of byMember) {
    const segment = computeSegment(signalsFromComments(memberComments))
    tally[segment]++
    updates.push({ id: memberId, segment })
  }

  console.log(`${byMember.size} members have comments; segment mix: ${JSON.stringify(tally)}`)
  if (dryRun) {
    console.log('DRY RUN — nothing written.')
    return
  }

  for (const { id, segment } of updates) {
    const { error } = await supabase.from('audience_members').update({ segment }).eq('id', id)
    if (error) throw new Error(`Update failed for ${id}: ${error.message}`)
    written++
    if (written % 200 === 0) process.stdout.write(`\r  written ${written}/${updates.length}`)
  }
  console.log(`\nWrote ${written} segments.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
