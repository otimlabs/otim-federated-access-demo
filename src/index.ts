import axios, { AxiosResponse } from 'axios';
import * as dotenv from 'dotenv';
import { hashTypedData, keccak256, toHex, pad, hashAuthorization, getAddress } from 'viem/utils';
import { signMessage } from 'viem/accounts';
import { stringToBase64urlString } from '@turnkey/encoding';
import { toDerSignature } from '@turnkey/crypto';

// Load environment variables
dotenv.config();

// Direct Turnkey API client with SECP256K1 signing
class TurnkeyApiClient {
  private baseUrl = "https://api.turnkey.com";
  private apiPublicKey: string;
  private apiPrivateKey: string;

  constructor() {
    this.apiPublicKey = process.env.OTIM_DEV_PUBLIC_KEY!;
    this.apiPrivateKey = process.env.OTIM_DEV_PRIVATE_KEY!;
  }

  private async createStamp(payload: string): Promise<string> {
    // Ensure private key has 0x prefix for viem
    const privateKey = this.apiPrivateKey.startsWith('0x') 
      ? this.apiPrivateKey as `0x${string}`
      : `0x${this.apiPrivateKey}` as `0x${string}`;
    
    // Use viem's signMessage for EIP-191 SECP256K1 signing
    const signature = await signMessage({
      message: payload,
      privateKey: privateKey,
    });
    
    // Convert signature to DER format using Turnkey's utility
    const derSignature = toDerSignature(signature.replace("0x", ""));
    
    // Create stamp with EIP-191 scheme
    const stamp = {
      publicKey: this.apiPublicKey.startsWith('0x') 
        ? this.apiPublicKey.slice(2)
        : this.apiPublicKey,
      scheme: "SIGNATURE_SCHEME_TK_API_SECP256K1_EIP191",
      signature: derSignature,
    };
    
    // Use Turnkey's stringToBase64urlString for proper encoding
    return stringToBase64urlString(JSON.stringify(stamp));
  }

  async signRawPayloads(organizationId: string, payloads: string[], signWith: string): Promise<string[]> {
    // Convert address to EIP-55 checksummed format (Turnkey requires this)
    const checksummedAddress = getAddress(signWith);
    
    const requestPayload = {
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOADS",
      timestampMs: String(Date.now()),
      organizationId,
      parameters: {
        signWith: checksummedAddress,
        payloads,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NO_OP"
      }
    };

    const payloadString = JSON.stringify(requestPayload);
    const stamp = await this.createStamp(payloadString);
    
    const response = await axios.post(
      `${this.baseUrl}/public/v1/submit/sign_raw_payloads`,
      requestPayload,
      {
        headers: {
          'X-Stamp': stamp,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      }
    );
    
    // Extract signatures from response
    const signatures = response.data.activity.result.signRawPayloadsResult.signatures;
    return signatures.map((sig: any) => {
      const r = sig.r.slice(2); // Remove 0x prefix
      const s = sig.s.slice(2); // Remove 0x prefix
      const v = sig.v.toString(16).padStart(2, '0'); // Convert to hex and pad
      return r + s + v;
    });
  }
}

// OTIM API client
class OtimApiClient {
  private baseUrl: string;
  private apiKey: string;
  private chainId: number;

  constructor() {
    this.baseUrl = process.env.OTIM_API_URL!;
    this.apiKey = process.env.OTIM_API_KEY!;
    this.chainId = Number(process.env.OTIM_CHAIN_ID!);
  }

  private getHeaders() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async getOptimalGasFees(): Promise<{ maxBaseFeePerGas: string; maxPriorityFeePerGas: string }> {
    const url = `${this.baseUrl}/instruction/estimate/max_priority_fee_per_gas/${this.chainId}`;
    const response = await axios.get(url, { headers: this.getHeaders() });
    
    const estimates = response.data;
    const maxPriorityFeePerGas = `0x${estimates.normalMaxPriorityFeeEstimate.toString(16)}`;
    
    return {
      maxBaseFeePerGas: '0x0',
      maxPriorityFeePerGas,
    };
  }

  async getDelegateAddress(): Promise<string> {
    const response = await axios.get(
      `${this.baseUrl}/config/delegate/address/${this.chainId}`,
      { headers: this.getHeaders() }
    );
    console.log('Delegate address response:', response.data);
    return response.data.otimDelegateAddress;
  }

  async buildPaymentRequest(payload: any): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/payment/request/build`,
        payload,
        { headers: this.getHeaders() }
      );
      return response.data;
    } catch (error: any) {
      console.error('Error building payment request:', error.response?.data || error.message);
      throw error;
    }
  }

  async createSigningHashList(authHash: string, paymentResponse: any): Promise<string[]> {
    const hashes = [authHash];
    
    // Get delegate address once and reuse it
    const delegateAddress = await this.getDelegateAddress();
    
    // Add EIP-712 hashes for completion instructions
    if (paymentResponse.completionInstructions) {
      for (const instruction of paymentResponse.completionInstructions) {
        const eip712Hash = await this.hashCompletionInstruction(instruction, delegateAddress);
        hashes.push(eip712Hash);
      }
    }
    
    // Add EIP-712 hashes for regular instructions
    if (paymentResponse.instructions) {
      for (const instruction of paymentResponse.instructions) {
        const eip712Hash = await this.hashCompletionInstruction(instruction, delegateAddress);
        hashes.push(eip712Hash);
      }
    }
    
    return hashes;
  }

  private async hashCompletionInstruction(instruction: any, delegateAddress: string): Promise<string> {
    
    console.log('Instruction to hash:', JSON.stringify(instruction, null, 2));
    
    // Decode the arguments to get the sweepERC20 data
    // The arguments are ABI-encoded: token, target, threshold, endBalance, feeToken, maxBaseFeePerGas, maxPriorityFeePerGas, executionFee
    const args = instruction.arguments.slice(2); // Remove 0x prefix
    const token = '0x' + args.slice(24, 64); // Skip first 32 bytes (token)
    const target = '0x' + args.slice(64, 104); // Next 32 bytes (target)
    const threshold = BigInt('0x' + args.slice(104, 136)); // Next 32 bytes (threshold)
    const endBalance = BigInt('0x' + args.slice(136, 168)); // Next 32 bytes (endBalance)
    const feeToken = '0x' + args.slice(168, 208); // Next 32 bytes (feeToken)
    const maxBaseFeePerGas = BigInt('0x' + args.slice(208, 240)); // Next 32 bytes (maxBaseFeePerGas)
    const maxPriorityFeePerGas = BigInt('0x' + args.slice(240, 272)); // Next 32 bytes (maxPriorityFeePerGas)
    const executionFee = BigInt('0x' + args.slice(272, 304)); // Next 32 bytes (executionFee)
    
    console.log('Decoded arguments:', {
      token,
      target,
      threshold: threshold.toString(),
      endBalance: endBalance.toString(),
      feeToken,
      maxBaseFeePerGas: maxBaseFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      executionFee: executionFee.toString()
    });
    
    const domain = {
      chainId: instruction.chainId,
      name: "OtimDelegate",
      salt: keccak256(toHex("ON_TIME_INSTRUCTED_MONEY")),
      verifyingContract: delegateAddress as `0x${string}`,
      version: "1",
    } as const;

    const types = {
      Instruction: [
        { name: "salt", type: "uint256" },
        { name: "maxExecutions", type: "uint256" },
        { name: "action", type: "address" },
        { name: "sweepERC20", type: "SweepERC20" }
      ],
      SweepERC20: [
        { name: "token", type: "address" },
        { name: "target", type: "address" },
        { name: "threshold", type: "uint256" },
        { name: "endBalance", type: "uint256" },
        { name: "fee", type: "Fee" }
      ],
      Fee: [
        { name: "token", type: "address" },
        { name: "maxBaseFeePerGas", type: "uint256" },
        { name: "maxPriorityFeePerGas", type: "uint256" },
        { name: "executionFee", type: "uint256" }
      ]
    } as const;

    const message = {
      salt: BigInt(instruction.salt),
      maxExecutions: BigInt(instruction.maxExecutions),
      action: instruction.action as `0x${string}`,
      sweepERC20: {
        token: token as `0x${string}`,
        target: target as `0x${string}`,
        threshold,
        endBalance,
        fee: {
          token: feeToken as `0x${string}`,
          maxBaseFeePerGas,
          maxPriorityFeePerGas,
          executionFee
        }
      }
    };

    return hashTypedData({ domain, types, primaryType: "Instruction", message });
  }
}

async function main() {
  try {
    console.log('🚀 Starting OTIM Federated Access Demo...');
    
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

    console.log('📝 Building payment request...');
    const response = await otimClient.buildPaymentRequest(paymentRequestPayload);
    console.log(`✅ Payment request built - Wallet: ${response.ephemeralWalletAddress}`);

    // Hash EIP-7702 authorization
    const delegateAddress = await otimClient.getDelegateAddress();
    const authHash = hashAuthorization({
      contractAddress: delegateAddress as `0x${string}`,
      chainId: Number(process.env.OTIM_CHAIN_ID!),
      nonce: 0,
    });

    // Create signing hash list
    const signingHashes = await otimClient.createSigningHashList(authHash, response);
    console.log(`📋 Created ${signingHashes.length} signing hashes`);

    // Sign with Turnkey
    console.log('✍️ Signing with Turnkey...');
    const signatures = await turnkeyClient.signRawPayloads(
      process.env.TURNKEY_ORG_ID!,
      signingHashes,
      response.ephemeralWalletAddress
    );
    console.log(`✅ Successfully signed ${signatures.length} payloads`);

    console.log('🎉 Demo completed successfully!');

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}