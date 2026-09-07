'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Beyond this the box scrolls internally rather than growing without limit — a very
 * long reply would otherwise push the Approve button off the bottom of the screen.
 *
 * 360 rather than a round 300, chosen against the real distribution of drafted
 * replies (n=77: median 248 chars, p90 331, max 463). At a 375px viewport that fits
 * about the 90th percentile without scrolling; at 414px it fits everything typical.
 * Going higher would let one editor occupy more than half a phone screen.
 */
const MAX_TEXTAREA_HEIGHT = 360

// The drafted reply, editable in place, plus Save & Approve and Copy.
//
// Shared by Highlights, Agent Home and the video Inbox so the three can't drift —
// they previously each had their own static rendering and their own copy button.

type DraftReplyEditorProps = {
  commentId: string
  /** The agent's original text. Never mutated by editing here. */
  draftReply: string
  /** What was approved previously, if this reply has already been through once. */
  finalReplyText?: string | null
  /** Already approved — renders read-only with just Copy. */
  approved?: boolean
  /** Fired after a successful save so the parent can dismiss or refresh. */
  onApproved?: (result: { finalReplyText: string; wasEdited: boolean }) => void
  className?: string
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
    >
      {copied ? 'Copied!' : 'Copy Reply'}
    </button>
  )
}

export default function DraftReplyEditor({
  commentId,
  draftReply,
  finalReplyText,
  approved = false,
  onApproved,
  className = '',
}: DraftReplyEditorProps) {
  // Seeded with the approved text when there is one, so re-opening a reply shows
  // what was actually sent rather than reverting to the agent's original.
  const [text, setText] = useState(finalReplyText ?? draftReply)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedEdited, setSavedEdited] = useState<boolean | null>(null)

  const baseline = finalReplyText ?? draftReply
  // Compared against the AGENT'S DRAFT, not against whatever was last saved —
  // because that is exactly what the server records in reply_was_edited. Comparing
  // against the saved text instead made the badge say "Edited" while the server
  // replied "Approved as drafted", since re-typing the original draft over a
  // previously-edited reply differs from the save but matches the draft.
  const differsFromDraft = text.trim() !== draftReply.trim()
  const isEmpty = text.trim().length === 0

  // Grow to fit the content, then scroll past MAX_TEXTAREA_HEIGHT.
  //
  // The previous version set `rows` from the NEWLINE count, which is the wrong
  // measure: a drafted reply is normally one long paragraph with no newlines at all,
  // so it always got the 3-row minimum and scrolled internally on a phone, hiding
  // most of the text. scrollHeight accounts for wrapping, which is what actually
  // determines the height needed at a given width.
  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    // Reset first — scrollHeight only grows while an explicit height is set, so
    // without this the box could expand but never shrink back.
    el.style.height = 'auto'
    // scrollHeight covers content + padding but NOT borders, while box-sizing is
    // border-box here, so height must include them or the box lands 2px short and
    // shows a phantom scrollbar. offsetHeight - clientHeight is exactly that.
    const chrome = el.offsetHeight - el.clientHeight
    el.style.height = `${Math.min(el.scrollHeight + chrome, MAX_TEXTAREA_HEIGHT)}px`
  }, [])

  // useLayoutEffect runs before paint, so the box is never briefly shown at the
  // wrong height on mount.
  useLayoutEffect(resize, [text, resize])

  // Re-measure once the webfont lands: fallback metrics differ enough that a reply
  // sized against them can end up a line short after the swap.
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts?.ready) return
    let cancelled = false
    document.fonts.ready.then(() => {
      if (!cancelled) resize()
    })
    return () => {
      cancelled = true
    }
  }, [resize])

  async function handleSave() {
    if (saving || isEmpty) return
    setSaving(true)
    setError(null)

    try {
      const res = await fetch('/api/draft-reply/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment_id: commentId, final_reply_text: text }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save')

      setSavedEdited(Boolean(data.reply_was_edited))
      onApproved?.({
        finalReplyText: data.final_reply_text ?? text,
        wasEdited: Boolean(data.reply_was_edited),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  if (approved) {
    return (
      <div className={`rounded-md bg-surface-hover p-3 ${className}`}>
        <p className="mb-1 text-xs font-medium text-text-muted">Approved reply</p>
        <p className="text-sm whitespace-pre-wrap text-text-primary">{baseline}</p>
        <div className="mt-2">
          <CopyButton text={baseline} />
        </div>
      </div>
    )
  }

  return (
    <div className={`rounded-md bg-surface-hover p-3 ${className}`}>
      <label
        htmlFor={`draft-${commentId}`}
        className="mb-1.5 block text-xs font-medium text-text-muted"
      >
        Drafted reply — edit before approving
      </label>
      <textarea
        id={`draft-${commentId}`}
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        rows={1}
        disabled={saving}
        // Height is set imperatively by resize(); maxHeight caps it and overflowY
        // only engages once the content exceeds that cap.
        className="w-full resize-none rounded-lg border border-white/10 bg-surface px-3 py-2 text-sm leading-relaxed text-text-primary focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink focus:outline-none disabled:opacity-60"
        style={{ maxHeight: MAX_TEXTAREA_HEIGHT, overflowY: 'auto' }}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || isEmpty}
          className="btn-primary px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : differsFromDraft ? 'Save & Approve' : 'Approve'}
        </button>

        {/* Copies what's in the box: the approved text when there is one, the draft
            when there isn't, and any unsaved edit in progress — which is what the
            creator is looking at and about to paste. */}
        <CopyButton text={text} />

        {differsFromDraft && !saving && (
          <span className="font-mono text-[10px] tracking-wide text-purple-text uppercase">
            Edited
          </span>
        )}
      </div>

      {savedEdited !== null && (
        <p className="mt-2 text-xs text-text-muted">
          {savedEdited ? 'Saved your edited reply.' : 'Approved as drafted.'}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-avax-red">{error}</p>}
    </div>
  )
}
