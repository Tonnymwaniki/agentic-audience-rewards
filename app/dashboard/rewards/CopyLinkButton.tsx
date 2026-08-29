'use client'

import { useState } from 'react'

type CopyLinkButtonProps = {
  claimToken: string
  status: string
  txHash?: string | null
}

export default function CopyLinkButton({ claimToken, status, txHash }: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false)

  if (status === 'minted' || status === 'claimed') {
    if (txHash) {
      return (
        <a
          href={`https://testnet.snowtrace.io/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-avax-red underline hover:text-avax-red/80"
        >
          View on Snowtrace
        </a>
      )
    }
    return <span className="text-xs text-text-muted">Claimed</span>
  }

  if (status !== 'pending') {
    return null
  }

  const claimUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/claim/${claimToken}`
    : ''

  async function handleCopy() {
    if (!claimUrl) return

    try {
      await navigator.clipboard.writeText(claimUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard API unavailable; silent fail
    }
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
    >
      {copied ? 'Copied!' : 'Copy Claim Link'}
    </button>
  )
}
