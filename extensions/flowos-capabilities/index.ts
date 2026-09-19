import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCapabilityTool, trustedEndpoint } from "./tool.js";

export default definePluginEntry({
  id: "flowos-capabilities", name: "FlowOS Capabilities",
  description: "Shared capability discovery and read invocation",
  register(api) {
    const endpoint = trustedEndpoint(process.env.ASSIST_API_BASE);
    const token = (process.env.PROACTIVE_AGENT_TOKEN || "").trim();
    api.registerTool(() => createCapabilityTool(endpoint, token), { name: "flowos_capability" });
  },
});
