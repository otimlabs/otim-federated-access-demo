import axios, { AxiosResponse } from 'axios';
import * as dotenv from 'dotenv';
import { Turnkey } from '@turnkey/sdk-server';
import { hashAuthorization, hashTypedData, keccak256, toHex, pad } from 'viem/utils';

// Load environment variables
dotenv.config();

interface PaymentRequestBuildResponse {
  requestId: string;
  subOrgId: string;
  walletId: string;
  ephemeralWalletAddress: string;
  completionInstructions: Array<{
    address: string;
    chainId: number;
    salt: string;
    maxExecutions: string;
    action: string;
    arguments: string;
  }>;
  instructions: any[];
}

interface PaymentRequestBuildPayload {
  completionInstructions: Array<{
    chainId: number;
    salt: number;
    maxExecutions: number;
    actionArguments: {
      sweepERC20: {
        token: string;
        target: string;
        threshold: string;
        endBalance: string;
        fee: {
          token: string;
          executionFee: number;
          maxBaseFeePerGas: string;
          maxPriorityFeePerGas: string;
        };
      };
    };
    setEphemeralTarget: boolean;
  }>;
  instructions: any[];
  metadata: Record<string, any>;
}


class OtimApiClient {
  private apiUrl: string;
  private apiKey: string;
  private target: string;
  private threshold: string;
  private chainId: number;

  constructor() {
    const apiUrl = process.env.OTIM_API_URL;
    const apiKey = process.env.OTIM_API_KEY;
    const target = process.env.OTIM_TARGET;
    const threshold = process.env.OTIM_THRESHOLD;
    const chainId = process.env.OTIM_CHAIN_ID;

    if (!apiUrl) {
      throw new Error('OTIM_API_URL environment variable is required');
    }

    if (!apiKey) {
      throw new Error('OTIM_API_KEY environment variable is required');
    }

    if (!target) {
      throw new Error('OTIM_TARGET environment variable is required');
    }

    if (!threshold) {
      throw new Error('OTIM_THRESHOLD environment variable is required');
    }

    if (!chainId) {
      throw new Error('OTIM_CHAIN_ID environment variable is required');
    }

    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.target = target;
    this.threshold = threshold;
    this.chainId = parseInt(chainId, 10);
  }

  getTarget(): string {
    return this.target;
  }

  getThreshold(): string {
    return this.threshold;
  }

  getChainId(): number {
    return this.chainId;
  }


  async getDelegateAddress(): Promise<string> {
    try {
      // Get delegate address for the configured chain ID
      const response = await axios.get(
        `${this.apiUrl}/config/delegate/address/${this.chainId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.data && response.data.otimDelegateAddress) {
        console.log('Delegate address:', response.data.otimDelegateAddress);
        return response.data.otimDelegateAddress;
      } else {
        throw new Error('Invalid response structure from delegate address API');
      }
    } catch (error) {
      console.error('Failed to fetch delegate address:', error);
      throw error;
    }
  }

  async hashAuthorization(contractAddress: string): Promise<string> {
    try {
      // Use viem's hashAuthorization utility for EIP-7702
      // Nonce is always 0 for EIP-7702 authorizations
      const authHash = hashAuthorization({
        contractAddress: contractAddress as `0x${string}`,
        chainId: this.chainId,
        nonce: 0,
      });

      console.log('Authorization hash:', authHash);
      return authHash;
    } catch (error) {
      console.error('Failed to hash authorization:', error);
      throw error;
    }
  }

  async prepareEIP712Hash(delegateAddress: string, instructionData: any): Promise<string> {
    try {
      // EIP-712 Domain for OtimDelegate
      const domain = {
        chainId: this.chainId,
        name: "OtimDelegate",
        salt: keccak256(toHex("ON_TIME_INSTRUCTED_MONEY")),
        verifyingContract: delegateAddress as `0x${string}`,
        version: "1",
      } as const;

      // EIP-712 Types for SweepERC20 instruction
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

      // Parse the hex-encoded arguments to extract the sweep data
      // The arguments contain: token(32) + target(32) + threshold(32) + endBalance(32) + fee data
      const argsHex = instructionData.arguments;
      
      // Extract the sweep parameters from the hex-encoded arguments
      const token = `0x${argsHex.slice(26, 66)}` as `0x${string}`; // Skip padding, get address
      const target = `0x${argsHex.slice(90, 130)}` as `0x${string}`; // Skip padding, get address  
      const threshold = BigInt(`0x${argsHex.slice(130, 194)}`); // Get threshold
      const endBalance = BigInt(`0x${argsHex.slice(194, 258)}`); // Get endBalance
      
      // For now, use default fee values since they're not in the arguments
      const fee = {
        token: token,
        maxBaseFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
        executionFee: 0n
      };

      // Prepare the message data
      const message = {
        salt: BigInt(instructionData.salt),
        maxExecutions: BigInt(instructionData.maxExecutions),
        action: instructionData.action as `0x${string}`,
        sweepERC20: {
          token: token,
          target: target,
          threshold: threshold,
          endBalance: endBalance,
          fee: fee
        }
      };

      // Hash the typed data
      const digest = hashTypedData({
        domain,
        types,
        primaryType: "Instruction",
        message,
      });

      console.log('EIP-712 hash prepared:', digest);
      return digest;
    } catch (error) {
      console.error('Failed to prepare EIP-712 hash:', error);
      throw error;
    }
  }

  async createSigningHashList(authHash: string, paymentResponse: PaymentRequestBuildResponse): Promise<string[]> {
    try {
      const signingHashes: string[] = [];
      
      // Add the authorization hash first
      signingHashes.push(authHash);
      console.log('Added authorization hash to signing list');

      // Get delegate address for EIP-712 hashing
      const delegateAddress = await this.getDelegateAddress();

      // Process completionInstructions (they're at the top level of the response)
      if (paymentResponse.completionInstructions) {
        console.log(`Processing ${paymentResponse.completionInstructions.length} completion instructions...`);
        console.log('Completion instructions data:', JSON.stringify(paymentResponse.completionInstructions, null, 2));
        for (const instruction of paymentResponse.completionInstructions) {
          console.log('Processing instruction:', JSON.stringify(instruction, null, 2));
          const eip712Hash = await this.prepareEIP712Hash(delegateAddress, instruction);
          signingHashes.push(eip712Hash);
        }
      } else {
        console.log('No completionInstructions found in payment response');
      }

      // Process instructions (they're at the top level of the response)
      if (paymentResponse.instructions) {
        console.log(`Processing ${paymentResponse.instructions.length} instructions...`);
        for (const instruction of paymentResponse.instructions) {
          const eip712Hash = await this.prepareEIP712Hash(delegateAddress, instruction);
          signingHashes.push(eip712Hash);
        }
      }

      console.log(`Created signing hash list with ${signingHashes.length} hashes:`, signingHashes);
      return signingHashes;
    } catch (error) {
      console.error('Failed to create signing hash list:', error);
      throw error;
    }
  }


  async getOptimalGasFees(): Promise<{ maxBaseFeePerGas: string; maxPriorityFeePerGas: string }> {
    try {
      // Use OTIM's gas fee estimation endpoint for the configured chain ID
      const response = await axios.get(
        `${this.apiUrl}/instruction/estimate/max_priority_fee_per_gas/${this.chainId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Extract gas fee estimates from the response
      const estimates = response.data;
      if (estimates && estimates.normalMaxPriorityFeeEstimate) {
        // Use the normal estimate for balanced speed/cost
        const maxPriorityFeePerGas = `0x${estimates.normalMaxPriorityFeeEstimate.toString(16)}`;
        console.log('Available gas fee estimates:', {
          slow: estimates.slowMaxPriorityFeeEstimate,
          normal: estimates.normalMaxPriorityFeeEstimate,
          fast: estimates.fastMaxPriorityFeeEstimate
        });
        console.log('Using normal estimate:', maxPriorityFeePerGas);
        
        return {
          maxBaseFeePerGas: "0x0",
          maxPriorityFeePerGas: maxPriorityFeePerGas
        };
      } else {
        throw new Error('Invalid response structure from OTIM gas fee API');
      }
    } catch (error) {
      console.error('Failed to fetch optimal gas fees from OTIM API:', error);
      throw error;
    }
  }

  async buildPaymentRequest(payload: PaymentRequestBuildPayload): Promise<PaymentRequestBuildResponse> {
    try {
      const response: AxiosResponse<PaymentRequestBuildResponse> = await axios.post(
        `${this.apiUrl}/payment/request/build`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('API Error:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
        });
        throw new Error(`API request failed: ${error.response?.status} ${error.response?.statusText}`);
      }
      throw error;
    }
  }

}

async function main() {
  try {
    console.log('Initializing OTIM API client...');
    const client = new OtimApiClient();
    
    // Initialize Turnkey client
    const turnkey = new Turnkey({
      defaultOrganizationId: process.env.TURNKEY_ORG_ID!,
      apiBaseUrl: "https://api.turnkey.com",
      apiPrivateKey: process.env.OTIM_DEV_PRIVATE_KEY!,
      apiPublicKey: process.env.OTIM_DEV_PUBLIC_KEY!,
    });
    
    const apiClient = turnkey.apiClient();

    // Generate a random salt
    const randomSalt = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

    // Fetch current optimal gas fees from OTIM API
    console.log('Fetching optimal gas fees from OTIM API...');
    const gasFees = await client.getOptimalGasFees();
    console.log('Using gas fees:', gasFees);

    // Payment request build payload
    const payload: PaymentRequestBuildPayload = {
      completionInstructions: [
        {
          chainId: client.getChainId(),
          salt: randomSalt,
          maxExecutions: 1,
          actionArguments: {
            sweepERC20: {
              token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              target: client.getTarget(),
              threshold: client.getThreshold(),
              endBalance: "0x0",
              fee: {
                token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                executionFee: 0,
                maxBaseFeePerGas: gasFees.maxBaseFeePerGas,
                maxPriorityFeePerGas: gasFees.maxPriorityFeePerGas
              }
            }
          },
          setEphemeralTarget: false
        }
      ],
      instructions: [],
      metadata: {}
    };

    console.log('Calling /payment/request/build endpoint...');
    console.log('Payload:', JSON.stringify(payload, null, 2));

    const response = await client.buildPaymentRequest(payload);

    console.log('Response received:');
    console.log(JSON.stringify(response, null, 2));

    // Hash authorization for EIP-7702 after payment request
    console.log('Hashing authorization for EIP-7702...');
    
    // Get delegate address from OTIM API
    const delegateAddress = await client.getDelegateAddress();
    
    // Hash the authorization using viem's utility
    const authHash = await client.hashAuthorization(delegateAddress);
    console.log('Authorization hashed successfully:', authHash);

    // Create complete signing hash list
    console.log('Creating signing hash list...');
    const signingHashes = await client.createSigningHashList(authHash, response);
    console.log('Signing hash list created successfully with', signingHashes.length, 'hashes');

    // Sign the raw payloads with Turnkey
    console.log('Signing raw payloads with Turnkey...');
    
    const signatureResponse = await apiClient.signRawPayloads({
      payloads: signingHashes,
      organizationId: response.subOrgId,
      signWith: response.ephemeralWalletAddress,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    });
    
    const signatures = signatureResponse.signatures?.map((sig: any) => sig.r + sig.s.slice(2) + sig.v.slice(2)) || [];
    console.log('Successfully signed all payloads:', signatures);

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}
