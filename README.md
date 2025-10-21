# OTIM Federated Access Demo

A simple TypeScript script for calling the OTIM API endpoint `/payment/request/build`.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your environment variables

## Usage

### Development (with ts-node)
```bash
npm run dev
```

### Production (build and run)
```bash
npm run build
npm start
```

## API Call

The script makes a POST request to `/payment/request/build` with:
- Authorization header set to your API key
- Content-Type: application/json
- Request payload (currently set to example values)

Update the `PaymentRequestBuildPayload` interface and the payload object in `src/index.ts` to match your actual API requirements.
