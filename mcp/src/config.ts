// Environment configuration for the PharmaITChat MCP service

import { createHash, timingSafeEqual } from "node:crypto";
// The MCP service is a separate package but shares the app's env-name fallback: both read the same
// PHARMAITCHAT_* env vars (falling back to the legacy PHARMALLM_* names) for the app's URL and token.
import { readEnvWithFallback } from "../../src/config/env-names.js";
import { loadHostConfig, serviceUrl } from "../../src/platform/host-config.js";
import type { HostConfig } from "../../src/platform/host-config.js";

export interface McpConfig {
  port: number;
  host: string;
  mcpToken: string | null;
  pharmaitchatUrl: string;
  pharmaitchatToken: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

export function bearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Hash both sides first so timingSafeEqual always compares equal-length buffers
export function tokensMatch(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

// Port, bind address and the app's URL default to config/host.yaml; MCP_PORT, MCP_HOST and
// PHARMAITCHAT_URL (legacy PHARMALLM_URL) still win
export function loadConfig(env: NodeJS.ProcessEnv = process.env, host?: HostConfig): McpConfig {
  const profile = (): HostConfig => host ?? loadHostConfig();
  const port = Number(env.MCP_PORT ?? String(profile().endpoints.mcp.port));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid MCP_PORT "${env.MCP_PORT}"`);
  }

  const bindHost = env.MCP_HOST ?? profile().endpoints.mcp.address;
  const mcpToken = env.MCP_TOKEN?.trim() || null;
  if (!isLoopbackHost(bindHost) && !mcpToken) {
    throw new Error(`MCP_TOKEN is required when MCP_HOST (${bindHost}) is not a loopback address`);
  }

  return {
    port,
    host: bindHost,
    mcpToken,
    pharmaitchatUrl: serviceUrl("app", env, host),
    pharmaitchatToken: readEnvWithFallback(env, "API_TOKEN") ?? null,
  };
}
