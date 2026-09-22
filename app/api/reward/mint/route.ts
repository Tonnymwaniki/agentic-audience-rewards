import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { createThirdwebClient, getContract, sendAndConfirmTransaction } from 'thirdweb'
import { avalancheFuji } from 'thirdweb/chains'
import { claimTo } from 'thirdweb/extensions/erc721'
import { privateKeyToAccount } from 'thirdweb/wallets'
import dotenv from 'dotenv'
import { logError, logInfo } from '@/lib/logger'
dotenv.config({ path: '.env.local' })

export async function POST(request: NextRequest) {
  try {
    const { claim_token, wallet_address } = await request.json()

    if (!claim_token || !wallet_address) {
      return NextResponse.json(
        { error: 'Missing claim_token or wallet_address' },
        { status: 400 }
      )
    }

    // Deliberately NOT cookie-bound. This endpoint is authorized by the claim
    // token in the request, not by a session — the claimant is an audience
    // member, who has no account here. Passing cookies as well used to mean that
    // if a signed-in creator happened to open a claim link, the client ran as
    // that user and RLS silently dropped the status write, failing the claim.
    const supabase = createServiceClient()

    const { data: rewardEvent, error: rewardError } = await supabase
      .from('reward_events')
      .select('id, status, audience_member_id, audience_members (wallet_address)')
      .eq('claim_token', claim_token)
      .single()

    if (rewardError || !rewardEvent) {
      return NextResponse.json(
        { error: 'Invalid claim token' },
        { status: 404 }
      )
    }

    if (rewardEvent.status !== 'pending') {
      return NextResponse.json(
        { error: 'This reward has already been claimed' },
        { status: 400 }
      )
    }

    const secretKey = process.env.THIRDWEB_SECRET_KEY
    const deployerPrivateKey = process.env.THIRDWEB_DEPLOYER_PRIVATE_KEY

    if (!secretKey || !deployerPrivateKey) {
      return NextResponse.json(
        { error: 'Server misconfiguration: missing thirdweb credentials' },
        { status: 500 }
      )
    }

    const client = createThirdwebClient({ secretKey })
    const account = privateKeyToAccount({ client, privateKey: deployerPrivateKey })

    const contractAddress = process.env.NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS!

    const contract = getContract({
      client,
      chain: avalancheFuji,
      address: contractAddress,
    })

    const claimTx = claimTo({
      contract,
      to: wallet_address,
      quantity: BigInt(1),
    })

    const result = await sendAndConfirmTransaction({
      transaction: claimTx,
      account,
    })

    const txHash = result.transactionHash

    logInfo('api/reward/mint', 'Mint sent on-chain; writing status', { reward_event_id: rewardEvent.id, tx_hash: txHash, claim_token })

    const { error: updateEventError } = await supabase
      .from('reward_events')
      .update({
        status: 'minted',
        tx_hash: txHash,
      })
      .eq('claim_token', claim_token)

    if (updateEventError) {
      logError('api/reward/mint', updateEventError, { reward_event_id: rewardEvent.id, tx_hash: txHash, stage: 'update_reward_event_status' })
    } else {
      logInfo('api/reward/mint', 'Reward marked minted', { reward_event_id: rewardEvent.id, tx_hash: txHash, claim_token })
    }

    const { error: updateMemberError } = await supabase
      .from('audience_members')
      .update({
        wallet_address,
        reward_status: 'minted',
      })
      .eq('id', rewardEvent.audience_member_id)

    if (updateMemberError) {
      logError('api/reward/mint', updateMemberError, { reward_event_id: rewardEvent.id, audience_member_id: rewardEvent.audience_member_id, stage: 'update_member_after_mint' })
    }

    return NextResponse.json({
      success: true,
      tx_hash: txHash,
    })
  } catch (err) {
    logError('api/reward/mint', err, { stage: 'mint' })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
