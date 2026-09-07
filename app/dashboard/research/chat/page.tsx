import ResearchChat from '../ResearchChat'

export const dynamic = 'force-dynamic'

/**
 * The full-screen mobile chat. Auth and the conversation provider both come from
 * app/dashboard/research/layout.tsx, so this route is only a shell — and crucially
 * it shares that provider with the overview page, which is what preserves an
 * in-progress conversation across Back and Start Chat.
 *
 * app/dashboard/layout.tsx renders this path without the dashboard chrome, so the
 * bottom tab bar and the Research FAB are not merely hidden with CSS — they are
 * never mounted while this view is open.
 */
export default function ResearchChatPage() {
  return <ResearchChat variant="fullscreen" />
}
