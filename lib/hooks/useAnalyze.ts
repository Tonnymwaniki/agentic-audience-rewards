import { useState, useEffect, useRef, useCallback } from 'react'
import { runAnalysis, type AnalysisResult } from '@/lib/analyze-run'

type AnalysisStatus = 'idle' | 'running' | 'done' | 'error'

/**
 * React binding over runAnalysis: the polling and completion logic lives in
 * lib/analyze-run so a caller that needs to sequence several videos can await
 * them directly, while components that only need progress state use this.
 */
export function useAnalyze(creatorId: string) {
  const [status, setStatus] = useState<AnalysisStatus>('idle')
  const [stage, setStage] = useState<string | null>(null)
  const [progressText, setProgressText] = useState('')
  const [progressPercent, setProgressPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Stops the polling loop when the component goes away, so an unmounted page
  // isn't left with an interval hitting the status endpoint forever.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const start = useCallback(
    async (youtubeUrl: string) => {
      setStatus('running')
      setError(null)
      setResult(null)
      setStage(null)
      setProgressText('')
      setProgressPercent(0)

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      const outcome = await runAnalysis(
        creatorId,
        youtubeUrl,
        progress => {
          if (controller.signal.aborted) return
          setStage(progress.stage)
          setProgressText(progress.text)
          setProgressPercent(progress.percent)
        },
        controller.signal
      )

      // A superseded or unmounted run must not write back over the newer one.
      if (controller.signal.aborted) return

      if (outcome.status === 'done') {
        setResult(outcome.result)
        setStatus('done')
      } else {
        setError(outcome.error)
        setStatus('error')
      }
    },
    [creatorId]
  )

  return {
    start,
    status,
    stage,
    progressText,
    progressPercent,
    error,
    result,
    setResult,
  }
}
