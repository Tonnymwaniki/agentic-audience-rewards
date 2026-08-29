import { useState, useEffect, useRef, useCallback } from 'react'

type AnalysisStatus = 'idle' | 'running' | 'done' | 'error'

interface AnalysisResult {
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

export function useAnalyze(creatorId: string) {
  const [status, setStatus] = useState<AnalysisStatus>('idle')
  const [stage, setStage] = useState<string | null>(null)
  const [progressText, setProgressText] = useState('')
  const [progressPercent, setProgressPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const pollingRef = useRef<NodeJS.Timeout | null>(null)

  const clearPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }, [])

  useEffect(() => {
    return clearPolling
  }, [clearPolling])

  const start = useCallback(async (youtubeUrl: string) => {
    setStatus('running')
    setError(null)
    setResult(null)
    setStage(null)
    setProgressText('')
    setProgressPercent(0)
    clearPolling()

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          creator_id: creatorId,
          youtube_url: youtubeUrl,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Analysis failed')
      }

      const postId = data.postId
      const commentsIngested = data.commentsIngested || 0

      setStage('ingesting')
      setProgressText(`Reading comments... (${commentsIngested} found)`)
      setProgressPercent(0)

      const poll = async () => {
        try {
          const statusRes = await fetch(`/api/analyze/status?post_id=${postId}`)
          if (!statusRes.ok) return
          const statusData: StatusData = await statusRes.json()

          setStage(statusData.analysis_stage)

          if (statusData.analysis_stage === 'categorizing') {
            const total = statusData.comments_total || 0
            const done = statusData.comments_categorized || 0
            setProgressText(`Understanding your audience... (${done} of ${total})`)
            setProgressPercent(total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0)
          } else if (statusData.analysis_stage === 'evaluating') {
            const total = statusData.members_total || 0
            const done = statusData.members_evaluated || 0
            setProgressText(`Finding people worth recognizing... (${done} of ${total})`)
            setProgressPercent(total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0)
          } else if (statusData.analysis_stage === 'ingesting') {
            setProgressText(`Reading comments... (${statusData.comments_total || 0} found)`)
            setProgressPercent(0)
          } else {
            setProgressText(statusData.analysis_stage || 'Processing...')
            setProgressPercent(0)
          }

          if (statusData.analysis_status === 'done' || statusData.analysis_status === 'error') {
            clearPolling()
            setStatus(statusData.analysis_status === 'done' ? 'done' : 'error')

            if (statusData.analysis_status === 'done') {
              setResult({
                postId,
                commentsIngested: statusData.comments_total,
                categorized: statusData.comments_categorized,
                qualified: statusData.members_evaluated,
              })
            } else {
              setError('Analysis failed. Please try again.')
            }
          }
        } catch {
          // polling errors are non-fatal
        }
      }

      poll()
      pollingRef.current = setInterval(poll, 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setStatus('error')
      clearPolling()
    }
  }, [creatorId, clearPolling])

  return {
    start,
    status,
    stage,
    progressText,
    progressPercent,
    error,
    result,
  }
}
