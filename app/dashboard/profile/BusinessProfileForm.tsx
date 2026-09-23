'use client'

import { useState } from 'react'
import type { CustomProfileField } from '@/lib/custom-profile-fields'

type ProfileFields = {
  display_name: string
  business_phone: string
  business_whatsapp: string
  business_location: string
  business_hours: string
  business_website: string
  delivery_info: string
}

const FIELDS: Array<{
  key: keyof ProfileFields
  label: string
  placeholder: string
  hint?: string
  type?: string
}> = [
  {
    key: 'display_name',
    label: 'Your name',
    placeholder: 'Wanjiku',
    hint: 'Used to greet you on Agent Home. Leave blank and we’ll use your email address.',
  },
  {
    key: 'business_phone',
    label: 'Phone number',
    placeholder: '+254 700 000 000',
    type: 'tel',
  },
  {
    key: 'business_whatsapp',
    label: 'WhatsApp number',
    placeholder: '+254 700 000 000',
    hint: 'Leave blank if it’s the same as your phone number.',
    type: 'tel',
  },
  {
    key: 'business_location',
    label: 'Location / address',
    placeholder: 'Shop 12, Ngara Road, Nairobi',
  },
  {
    key: 'business_hours',
    label: 'Business hours',
    placeholder: 'Mon–Sat, 9am–6pm',
  },
  {
    key: 'business_website',
    label: 'Website or social link',
    placeholder: 'https://example.com',
    type: 'url',
  },
]

export default function BusinessProfileForm({
  initial,
  customFields,
}: {
  initial: ProfileFields
  /** AI-suggested, per-business. Empty until a category has been set. */
  customFields: CustomProfileField[]
}) {
  const [values, setValues] = useState<ProfileFields>(initial)
  // Keyed by field_key, which is what the API expects back under custom_fields.
  const [customValues, setCustomValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(customFields.map(f => [f.fieldKey, f.fieldValue ?? '']))
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update(key: keyof ProfileFields, value: string) {
    setValues(prev => ({ ...prev, [key]: value }))
    // Any edit invalidates the previous "Saved" confirmation.
    setSaved(false)
  }

  function updateCustom(key: string, value: string) {
    setCustomValues(prev => ({ ...prev, [key]: value }))
    setSaved(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return

    setSaving(true)
    setError(null)
    setSaved(false)

    try {
      const res = await fetch('/api/creator/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // custom_fields is a separate object so the route can keep its strict
        // whitelist over the fixed columns and never treat a custom key as one.
        body: JSON.stringify({ ...values, custom_fields: customValues }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to save')
      }

      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {FIELDS.map(field => (
        <div key={field.key}>
          <label htmlFor={field.key} className="mb-2 block text-sm font-medium text-text-muted">
            {field.label}
          </label>
          <input
            id={field.key}
            type={field.type || 'text'}
            value={values[field.key]}
            onChange={e => update(field.key, e.target.value)}
            placeholder={field.placeholder}
            className="flex h-11 w-full rounded-lg border border-white/10 bg-surface px-4 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink"
          />
          {field.hint && <p className="mt-1 text-xs text-text-muted">{field.hint}</p>}
        </div>
      ))}

      <div>
        <label htmlFor="delivery_info" className="mb-2 block text-sm font-medium text-text-muted">
          Delivery / shipping policy
        </label>
        <textarea
          id="delivery_info"
          rows={4}
          value={values.delivery_info}
          onChange={e => update('delivery_info', e.target.value)}
          placeholder="e.g. Free delivery within Nairobi CBD. Countrywide via G4S, 2–3 days, paid by customer."
          className="w-full resize-none rounded-lg border border-white/10 bg-surface px-4 py-3 text-sm leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink"
        />
        <p className="mt-1 text-xs text-text-muted">
          Free text — describe it however it actually works for you.
        </p>
      </div>

      {/* --- AI-suggested, per-business. Visually separated and explicitly labelled
              so it is obvious these were generated for this creator rather than
              asked of everyone. --- */}
      {customFields.length > 0 && (
        // Tint raised from purple/5 to purple/10 and the border from /30 to /40:
        // at 5% on this near-black background the container was almost invisible,
        // so three unfamiliar empty inputs read as more of the same fixed fields.
        // The badge is the actual signal — a heading alone is easy to skim past.
        <div className="space-y-5 rounded-xl border border-purple/40 bg-purple/10 p-4">
          <div className="flex items-start gap-3">
            <span className="icon-badge icon-badge-purple" aria-hidden="true">
              {/* The same sparkle the agent uses elsewhere, so "this came from your
                  agent" is recognisable without reading anything. */}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                className="h-5 w-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z"
                />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              {/* Names the source. "Personalized for your business" described the
                  result; this describes where it came from, which is the part that
                  distinguishes these from the fixed questions above. */}
              <p className="font-display text-sm leading-snug font-semibold text-text-primary">
                Suggested by your agent, based on your comments
              </p>
              <p className="mt-1 text-xs leading-snug text-text-muted">
                Picked from your videos and what your audience actually asks about — so they
                differ from the fixed questions above. Fill in what applies; blank fields are
                simply never used.
              </p>
            </div>
          </div>

          {customFields.map(field => (
            <div key={field.fieldKey}>
              <label
                htmlFor={field.fieldKey}
                className="mb-2 block text-sm font-medium text-text-muted"
              >
                {field.fieldLabel}
              </label>
              <input
                id={field.fieldKey}
                type="text"
                value={customValues[field.fieldKey] ?? ''}
                onChange={e => updateCustom(field.fieldKey, e.target.value)}
                className="flex h-11 w-full rounded-lg border border-white/10 bg-surface px-4 text-sm text-text-primary placeholder:text-text-muted focus:ring-2 focus:ring-purple focus:ring-offset-2 focus:ring-offset-ink focus:outline-none"
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4">
        <button type="submit" disabled={saving} className="btn-primary disabled:opacity-50">
          {saving ? 'Saving...' : 'Save profile'}
        </button>
        {saved && (
          <span className="text-sm text-text-muted">
            Profile saved — refreshing your drafted replies in the background.
          </span>
        )}
        {error && <span className="text-sm text-avax-red">{error}</span>}
      </div>
    </form>
  )
}
