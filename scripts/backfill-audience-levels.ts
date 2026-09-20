/**
 * Computes and stores the level for every audience member.
 *
 * Pure arithmetic over data already stored — no model calls, so this is fast and
 * free, and re-running it is the cheapest way to refresh levels in bulk after new
 * comments or recognitions arrive. Day to day it isn't needed: lib/audience-memory.ts
 * recomputes a person's level whenever their profile is refreshed.
 *
 * Writes ONLY audience_members.level.
 *
 * Unlike the segment backfill this covers EVERY member, not just those with
 * comments: someone recognized for a comment that was later deleted still has a
 * level, and members with no history at all settle at 'new'.
 *
 * Requires migration 20240101000031_audience_levels.sql.
 *
 * Run:
 *   npx tsx scripts/backfill-audience-levels.ts             # compute and write
 *   npx tsx scripts/backfill-audience-levels.ts --dry-run   # report only
 */

import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { createServiceClient } from '../lib/supabase/service'
import { computeLevel, signalsFromHistory, LEVELS, type AudienceLevel } from '../lib/levels'

const dryRun = process.argv.includes('--dry-run')

/** Reads every row of a table in pages, so nothing is lost to the 1000-row cap. */
async function readAll<T>(
  // PromiseLike, not Promise: a Supabase query builder is thenable but is not an
  // actual Promise until it is awaited.
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await run(from, from + 999)
    if (error) throw new Error(`Could not load ${label}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return rows
}

async function main() {
  const supabase = createServiceClient()

  if (!dryRun) {
    const probe = await supabase.from('audience_members').select('level').limit(1)
    if (probe.error) {
      console.error(`audience_members.level is not available (${probe.error.code}: ${probe.error.message}).`)
      console.error('Run supabase/migrations/20240101000031_audience_levels.sql in the Supabase SQL editor first.')
      process.exit(1)
    }
  }

  // Three bulk reads, grouped in memory, rather than two queries per member — a
  // channel with thousands of people would otherwise cost thousands of round trips.
  const members = await readAll<{ id: string }>(
    (from, to) => supabase.from('audience_members').select('id').order('id').range(from, to),
    'audience members'
  )
  const comments = await readAll<{ audience_member_id: string | null; post_id: string }>(
    (from, to) => supabase.from('comments').select('audience_member_id, post_id').order('id').range(from, to),
    'comments'
  )
  const rewards = await readAll<{ audience_member_id: string | null }>(
    (from, to) => supabase.from('reward_events').select('audience_member_id').order('id').range(from, to),
    'reward events'
  )

  const commentsByMember = new Map<string, Array<{ post_id: string }>>()
  for (const c of comments) {
    if (!c.audience_member_id) continue
    const list = commentsByMember.get(c.audience_member_id) ?? []
    list.push({ post_id: c.post_id })
    commentsByMember.set(c.audience_member_id, list)
  }

  const rewardsByMember = new Map<string, number>()
  for (const r of rewards) {
    if (!r.audience_member_id) continue
    rewardsByMember.set(r.audience_member_id, (rewardsByMember.get(r.audience_member_id) ?? 0) + 1)
  }

  console.log(
    `${members.length} members, ${comments.length} comments, ${rewards.length} recognitions loaded.`
  )

  const tally: Record<string, number> = Object.fromEntries(LEVELS.map(l => [l, 0]))
  const updates: Array<{ id: string; level: AudienceLevel }> = []

  for (const member of members) {
    const level = computeLevel(
      signalsFromHistory(commentsByMember.get(member.id) ?? [], rewardsByMember.get(member.id) ?? 0)
    )
    tally[level]++
    updates.push({ id: member.id, level })
  }

  console.log(`level mix: ${JSON.stringify(tally)}`)
  if (dryRun) {
    console.log('DRY RUN — nothing written.')
    return
  }

  let written = 0
  for (const { id, level } of updates) {
    const { error } = await supabase.from('audience_members').update({ level }).eq('id', id)
    if (error) throw new Error(`Update failed for ${id}: ${error.message}`)
    written++
    if (written % 200 === 0) process.stdout.write(`\r  written ${written}/${updates.length}`)
  }
  console.log(`\nWrote ${written} levels.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
