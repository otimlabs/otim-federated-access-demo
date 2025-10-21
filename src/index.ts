import * as dotenv from 'dotenv';
import { hashAuthorization } from 'viem/utils';
import { TurnkeyApiClient, OtimApiClient } from './clients';

// Load environment variables
dotenv.config();

async function main() {
  try {
    console.log('Starting OTIM Federated Access Demo...');
    
    // Initialize clients
    const otimClient = new OtimApiClient();
    const turnkeyClient = new TurnkeyApiClient();
    
    // Generate random salt
    const randomSalt = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    // Fetch optimal gas fees
    const { maxBaseFeePerGas, maxPriorityFeePerGas } = await otimClient.getOptimalGasFees();

    // Build payment request
    const paymentRequestPayload = {
      completionInstructions: [
        {
          chainId: Number(process.env.OTIM_CHAIN_ID!),
          salt: randomSalt,
          maxExecutions: 1,
          actionArguments: {
            sweepERC20: {
              token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              target: process.env.OTIM_TARGET!,
              threshold: process.env.OTIM_THRESHOLD!,
              endBalance: "0x0",
              fee: {
                token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                executionFee: 0,
                maxBaseFeePerGas: maxBaseFeePerGas,
                maxPriorityFeePerGas: maxPriorityFeePerGas,
              },
            },
          },
          setEphemeralTarget: false,
        },
      ],
      instructions: [],
      metadata: {},
    };

    console.log('Building payment request...');
    const response = await otimClient.buildPaymentRequest(paymentRequestPayload);
    console.log(`Payment request built - Wallet: ${response.ephemeralWalletAddress}`);

    // Hash EIP-7702 authorization
    const delegateAddress = await otimClient.getDelegateAddress();
    const authHash = hashAuthorization({
      contractAddress: delegateAddress as `0x${string}`,
      chainId: Number(process.env.OTIM_CHAIN_ID!),
      nonce: 0,
    });

    // Create signing hash list
    const signingHashes = await otimClient.createSigningHashList(authHash, response);
    console.log(`Created ${signingHashes.length} signing hashes`);

    // Sign with Turnkey
    console.log('Signing with Turnkey...');
    const signatures = await turnkeyClient.signRawPayloads(
      process.env.TURNKEY_ORG_ID!,
      signingHashes,
      response.ephemeralWalletAddress
    );
    console.log(`Successfully signed ${signatures.length} payloads`);

    console.log('Demo completed successfully!');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}