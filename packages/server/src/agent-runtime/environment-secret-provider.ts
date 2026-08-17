import type { SecretProvider } from "./contracts.js";

export function createEnvironmentSecretProvider(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SecretProvider {
  return Object.freeze({
    getSecret(name: "OPENAI_API_KEY"): string | undefined {
      const value = environment[name];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
  });
}
