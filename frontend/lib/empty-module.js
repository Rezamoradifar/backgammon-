// Intentionally empty. See next.config.ts's resolveAlias comment: this
// stands in for optional `@x402/*` payment sub-packages that RainbowKit's
// bundled Coinbase Smart Wallet (Base Account) connector references but
// this app never installs, configures, or lets a user select - the x402
// payment flow is unreachable at runtime, so every export below is a stub
// that only exists to satisfy the static module graph.
function unused() {
  throw new Error("x402 payment support is not available in this build");
}

export const BatchSettlementEvmScheme = unused;
export const ExactEvmScheme = unused;
export const ExactSvmScheme = unused;
export const registerExactSvmScheme = unused;
export const registerExactEvmScheme = unused;
export const HTTPFacilitatorClient = unused;
export const UptoEvmScheme = unused;
export const bazaarResourceServerExtension = unused;
export const paymentMiddlewareFromConfig = unused;
export const paymentMiddlewareFromHTTPServer = unused;
export const toClientEvmSigner = unused;
export const wrapFetchWithPayment = unused;
export const x402Client = unused;
export const x402ResourceServer = unused;
export const x402HTTPResourceServer = unused;

const stub = {};
export default stub;
