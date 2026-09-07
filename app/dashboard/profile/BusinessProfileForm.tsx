'use client'

import { useState } from 'react'

type ProfileFields = {
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

export default function BusinessProfileForm({ initial }: { initial: ProfileFields }) {
  const [values, setValues] = useState<ProfileFields>(initial)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update(key: keyof ProfileFields, value: string) {
    setValues(prev => ({ ...prev, [key]: value }))
    // Any edit invalidates the previous "Saved" confirmation.
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
        body: JSON.stringify(values),
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
