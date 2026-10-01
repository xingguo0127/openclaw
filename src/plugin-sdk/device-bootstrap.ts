// Shared bootstrap/pairing helpers for plugins that provision remote devices.
import { createLazyRuntimeMethod } from "../shared/lazy-runtime.js";

export { approveDevicePairing } from "../infra/device-pairing-approval.js";
export { ensureDeviceToken } from "../infra/device-pairing-tokens.js";
export {
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
export {
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
  revokeDeviceBootstrapToken,
} from "../infra/device-bootstrap.js";
export {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  normalizeDeviceBootstrapProfile,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfile,
  type DeviceBootstrapProfileInput,
  type DeviceBootstrapPurpose,
} from "../shared/device-bootstrap-profile.js";

export const resolvePairingGatewayUrl = createLazyRuntimeMethod(
  () => import("../pairing/setup-code.js"),
  (pairing) => pairing.resolvePairingGatewayUrl,
);
