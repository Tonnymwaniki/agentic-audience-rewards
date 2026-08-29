import Link from 'next/link'

type PageHeaderProps = {
  title: string
  backHref?: string
  backLabel?: string
}

export default function PageHeader({ title, backHref, backLabel = 'Back' }: PageHeaderProps) {
  return (
    <div className="mb-6">
      {backHref && (
        <Link
          href={backHref}
          className="mb-2 inline-flex items-center text-sm text-text-muted hover:text-text-primary"
        >
          ← {backLabel}
        </Link>
      )}
      <h1 className="font-display text-2xl font-semibold text-text-primary">{title}</h1>
    </div>
  )
}
