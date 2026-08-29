import { createServiceClient } from '@/lib/supabase/service'
import { fetchInBatches } from '@/lib/supabase-helpers'

export type EvaluateProgressCallback = (evaluated: number, total: number) => void

export async function evaluateRewards(
  creator_id: string,
  post_id?: string | null,
  onProgress?: EvaluateProgressCallback
) {
  const supabase = createServiceClient()

  const { data: audienceMembers, error: membersError } = await supabase
    .from('audience_members')
    .select('id, display_name, reward_status')
    .eq('creator_id', creator_id)
    .eq('reward_status', 'none')

  if (membersError) {
    console.error('Audience members fetch error:', JSON.stringify(membersError, Object.getOwnPropertyNames(membersError), 2))
    throw new Error('Failed to fetch audience members')
  }

  if (!audienceMembers || audienceMembers.length === 0) {
    return { success: true, evaluated: 0, qualified: 0, results: [] }
  }

  const memberIds = audienceMembers.map(m => m.id)

  const allComments: Array<{ id: string; audience_member_id: string; post_id: string; text: string }> = []
  const commentsBatchSize = 200

  for (let i = 0; i < memberIds.length; i += commentsBatchSize) {
    const batch = memberIds.slice(i, i + commentsBatchSize)
    let query = supabase
      .from('comments')
      .select('id, audience_member_id, post_id, text')
      .in('audience_member_id', batch)

    if (post_id) {
      query = query.eq('post_id', post_id)
    }

    let page = 0
    const pageSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data, error } = await query.range(page * pageSize, (page + 1) * pageSize - 1)

      if (error) {
        console.error('Comments batch error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
        break
      }
      if (data) allComments.push(...data)

      if (!data || data.length < pageSize) {
        hasMore = false
      } else {
        page++
      }
    }
  }

  const comments = allComments

  console.log("REWARD DEBUG - post_id received:", post_id)
  console.log("REWARD DEBUG - comments returned:", comments.length, "post_id filter active:", !!post_id)

  const commentIds = comments.map(c => c.id)

  let categories: Array<{ comment_id: string; category: string; topic: string | null }> = []

  if (commentIds.length > 0) {
    const categoryRows = await fetchInBatches<{ comment_id: string; category: string; topic: string | null }>(supabase, {
      table: 'comment_categories',
      select: 'comment_id, category, topic',
      inColumn: 'comment_id',
      inValues: commentIds,
    })

    categories = categoryRows
  }

  const commentsByMember = new Map<string, Array<{ id: string; post_id: string; text: string }>>()
  for (const comment of comments) {
    const list = commentsByMember.get(comment.audience_member_id) || []
    list.push(comment)
    commentsByMember.set(comment.audience_member_id, list)
  }

  const categoriesByCommentId = new Map(categories.map(c => [c.comment_id, c]))

  const eligibleMembers = audienceMembers.filter(member => {
    const memberComments = commentsByMember.get(member.id) || []
    return memberComments.length >= 1
  })

  console.log("REWARD DEBUG - members found for evaluation:", eligibleMembers.length)

  let evaluated = 0
  let qualified = 0
  const results: Array<{
    audience_member_display_name: string
    qualifies: boolean
    reason: string
  }> = []

  for (const member of eligibleMembers) {
    const memberComments = commentsByMember.get(member.id) || []

    const distinctPosts = new Set(memberComments.map(c => c.post_id)).size
    const purchaseIntentCount = memberComments.filter(c => categoriesByCommentId.get(c.id)?.category === 'purchase_intent').length
    const praiseCount = memberComments.filter(c => categoriesByCommentId.get(c.id)?.category === 'praise').length
    const questionCount = memberComments.filter(c => categoriesByCommentId.get(c.id)?.category === 'question').length

    const sampleComments = memberComments.slice(0, 3).map(c => c.text)

    const signals = {
      totalComments: memberComments.length,
      distinctPosts,
      purchaseIntentCount,
      praiseCount,
      questionCount,
      sampleComments,
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)

      const prompt = `You are deciding which audience members deserve on-chain recognition for genuine engagement with a content creator. Given this audience member's activity: ${JSON.stringify(signals)}, decide if they qualify for a Proof of Engagement reward. Qualify people who show genuine engagement — this can include: commenting 3+ times with substantive (non-spam, non-repetitive) content even on a single post, asking thoughtful questions, showing clear purchase intent, or giving specific praise that references actual content (not just emojis or one-word reactions). Do not require engagement across multiple posts — that's a bonus signal, not a requirement. Disqualify only clear one-off/low-effort engagement (1-2 very short or generic comments) or spam/repetitive content. Respond with ONLY valid JSON: {"qualifies": true or false, "reason": "one sentence explaining why, referencing specific evidence"}`

      let response: Response
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY!,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 256,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        })
      } catch (fetchErr) {
        clearTimeout(timeoutId)
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          console.error('Reward evaluate error: request timed out after 15s')
        } else {
          console.error('Reward evaluate fetch error:', JSON.stringify(fetchErr, Object.getOwnPropertyNames(fetchErr), 2))
        }
        results.push({
          audience_member_display_name: member.display_name,
          qualifies: false,
          reason: fetchErr instanceof Error ? fetchErr.message : 'Request failed',
        })
        evaluated++
        onProgress?.(evaluated, eligibleMembers.length)
        continue
      } finally {
        clearTimeout(timeoutId)
      }

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status}`)
      }

      const data = await response.json()
      const content = data.content?.[0]?.text

      if (!content) {
        throw new Error('Empty response from Anthropic')
      }

      const match = content.match(/\{[\s\S]*\}/)
      if (!match) {
        throw new Error('No JSON object found in response')
      }

      let decision: { qualifies: boolean; reason: string }
      try {
        decision = JSON.parse(match[0])
      } catch (parseErr) {
        console.error('Reward evaluate parse error:', JSON.stringify(parseErr, Object.getOwnPropertyNames(parseErr), 2))
        results.push({
          audience_member_display_name: member.display_name,
          qualifies: false,
          reason: 'Failed to parse AI response',
        })
        evaluated++
        onProgress?.(evaluated, eligibleMembers.length)
        continue
      }

      if (!decision.qualifies) {
        results.push({
          audience_member_display_name: member.display_name,
          qualifies: false,
          reason: decision.reason,
        })
        evaluated++
        onProgress?.(evaluated, eligibleMembers.length)
        continue
      }

      const { error: insertError } = await supabase
        .from('reward_events')
        .insert({
          audience_member_id: member.id,
          reason: decision.reason,
          status: 'pending',
          claim_token: crypto.randomUUID(),
          post_id: post_id || null,
        })

      if (insertError) {
        console.error('Reward event insert error:', JSON.stringify(insertError, Object.getOwnPropertyNames(insertError), 2))
      } else {
        const { error: updateError } = await supabase
          .from('audience_members')
          .update({ reward_status: 'eligible' })
          .eq('id', member.id)

        if (updateError) {
          console.error('Audience member update error:', JSON.stringify(updateError, Object.getOwnPropertyNames(updateError), 2))
        } else {
          qualified++
        }
      }

      results.push({
        audience_member_display_name: member.display_name,
        qualifies: true,
        reason: decision.reason,
      })
      evaluated++
      onProgress?.(evaluated, eligibleMembers.length)
    } catch (err) {
      console.error('Reward evaluate error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
      results.push({
        audience_member_display_name: member.display_name,
        qualifies: false,
        reason: err instanceof Error ? err.message : 'Unknown error',
      })
      evaluated++
      onProgress?.(evaluated, eligibleMembers.length)
    }
  }

  console.error('Reward evaluate results:', JSON.stringify(results, null, 2))

  return { success: true, evaluated, qualified, results }
}
