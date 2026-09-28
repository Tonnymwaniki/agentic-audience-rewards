import { logError, logInfo } from '@/lib/logger'

/**
 * Thin wrapper over Resend's HTTP API (no SDK dependency — this is one POST
 * request, and pulling in a package for it isn't worth the extra surface).
 * https://resend.com/docs/api-reference/emails/send-email
 *
 * Requires RESEND_API_KEY. Without it, this logs and returns rather than
 * throwing — email is a nice-to-have notification, never something that should
 * take down a billing flow or any other caller. RESEND_FROM_EMAIL must be an
 * address on a domain verified with Resend; until one is set up, Resend's
 * shared `onboarding@resend.dev` sender works but — on Resend's free tier —
 * only actually delivers to the email address of the Resend account itself,
 * not arbitrary recipients. Real creator-facing email needs a verified domain.
 */
const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export async function sendEmail(args: { to: string; subject: string; html: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    logError('email.send', new Error('RESEND_API_KEY is not configured'), {
      to: args.to,
      subject: args.subject,
    })
    return
  }

  const from = process.env.RESEND_FROM_EMAIL || 'Notice <onboarding@resend.dev>'

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: args.to, subject: args.subject, html: args.html }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => null)
      logError('email.send', new Error(`Resend returned ${response.status}`), {
        to: args.to,
        subject: args.subject,
        body,
      })
      return
    }

    logInfo('email.send', 'Email sent', { to: args.to, subject: args.subject })
  } catch (err) {
    // Never throw: a failed email must not fail whatever triggered it.
    logError('email.send', err, { to: args.to, subject: args.subject })
  }
}
