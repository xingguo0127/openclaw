// Qwen-Audio-TTS plugin entrypoint registers its OpenClaw speech provider.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildQwenAudioTtsSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "qwen-audio-tts",
  name: "Qwen-Audio-TTS Speech",
  description: "DashScope Qwen-Audio-TTS speech provider (cloned/system voices)",
  register(api) {
    api.registerSpeechProvider(buildQwenAudioTtsSpeechProvider());
  },
});
