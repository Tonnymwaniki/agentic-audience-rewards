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
        <div className="space-y-5 rounded-xl border border-purple/30 bg-purple/5 p-4">
          <div>
            <p className="font-mono text-[10px] tracking-widest text-purple-text uppercase">
              Personalized for your business
            </p>
            <p className="mt-1 text-xs leading-snug text-text-muted">
              Your agent suggested these from your videos and what your audience asks about.
              Fill in what applies — blank fields are simply never used.
            </p>
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
