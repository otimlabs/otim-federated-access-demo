import axios from 'axios';
import { hashTypedData, keccak256, toHex, hashAuthorization } from 'viem/utils';

export class OtimApiClient {
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
    try {
      const response = await axios.get(url, { headers: this.getHeaders() });
      
      const estimates = response.data;
      const maxPriorityFeePerGas = `0x${estimates.normalMaxPriorityFeeEstimate.toString(16)}`;
      
      return {
        maxBaseFeePerGas: '0x0',
        maxPriorityFeePerGas,
      };
    } catch (error: any) {
      console.error(`Error fetching gas fees from ${url}:`, error.response?.data || error.message);
      throw error;
    }
  }

  async getDelegateAddress(): Promise<string> {
    const url = `${this.baseUrl}/config/delegate/address/${this.chainId}`;
    try {
      const response = await axios.get(url, { headers: this.getHeaders() });
      return response.data.otimDelegateAddress;
    } catch (error: any) {
      console.error(`Error fetching delegate address from ${url}:`, error.response?.data || error.message);
      throw error;
    }
  }

  async buildPaymentRequest(payload: any): Promise<any> {
    const url = `${this.baseUrl}/payment/request/build`;
    try {
      const response = await axios.post(url, payload, { headers: this.getHeaders() });
      return response.data;
    } catch (error: any) {
      console.error(`Error building payment request at ${url}:`, error.response?.data || error.message);
      throw error;
    }
  }

  async createPaymentRequest(
    requestId: string,
    signedAuthorization: string,
    completionInstructions: any[],
    instructions: any[]
  ): Promise<any> {
    const url = `${this.baseUrl}/payment/request/new`;
    try {
      const payload = {
        requestId: requestId,
        signedAuthorization: signedAuthorization,
        completionInstructions: completionInstructions,
        instructions: instructions
      };

      console.log('Payment request payload:', JSON.stringify(payload, null, 2));
      const response = await axios.post(url, payload, { headers: this.getHeaders() });
      return response.data;
    } catch (error: any) {
      console.error(`Error creating payment request at ${url}:`, error.response?.data || error.message);
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
    // Decode the arguments to get the sweepERC20 data
    const args = instruction.arguments.slice(2); // Remove 0x prefix
    const token = '0x' + args.slice(24, 64); // Skip first 32 bytes (token)
    const target = '0x' + args.slice(64, 104); // Next 32 bytes (target)
    const threshold = BigInt('0x' + args.slice(104, 136)); // Next 32 bytes (threshold)
    const endBalance = BigInt('0x' + args.slice(136, 168)); // Next 32 bytes (endBalance)
    const feeToken = '0x' + args.slice(168, 208); // Next 32 bytes (feeToken)
    const maxBaseFeePerGas = BigInt('0x' + args.slice(208, 240)); // Next 32 bytes (maxBaseFeePerGas)
    const maxPriorityFeePerGas = BigInt('0x' + args.slice(240, 272)); // Next 32 bytes (maxPriorityFeePerGas)
    const executionFee = BigInt('0x' + args.slice(272, 304)); // Next 32 bytes (executionFee)
    
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
        { name: "sweepERC20", type: "SweepERC20" }  // Fixed: capital S
      ],
      SweepERC20: [
        { name: "token", type: "address" },
        { name: "target", type: "address" },
        { name: "threshold", type: "uint256" },
        { name: "endBalance", type: "uint256" },  // Added missing field
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
        endBalance,  // Added missing field
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
