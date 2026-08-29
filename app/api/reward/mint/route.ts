import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createThirdwebClient, getContract, sendAndConfirmTransaction } from 'thirdweb'
import { avalancheFuji } from 'thirdweb/chains'
import { claimTo } from 'thirdweb/extensions/erc721'
import { privateKeyToAccount } from 'thirdweb/wallets'
import dotenv from 'dotenv'
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

    const cookieStore = await cookies()

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll() {},
        },
      }
    )

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

    console.log('MINT: about to update reward_events for claim_token:', claim_token, 'row id:', rewardEvent.id)

    const { error: updateEventError } = await supabase
      .from('reward_events')
      .update({
        status: 'minted',
        tx_hash: txHash,
      })
      .eq('claim_token', claim_token)

    if (updateEventError) {
      console.log("MINT STATUS UPDATE ERROR:", JSON.stringify(updateEventError, Object.getOwnPropertyNames(updateEventError), 2))
    } else {
      console.log("MINT STATUS UPDATE SUCCESS for claim_token:", claim_token)
    }

    const { error: updateMemberError } = await supabase
      .from('audience_members')
      .update({
        wallet_address,
        reward_status: 'minted',
      })
      .eq('id', rewardEvent.audience_member_id)

    if (updateMemberError) {
      console.error('Audience member update error:', JSON.stringify(updateMemberError, Object.getOwnPropertyNames(updateMemberError), 2))
    }

    return NextResponse.json({
      success: true,
      tx_hash: txHash,
    })
  } catch (err) {
    console.error('Mint error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
