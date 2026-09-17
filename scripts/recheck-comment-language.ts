/**
 * Second-pass language check for comments stored as 'swahili_sheng'.
 *
 * Why: language detection folded into the categorization prompt tends to ignore
 * English phrases, so code-switched comments land in swahili_sheng instead of mixed.
 * This pass asks ONLY about language, makes the model quote its evidence (the English
 * phrase, the Swahili/Sheng words) before deciding, and takes a majority of three runs.
 *
 * Swahili and Sheng used to be separate values. A run of this pass measured that they
 * can't be reliably told apart (roughly 50% either way, and debatable for a human
 * reviewer), so they are one value, 'swahili_sheng', everywhere.
 *
 * Writes only comment_categories.language, and only when at least 2 of 3 runs agree
 * on a value different from the stored one. Current values are saved to a backup
 * file first.
 *
 * Run:
 *   npx tsx scripts/recheck-comment-language.ts --backup <file.json>            # re-check and write
 *   npx tsx scripts/recheck-comment-language.ts --backup <file.json> --dry-run  # re-check, write nothing
 */

import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { writeFileSync, existsSync } from 'node:fs'
import { createServiceClient } from '../lib/supabase/service'
import { normalizeLanguage, type CommentLanguage } from '../lib/categorize'

const MODEL = 'claude-haiku-4-5-20251001'
const RUNS = 3
const BATCH = 10
const CONCURRENCY = 4
const dryRun = process.argv.includes('--dry-run')
const backupArg = process.argv.indexOf('--backup')
const backupPath = backupArg > -1 ? process.argv[backupArg + 1] : ''

const PROMPT = `Classify the LANGUAGE each YouTube comment is written in. That is your only task.

First, for each comment, ignore everything that is not a word of a language: names of people, @handles, place names (Kenyan towns and areas too), brand, show and video titles, URLs, timestamps like 12:34, numbers, emoji, and interjections/laughter ("Waah", "Shii", "Eiii", "lol", "haha").

Then quote the evidence you see in what remains:
- english_phrase: the longest run of 2 or more consecutive ENGLISH words that forms a phrase ("welcome back", "for the sake", "I agree", "it's time I pull the plug"), or null if there is none. A single English word on its own is NOT a phrase.
- swahili_or_sheng_words: up to 5 Swahili or Sheng words from the comment (including Swahili words carrying an English stem, like "nimelearn", "ameniencourage"), or null if there are none.

Then decide, in this order:
1. No words left at all, or the words are another language entirely (e.g. Luo, Kikuyu, Kalenjin) -> null.
2. english_phrase is not null AND swahili_or_sheng_words is not null -> "mixed".
3. swahili_or_sheng_words is null -> "english".
4. Otherwise (Swahili and/or Sheng words, and at most single English loanwords): "swahili_sheng". Do not try to tell Swahili and Sheng apart — they are one value.

Report every comment with the report_languages tool, using the comment's number as its key.`

const TOOL = {
  name: 'report_languages',
  description: 'Report the language of every comment.',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', description: "The comment's number" },
            english_phrase: { type: ['string', 'null'] },
            swahili_or_sheng_words: { type: ['string', 'null'] },
            language: { type: ['string', 'null'], enum: ['english', 'swahili_sheng', 'mixed', null] },
          },
          required: ['n', 'english_phrase', 'swahili_or_sheng_words', 'language'],
        },
      },
    },
    required: ['results'],
  },
}

type Verdict = { language: CommentLanguage | null; english_phrase: string | null; words: string | null }

async function classify(batch: Array<{ id: string; text: string }>): Promise<Map<string, Verdict>> {
  const list = batch.map((c, i) => `${i + 1}. ${JSON.stringify(c.text)}`).join('\n')
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2500,
          tools: [TOOL],
          tool_choice: { type: 'tool', name: TOOL.name },
          messages: [{ role: 'user', content: `${PROMPT}\n\nCOMMENTS:\n${list}` }],
        }),
      })
      if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`)
      const data = await res.json()
      if (data.stop_reason === 'max_tokens') throw new Error('cut off at token limit')
      const block = data.content?.find((b: { type?: string }) => b.type === 'tool_use')
      const results = block?.input?.results
      if (!Array.isArray(results)) throw new Error('no results array')
      const out = new Map<string, Verdict>()
      for (const r of results) {
        const c = batch[Number(r?.n) - 1]
        if (!c) continue
        out.set(c.id, {
          language: normalizeLanguage(r.language),
          english_phrase: typeof r.english_phrase === 'string' ? r.english_phrase : null,
          words: typeof r.swahili_or_sheng_words === 'string' ? r.swahili_or_sheng_words : null,
        })
      }
      if (out.size < batch.length) throw new Error(`only ${out.size}/${batch.length} comments reported`)
      return out
    } catch (err) {
      if (attempt === 3) throw err
      await new Promise(r => setTimeout(r, 1500 * attempt))
    }
  }
  throw new Error('unreachable')
}

async function main() {
  if (!backupPath) {
    console.error('Pass --backup <file.json>: current values are saved there before anything is written.')
    process.exit(1)
  }
  const supabase = createServiceClient()

  const rows: Array<{ comment_id: string; language: string; text: string }> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('comment_categories')
      .select('comment_id, language, comments ( text )')
      .eq('language', 'swahili_sheng')
      .order('comment_id')
      .range(from, from + 999)
    if (error) throw new Error(`Could not load rows: ${error.message}`)
    for (const r of data ?? []) rows.push({ comment_id: r.comment_id as string, language: r.language as string, text: (r.comments as unknown as { text: string }).text })
    if (!data || data.length < 1000) break
  }
  console.log(`${rows.length} rows stored as swahili_sheng.`)
  if (existsSync(backupPath)) throw new Error(`${backupPath} already exists — refusing to overwrite a backup`)
  writeFileSync(backupPath, JSON.stringify(rows.map(({ comment_id, language }) => ({ comment_id, language })), null, 1))
  console.log(`Backup of current values written to ${backupPath}`)

  const batches: Array<Array<{ id: string; text: string }>> = []
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH).map(r => ({ id: r.comment_id, text: r.text })))

  const votes = new Map<string, Verdict[]>()
  const jobs = Array.from({ length: RUNS }, () => batches).flat()
  let next = 0
  async function worker() {
    while (next < jobs.length) {
      const batch = jobs[next++]
      const result = await classify(batch)
      for (const [id, v] of result) votes.set(id, [...(votes.get(id) ?? []), v])
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const changes: Array<{ comment_id: string; from: string; to: CommentLanguage | null; votes: string; evidence: string; text: string }> = []
  let unanimous = 0
  let noMajority = 0
  for (const r of rows) {
    const vs = votes.get(r.comment_id) ?? []
    const tally = new Map<string, number>()
    vs.forEach(v => tally.set(String(v.language), (tally.get(String(v.language)) ?? 0) + 1))
    const [winner, count] = [...tally].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
    if (count === RUNS) unanimous++
    if (count < 2) {
      noMajority++
      continue
    }
    const to = winner === 'null' ? null : (winner as CommentLanguage)
    if (to === r.language) continue
    const v = vs.find(x => String(x.language) === winner)!
    changes.push({
      comment_id: r.comment_id,
      from: r.language,
      to,
      votes: vs.map(x => String(x.language)).join('/'),
      evidence: `english_phrase=${JSON.stringify(v.english_phrase)} words=${JSON.stringify(v.words)}`,
      text: r.text,
    })
  }

  const flow = new Map<string, number>()
  changes.forEach(c => flow.set(`${c.from} -> ${c.to}`, (flow.get(`${c.from} -> ${c.to}`) ?? 0) + 1))
  console.log(`\n${RUNS} runs: ${unanimous} unanimous, ${noMajority} with no 2-of-3 majority (left unchanged).`)
  console.log(`${changes.length} corrections: ${JSON.stringify(Object.fromEntries(flow))}`)
  for (const c of changes) {
    const text = c.text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')
    console.log(`  ${c.from.padEnd(7)} -> ${String(c.to).padEnd(7)} [${c.votes}] ${c.evidence}\n      ${JSON.stringify(text.slice(0, 140))}`)
  }

  if (dryRun) {
    console.log('\nDRY RUN — nothing written.')
    return
  }
  let written = 0
  for (const c of changes) {
    const { data, error } = await supabase
      .from('comment_categories')
      .update({ language: c.to })
      .eq('comment_id', c.comment_id)
      .eq('language', c.from) // only if still the value this run read
      .select('comment_id')
    if (error) throw new Error(`Update failed for ${c.comment_id}: ${error.message}`)
    written += data?.length ?? 0
  }
  console.log(`\nWrote ${written}/${changes.length} corrections.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
