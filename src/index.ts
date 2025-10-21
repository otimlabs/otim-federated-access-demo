import * as dotenv from 'dotenv';
import { hashAuthorization, toRlp, toHex } from 'viem/utils';
import { parseSignature, parseCompactSignature } from 'viem';
import { TurnkeyApiClient, OtimApiClient } from './clients';

// Load environment variables
dotenv.config();

/**
 * EIP-2098 Signature format (compact)
 */
interface EIP2098Signature {
  yParity: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

/**
 * Converts a standard signature to EIP-2098 format
 */
const formatSignatureToEIP2098 = (signature: {
  v: string;
  r: string;
  s: string;
}): EIP2098Signature => {
  const ensureHexPrefix = (value: string): `0x${string}` =>
    value.startsWith("0x") ? (value as `0x${string}`) : `0x${value}`;

  // Normalize v to EIP-2098 yParity (0 or 1)
  const vNum = Number.parseInt(signature.v, 16);
  const yParity = (() => {
    if (Number.isNaN(vNum)) return 0;
    // v in {0,1} already parity; v in {27,28} -> 27->0, 28->1; v>=35 -> v%2
    if (vNum <= 1) return vNum;
    return vNum % 2 === 0 ? 1 : 0;
  })();

  return {
    yParity,
    r: ensureHexPrefix(signature.r),
    s: ensureHexPrefix(signature.s),
  };
};

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
              token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
              target: process.env.OTIM_TARGET!,
              threshold: process.env.OTIM_THRESHOLD!,
              endBalance: "0x0",
              fee: {
                token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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
      chainId: 0,
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

    // Prepare data for /payment/request/new endpoint
    const firstSignature = signatures[0];
    console.log('First signature:', firstSignature);
    
    // Format the signature to EIP-2098 format
    const { yParity, r, s } = formatSignatureToEIP2098(firstSignature);
    console.log('Formatted signature:', { yParity, r, s });
    
    // Create RLP-encoded signedAuthorization using formatted signature components
    const signedAuthorization = toRlp([
      "0x",
      delegateAddress as `0x${string}`,
      "0x", // nonce is always 0 for EIP-7702
      yParity === 0 ? "0x" : toHex(yParity),
      r,
      s,
    ] as const);
    const remainingSignatures = signatures.slice(1); // Rest are instruction signatures

    // Add activation signatures to completion instructions
    const completionInstructionsWithSignatures = response.completionInstructions.map((instruction: any, index: number) => {
      const sig = remainingSignatures[index];
      const { yParity, r, s } = formatSignatureToEIP2098(sig);
      
      return {
        ...instruction,
        activationSignature: {
          r,
          s,
          yParity
        }
      };
    });

    // Add activation signatures to regular instructions (if any)
    const instructionsWithSignatures = (response.instructions || []).map((instruction: any, index: number) => {
      const sig = remainingSignatures[response.completionInstructions.length + index];
      const { yParity, r, s } = formatSignatureToEIP2098(sig);
      
      return {
        ...instruction,
        activationSignature: {
          r,
          s,
          yParity
        }
      };
    });

    // Create payment request
    console.log('Creating payment request...');
    const newPaymentRequest = await otimClient.createPaymentRequest(
      response.requestId,
      signedAuthorization,
      completionInstructionsWithSignatures,
      instructionsWithSignatures
    );
    console.log('Payment request created successfully');
    console.log('Payment request response:', JSON.stringify(newPaymentRequest, null, 2));

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