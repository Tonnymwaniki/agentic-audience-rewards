/**
 * Generates custom Business Profile fields for creators who missed the trigger.
 *
 * lib/custom-profile-fields.ts generates a creator's fields once, when they first
 * set their business_category. Anyone who set theirs before that feature existed
 * never gets them, because the trigger only fires on the category write itself.
 * This script finds those creators and runs the same generator for them.
 *
 * Unlike the other backfills this one DOES call a model — one Claude call per
 * eligible creator — so it is not free, and it prints what it will cost before
 * doing anything when run with --dry-run.
 *
 * Writes ONLY custom_profile_fields rows, with field_value left null. A creator
 * who already has even one field is skipped entirely (the generator's own guard),
 * so re-running this can never duplicate fields or overwrite values someone typed.
 *
 * Requires migration 20240101000032_custom_profile_fields.sql.
 *
 * Run:
 *   npx tsx scripts/backfill-custom-profile-fields.ts             # generate and write
 *   npx tsx scripts/backfill-custom-profile-fields.ts --dry-run   # list who is eligible
 *   npx tsx scripts/backfill-custom-profile-fields.ts --limit 5   # only the first 5
 */

import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { createServiceClient } from '../lib/supabase/service'
import { generateCustomProfileFields } from '../lib/custom-profile-fields'

const dryRun = process.argv.includes('--dry-run')
const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity

async function main() {
  const supabase = createServiceClient()

  const probe = await supabase.from('custom_profile_fields').select('id').limit(1)
  if (probe.error) {
    console.error(`custom_profile_fields is not available (${probe.error.code}: ${probe.error.message}).`)
    console.error('Run supabase/migrations/20240101000032_custom_profile_fields.sql in the Supabase SQL editor first.')
    process.exit(1)
  }

  // Creators with a category — the generator needs one, and refuses without it.
  const { data: creators, error } = await supabase
    .from('creators')
    .select('id, display_name, business_category')
    .not('business_category', 'is', null)
    .order('created_at')
  if (error) throw new Error(`Could not load creators: ${error.message}`)

  const withCategory = creators ?? []

  // One read for every existing field row, grouped in memory, rather than a
  // per-creator existence check.
  const { data: existing, error: existingError } = await supabase
    .from('custom_profile_fields')
    .select('creator_id')
  if (existingError) throw new Error(`Could not load existing fields: ${existingError.message}`)

  const alreadyHave = new Set((existing ?? []).map(r => r.creator_id as string))
  const eligible = withCategory.filter(c => !alreadyHave.has(c.id as string)).slice(0, limit)

  const { count: totalCreators } = await supabase
    .from('creators')
    .select('id', { count: 'exact', head: true })

  const alreadyCovered = withCategory.filter(c => alreadyHave.has(c.id as string)).length

  console.log(`creators total: ${totalCreators}`)
  console.log(`  with a business_category set : ${withCategory.length}`)
  console.log(`  of those, already have fields: ${alreadyCovered}`)
  console.log(`  ELIGIBLE for backfill        : ${eligible.length}`)

  if (eligible.length === 0) {
    console.log('\nNothing to do.')
    if (withCategory.length === 0) {
      console.log('No creator has a business_category set, so none can be generated for —')
      console.log('the generator refuses without one rather than guessing from nothing.')
    }
    return
  }

  console.log('\neligible creators:')
  for (const c of eligible) {
    console.log(`  ${String(c.id).slice(0, 8)}  ${String(c.display_name).slice(0, 34).padEnd(34)} category=${c.business_category}`)
  }

  if (dryRun) {
    console.log(`\nDRY RUN — nothing written. Running for real would make ${eligible.length} Claude call(s).`)
    return
  }

  console.log('')
  let generated = 0
  let skipped = 0
  for (const c of eligible) {
    const result = await generateCustomProfileFields(
      supabase,
      c.id as string,
      c.business_category as string
    )
    if (result.generated.length > 0) {
      generated++
      console.log(`  ${String(c.display_name).slice(0, 30)} -> ${result.generated.length} field(s): ${result.generated.map(f => f.fieldLabel).join(', ')}`)
    } else {
      skipped++
      console.log(`  ${String(c.display_name).slice(0, 30)} -> none (${result.skipped ?? 'unknown reason'})`)
    }
  }

  console.log(`\nGenerated fields for ${generated} creator(s); ${skipped} produced none.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
