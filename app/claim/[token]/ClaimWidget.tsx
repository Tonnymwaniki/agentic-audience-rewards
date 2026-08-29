'use client'

import { useState } from 'react'
import { ConnectButton } from 'thirdweb/react'
import { createThirdwebClient } from 'thirdweb'
import { avalancheFuji } from 'thirdweb/chains'
import { createWallet } from 'thirdweb/wallets'

type ClaimWidgetProps = {
  claimToken: string
  reason: string
}

const client = createThirdwebClient({
  clientId: process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID!,
})

const wallets = [
  createWallet('io.metamask'),
  createWallet('walletConnect'),
]

export default function ClaimWidget({ claimToken, reason }: ClaimWidgetProps) {
  const [status, setStatus] = useState<'idle' | 'claiming' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  async function handleClaim(walletAddress: string) {
    setStatus('claiming')
    setErrorMessage(null)
    setTxHash(null)

    try {
      const response = await fetch('/api/reward/mint', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          claim_token: claimToken,
          wallet_address: walletAddress,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Claim failed')
      }

      setTxHash(data.tx_hash)
      setStatus('success')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong')
      setStatus('error')
    }
  }

  return (
    <div className="card">
      <div className="mb-4">
        <p className="text-sm font-body font-medium text-text-muted">You've been recognized for:</p>
        <p className="mt-1 text-sm text-text-primary">
          <span className="highlight">{reason}</span>
        </p>
      </div>

      {status === 'idle' && (
        <ConnectButton
          client={client}
          chain={avalancheFuji}
          wallets={wallets}
          theme="dark"
          connectButton={{
            label: 'Connect Wallet to Claim',
            className: 'w-full',
          }}
          onConnect={async wallet => {
            const account = await wallet.getAccount()
            if (account) {
              handleClaim(account.address)
            }
          }}
        />
      )}

      {status === 'claiming' && (
        <div className="text-center">
          <p className="text-sm text-text-muted">Claiming your token...</p>
        </div>
      )}

      {status === 'success' && txHash && (
        <div className="text-center">
          <p className="mb-2 text-sm font-medium text-green-600">Claim successful!</p>
          <a
            href={`https://testnet.snowtrace.io/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-avax-red underline hover:text-avax-red/80"
          >
            View on Snowtrace
          </a>
        </div>
      )}

      {status === 'error' && errorMessage && (
        <div>
          <p className="text-sm text-avax-red">{errorMessage}</p>
          <button
            onClick={() => setStatus('idle')}
            className="mt-2 text-sm text-text-muted underline hover:text-text-primary"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
