import { writeFileSync } from "node:fs";
import { issueDeviceEventJwt } from "./index.js";

const outputPath = process.argv[2];
const secret = process.env.FLOWOS_DEVICE_EVENT_CONTRACT_SECRET ?? "";
if (!outputPath || Buffer.byteLength(secret) < 32) {
  throw new Error("contract output path and synthetic secret are required");
}

const result = await issueDeviceEventJwt(
  {
    hubDeviceId: "hub-device-1",
    tenantId: "tenant-1",
    subjectUserId: "user-1",
  },
  secret,
);
writeFileSync(outputPath, result.accessToken, { mode: 0o600 });
