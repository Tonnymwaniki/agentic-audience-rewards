/**
 * One-off script to deploy thirdweb's published DropERC721 contract
 * to Avalanche Fuji testnet using the thirdweb TypeScript SDK.
 *
 * Required env vars:
 * - THIRDWEB_SECRET_KEY: your thirdweb project secret key
 * - THIRDWEB_DEPLOYER_PRIVATE_KEY: the private key of the wallet that will deploy the contract
 *
 * Run:
 *   npx tsx scripts/deploy-contract.ts
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { createThirdwebClient } from 'thirdweb'
import { avalancheFuji } from 'thirdweb/chains'
import { deployERC721Contract } from 'thirdweb/deploys'
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
    console.error(
      'The deployer wallet private key is required because thirdweb SDK deployPublishedContract needs an account.'
    )
    console.error(
      'Alternatively, you can use the thirdweb dashboard to deploy DropERC721 without code.'
    )
    process.exit(1)
  }

  const client = createThirdwebClient({
    secretKey,
  })

  const account = privateKeyToAccount({
    client,
    privateKey,
  })

  console.log('Deploying DropERC721 to Avalanche Fuji...')
  console.log('Deployer address:', account.address)

  const address = await deployERC721Contract({
    client,
    chain: avalancheFuji,
    account,
    type: 'DropERC721',
    params: {
      name: 'Notice Proof of Engagement',
      symbol: 'NOTICE',
      defaultAdmin: '0x6495d315EdbDBfd4889CBF333332Bf23D7e5f4c1',
    },
  })

  console.log('Deployed contract address:', address)
}

main().catch((err) => {
  console.error('Deploy error:', err)
  process.exit(1)
})
