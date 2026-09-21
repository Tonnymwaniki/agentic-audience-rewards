'use client'

import { useEffect } from 'react'

/**
 * Last-resort boundary: the only one that catches a throw in the ROOT LAYOUT
 * itself, which app/error.tsx cannot — error.tsx renders *inside* the layout that
 * failed, so a broken layout would take the boundary down with it.
 *
 * Because it replaces the root layout, it must render its own <html> and <body>,
 * and globals.css is NOT applied — the stylesheet is imported by the layout this
 * screen stands in for. Every style here is therefore inline and self-contained;
 * a Tailwind class on this page would silently render unstyled. The palette
 * values are copied from globals.css rather than referenced through CSS variables
 * for the same reason.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        context: 'root.global-error-boundary',
        message: error.message,
        error: { name: error.name, message: error.message, stack: error.stack },
        metadata: { digest: error.digest ?? null },
      })
    )
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0B0B14',
          color: '#ECEEF1',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: '400px', textAlign: 'center' }}>
          <p
            style={{
              margin: 0,
              fontSize: '10px',
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              color: '#8B8FA3',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            Notice
          </p>
          <h1 style={{ margin: '12px 0 0', fontSize: '24px', fontWeight: 600 }}>
            Something went wrong
          </h1>
          <p style={{ margin: '12px 0 0', fontSize: '14px', lineHeight: 1.6, color: '#8B8FA3' }}>
            The app failed to load. Nothing was lost — please try again.
          </p>

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '28px',
              width: '100%',
              minHeight: '44px',
              borderRadius: '8px',
              border: 'none',
              cursor: 'pointer',
              color: '#fff',
              fontSize: '14px',
              fontWeight: 500,
              backgroundImage: 'linear-gradient(135deg, #7C5CFF 0%, #E0509E 100%)',
            }}
          >
            Try again
          </button>

          {error.digest && (
            <p
              style={{
                margin: '24px 0 0',
                fontSize: '10px',
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
                color: 'rgba(139, 143, 163, 0.7)',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
            >
              Reference {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  )
}
