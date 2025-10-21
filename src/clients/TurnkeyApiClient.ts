import axios from 'axios';
import { signMessage } from 'viem/accounts';
import { getAddress } from 'viem/utils';
import { stringToBase64urlString } from '@turnkey/encoding';
import { toDerSignature } from '@turnkey/crypto';

export class TurnkeyApiClient {
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

  async signRawPayloads(organizationId: string, payloads: string[], signWith: string): Promise<{ r: string; s: string; v: string }[]> {
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
      console.log('Turnkey raw signature:', sig);
      // Return the raw signature object as-is
      return {
        r: sig.r,
        s: sig.s,
        v: sig.v
      };
    });
  }
}
