import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPairedDevice, verifyDeviceToken } from "../../src/infra/device-pairing.js";
import plugin from "./index.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const temporaryDirs: string[] = [];

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  for (const directory of temporaryDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("FlowOS device onboarding provisioning", () => {
  it("creates a real paired identity whose returned token passes Gateway verification", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowos-onboarding-pairing-"));
    temporaryDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const registerGatewayMethod = vi.fn();
    plugin.register({
      pluginConfig: { userId: "alice", tenantId: "tenant-a" },
      config: { gateway: { auth: {} } },
      registerGatewayMethod,
      registerTool: vi.fn(),
      runtime: {
        state: {
          openKeyedStore: () => ({ register: vi.fn(), lookup: vi.fn() }),
        },
      },
    } as never);
    const registration = registerGatewayMethod.mock.calls.find(
      ([name]) => name === "flowos.deviceOnboardingProvision",
    ) as [string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1], { scope: string }];
    expect(registration[2]).toEqual({ scope: "operator.admin" });
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyBytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const publicKeyText = publicKeyBytes.toString("base64url");
    const deviceId = createHash("sha256").update(publicKeyBytes).digest("hex");
    const request = {
      req: {} as never,
      params: {
        deviceId,
        devicePublicKey: publicKeyText,
      },
      client: {
        isDeviceTokenAuth: true,
        connect: {
          role: "operator",
          scopes: ["operator.read", "operator.write", "operator.admin"],
          device: { id: "android-owner" },
        },
      } as never,
      isWebchatConnect: () => false,
      context: {} as GatewayRequestHandlerOptions["context"],
    };
    const respond = vi.fn();
    await registration[1]({ ...request, respond });

    expect(respond.mock.calls[0][0]).toBe(true);
    const result = respond.mock.calls[0][1] as { deviceId: string; deviceToken: string };
    expect(result.deviceId).toBe(deviceId);
    await expect(getPairedDevice(deviceId)).resolves.toMatchObject({
      publicKey: publicKeyText,
      platform: "linux",
      deviceFamily: "RaspberryPi",
      clientId: "openclaw-pet",
      clientMode: "ui",
      modelIdentifier: "FlowGo",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    });
    await expect(
      verifyDeviceToken({
        deviceId: result.deviceId,
        token: result.deviceToken,
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      }),
    ).resolves.toEqual({ ok: true });

    const retried = vi.fn();
    await registration[1]({ ...request, respond: retried });
    expect(retried.mock.calls[0][0]).toBe(true);
    expect(retried.mock.calls[0][1]).toMatchObject({
      deviceId,
      deviceToken: result.deviceToken,
    });
  });
});
