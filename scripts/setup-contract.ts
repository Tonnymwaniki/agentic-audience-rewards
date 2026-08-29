/**
 * One-off script to set up the deployed DropERC721 contract on Avalanche Fuji.
 *
 * - Lazy mints 50 tokens with identical metadata
 * - Sets public claim conditions (free, native AVAX currency)
 *
 * Required env vars:
 * - THIRDWEB_SECRET_KEY
 * - THIRDWEB_DEPLOYER_PRIVATE_KEY
 *
 * Run:
 *   npx tsx scripts/setup-contract.ts
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { createThirdwebClient, getContract, sendAndConfirmTransaction } from 'thirdweb'
import { avalancheFuji } from 'thirdweb/chains'
import { lazyMint, setClaimConditions } from 'thirdweb/extensions/erc721'
import { privateKeyToAccount } from 'thirdweb/wallets'

async function main() {
  const secretKey = process.env.THIRDWEB_SECRET_KEY
  const privateKey = process.env.THIRDWEB_DEPLOYER_PRIVATE_KEY

  if (!secretKey) {
    console.error('Missing THIRDWEB_SECRET_KEY env var')
    process.exit(1)
  }

  if (!privateKey) {
    console.error('Missing THIRDWEB_DEPLOYER_PRIVATE_KEY env var')
    process.exit(1)
  }

  const client = createThirdwebClient({
    secretKey,
  })

  const account = privateKeyToAccount({
    client,
    privateKey,
  })

  const contractAddress = '0x093E6015be7F2F60Be177C959D0042268AAA1d60'

  console.log('Setting up contract:', contractAddress)
  console.log('Chain:', avalancheFuji.name)
  console.log('Account:', account.address)

  const contract = getContract({
    client,
    chain: avalancheFuji,
    address: contractAddress,
  })

  // Step 1: Lazy mint 50 tokens
  console.log('\nLazy minting 50 tokens...')
  const nfts = Array.from({ length: 50 }, () => ({
    name: 'Notice Proof of Engagement',
    description: 'Recognized for genuine audience engagement',
  }))

  const lazyMintTx = lazyMint({
    contract,
    nfts,
  })

  const lazyMintResult = await sendAndConfirmTransaction({
    transaction: lazyMintTx,
    account,
  })

  console.log('Lazy mint transaction hash:', lazyMintResult.transactionHash)

  // Step 2: Set claim conditions
  console.log('\nSetting claim conditions...')
  const claimConditionsTx = setClaimConditions({
    contract,
    phases: [
      {
        startTime: new Date(),
        maxClaimableSupply: BigInt(50),
        price: 0,
      },
    ],
  })

  const claimConditionsResult = await sendAndConfirmTransaction({
    transaction: claimConditionsTx,
    account,
  })

  console.log('Claim conditions transaction hash:', claimConditionsResult.transactionHash)
  console.log('\nSetup complete!')
}

main().catch((err) => {
  console.error('Setup error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
  process.exit(1)
})
