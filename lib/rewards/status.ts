// Reward rows issued before channel-ownership verification existed, on channels
// their creator has not proven they own. They are kept (not deleted) as an audit
// trail, and the void is PERMANENT: verifying the channel later does not revive
// them — verification only authorizes rewards generated after it. Nothing in the
// app ever moves a row out of this status.
export const VOIDED_UNVERIFIED_STATUS = 'voided_unverified'

export const VOIDED_UNVERIFIED_MESSAGE =
  'This reward was issued before ownership verification existed and cannot be claimed.'

export function isVoidedReward(status: string | null | undefined): boolean {
  return status === VOIDED_UNVERIFIED_STATUS
}

/**
 * Whether a reward row represents genuine recognition. Voided rows are kept as an
 * audit trail but never count toward "people recognized", lifetime summaries or
 * anything else presented as recognition — they were never valid rewards.
 */
export function countsAsRecognition(status: string | null | undefined): boolean {
  return !isVoidedReward(status)
}
