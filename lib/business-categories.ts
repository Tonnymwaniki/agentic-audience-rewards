// Shared between the connect flow and the retroactive prompt on Agent Home so the
// two can't drift apart. Values are stored verbatim in creators.business_category.
export const BUSINESS_CATEGORIES = [
  'Retail/E-commerce',
  'Food & Beverage',
  'Beauty & Personal Care',
  'Content Creator/Entertainment',
  'Professional Services',
  'Education',
  'Other',
] as const

export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number]

export function isBusinessCategory(value: unknown): value is BusinessCategory {
  return typeof value === 'string' && (BUSINESS_CATEGORIES as readonly string[]).includes(value)
}
