export interface AnalysisResult {
  postId: string
  commentsIngested: number
  categorized: number
  qualified: number
}

interface StatusData {
  analysis_status: string
  analysis_stage: string | null
  comments_total: number
  comments_categorized: number
  members_total: number
  members_evaluated: number
}

export interface AnalysisProgress {
  stage: string | null
  text: string
  percent: number
}

export type AnalysisOutcome =
  | { status: 'done'; result: AnalysisResult }
  | { status: 'error'; error: string }

const POLL_INTERVAL_MS = 1500

/**
 * Runs one video analysis and resolves only when it has actually finished.
 *
 * The /api/analyze route returns as soon as ingestion is queued, so completion
 * has to be observed by polling /api/analyze/status. Exposing that as a promise
 * (rather than only as hook state) is what lets a caller analyze several videos
 * one after another with a plain `for` loop, instead of driving a queue from an
 * effect that watches a status flag flip.
 *
 * Never throws — a failure comes back as { status: 'error' }.
 */
export async function runAnalysis(
  creatorId: string,
  youtubeUrl: string,
  onProgress?: (progress: AnalysisProgress) => void,
  signal?: AbortSignal
): Promise<AnalysisOutcome> {
  const report = (stage: string | null, text: string, percent: number) => {
    onProgress?.({ stage, text, percent })
  }

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creator_id: creatorId, youtube_url: youtubeUrl }),
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'Analysis failed')
    }

    const postId = data.postId
    report('ingesting', `Reading comments... (${data.commentsIngested || 0} found)`, 0)

    return await new Promise<AnalysisOutcome>(resolve => {
      let interval: ReturnType<typeof setInterval> | null = null

      const stop = () => {
        if (interval) clearInterval(interval)
        interval = null
      }

      const poll = async () => {
        // Aborting only stops the client watching; the server-side analysis keeps
        // going, which is why an aborted run reports 'cancelled' rather than a failure.
        if (signal?.aborted) {
          stop()
          resolve({ status: 'error', error: 'cancelled' })
          return
        }

        try {
          const statusRes = await fetch(`/api/analyze/status?post_id=${postId}`)
          if (!statusRes.ok) return
          const statusData: StatusData = await statusRes.json()

          if (statusData.analysis_stage === 'categorizing') {
            const total = statusData.comments_total || 0
            const done = statusData.comments_categorized || 0
            report(
              'categorizing',
              `Understanding your audience... (${done} of ${total})`,
              total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
            )
          } else if (statusData.analysis_stage === 'evaluating') {
            const total = statusData.members_total || 0
            const done = statusData.members_evaluated || 0
            report(
              'evaluating',
              `Finding people worth recognizing... (${done} of ${total})`,
              total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
            )
          } else if (statusData.analysis_stage === 'ingesting') {
            report('ingesting', `Reading comments... (${statusData.comments_total || 0} found)`, 0)
          } else {
            report(statusData.analysis_stage, statusData.analysis_stage || 'Processing...', 0)
          }

          if (statusData.analysis_status === 'done') {
            stop()
            resolve({
              status: 'done',
              result: {
                postId,
                commentsIngested: statusData.comments_total,
                categorized: statusData.comments_categorized,
                qualified: statusData.members_evaluated,
              },
            })
          } else if (statusData.analysis_status === 'error') {
            stop()
            resolve({ status: 'error', error: 'Analysis failed. Please try again.' })
          }
        } catch {
          // Polling errors are non-fatal; the next tick retries.
        }
      }

      poll()
      interval = setInterval(poll, POLL_INTERVAL_MS)
    })
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : 'Something went wrong',
    }
  }
}
