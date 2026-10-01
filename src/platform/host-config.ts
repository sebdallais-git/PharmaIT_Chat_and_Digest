// Host profile: everything tied to the machine this runs on -- service endpoints and the
// memory/concurrency limits sized for it -- read from one file, config/host.yaml.
// First piece of the Sils_Healthcare platform/ layer: imports only node:*, yaml and env-names
// (enforced by __tests__/platform-boundary.test.ts) so the folder can move as-is.
// docs/superpowers/specs/2026-09-30-host-config-seam-design.md

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readEnvWithFallback } from "../config/env-names.js";

export const ENDPOINT_NAMES = [
  "app", "mcp", "n8n", "chromadb", "neo4j", "searxng", "scorer",
  "ollama", "mlx_chat", "mlx_embed", "omlx", "splash",
] as const;
export type EndpointName = (typeof ENDPOINT_NAMES)[number];

export interface Endpoint {
  address: string;
  port: number;
  scheme: string;
  httpsPort: number | null;
}

export interface HostResources {
  mlxChat: { cacheLimitBytes: number; promptCacheBytes: number; promptConcurrency: number; decodeConcurrency: number };
  mlxEmbed: { cacheLimitBytes: number };
  scorer: { cacheLimitBytes: number };
  omlx: { ssdCacheMaxGb: number };
  ollama: { numParallel: number };
}

export interface HostConfig {
  name: string;
  address: string;
  path: string;
  endpoints: Record<EndpointName, Endpoint>;
  resources: HostResources;
}

export class HostConfigError extends Error {
  constructor(
    readonly path: string,
    readonly problems: string[],
  ) {
    super(`Invalid host config ${path}:\n  - ${problems.join("\n  - ")}`);
    this.name = "HostConfigError";
  }
}

// Hostname, IPv4 or bare IPv6. Also what keeps scripts/lib/host-env.ts output safe to eval.
const ADDRESS_PATTERN = /^[A-Za-z0-9.:-]+$/;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

// The env var that already overrode each endpoint before this file existed. Names unchanged.
const URL_OVERRIDES: Partial<Record<EndpointName, string>> = {
  ollama: "OLLAMA_URL",
  mlx_chat: "MLX_CHAT_URL",
  mlx_embed: "MLX_EMBED_URL",
  omlx: "OMLX_URL",
  splash: "SPLASH_URL",
  chromadb: "CHROMADB_URL",
  neo4j: "NEO4J_URI",
  searxng: "SEARXNG_URL",
};

const DEFAULT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "host.yaml");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every reader below records a problem and returns a placeholder instead of throwing, so one
// parse reports everything wrong with the file.
function section(raw: Record<string, unknown>, key: string, where: string, problems: string[]): Record<string, unknown> {
  const value = raw[key];
  if (isRecord(value)) return value;
  problems.push(`${where}${key} is missing or not a mapping`);
  return {};
}

function readString(raw: Record<string, unknown>, key: string, where: string, problems: string[]): string {
  const value = raw[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  problems.push(`${where}.${key} must be a non-empty string`);
  return "";
}

function readAddress(raw: Record<string, unknown>, key: string, where: string, problems: string[]): string {
  const value = raw[key];
  if (typeof value === "string" && ADDRESS_PATTERN.test(value)) return value;
  problems.push(`${where}.${key} must be a hostname or IP address, got ${JSON.stringify(value)}`);
  return "";
}

function readPort(raw: Record<string, unknown>, key: string, where: string, problems: string[]): number {
  const value = raw[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) return value;
  problems.push(`${where}.${key} must be an integer between 1 and 65535, got ${JSON.stringify(value)}`);
  return 0;
}

function readPositive(raw: Record<string, unknown>, key: string, where: string, problems: string[]): number {
  const value = raw[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  problems.push(`${where}.${key} must be a positive integer, got ${JSON.stringify(value)}`);
  return 0;
}

function readEndpoint(raw: Record<string, unknown>, where: string, hostAddress: string, problems: string[]): Endpoint {
  let scheme = "http";
  if (raw.scheme !== undefined) {
    if (typeof raw.scheme === "string" && SCHEME_PATTERN.test(raw.scheme)) scheme = raw.scheme;
    else problems.push(`${where}.scheme must be a URL scheme such as http or bolt, got ${JSON.stringify(raw.scheme)}`);
  }
  return {
    address: raw.address === undefined ? hostAddress : readAddress(raw, "address", where, problems),
    port: readPort(raw, "port", where, problems),
    scheme,
    httpsPort: raw.https_port === undefined ? null : readPort(raw, "https_port", where, problems),
  };
}

export function parseHostConfig(text: string, path: string): HostConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new HostConfigError(path, [`not valid YAML: ${err instanceof Error ? err.message : String(err)}`]);
  }
  if (!isRecord(raw)) throw new HostConfigError(path, ["expected a YAML mapping"]);

  const problems: string[] = [];
  const host = section(raw, "host", "", problems);
  const name = readString(host, "name", "host", problems);
  const address = readAddress(host, "address", "host", problems);

  const endpointsRaw = section(raw, "endpoints", "", problems);
  const endpoints: Partial<Record<EndpointName, Endpoint>> = {};
  for (const endpoint of ENDPOINT_NAMES) {
    const entry = endpointsRaw[endpoint];
    if (!isRecord(entry)) {
      problems.push(`endpoints.${endpoint} is missing`);
      continue;
    }
    endpoints[endpoint] = readEndpoint(entry, `endpoints.${endpoint}`, address, problems);
  }
  for (const key of Object.keys(endpointsRaw)) {
    if (!(ENDPOINT_NAMES as readonly string[]).includes(key)) {
      problems.push(`endpoints.${key} is not a known service (expected one of: ${ENDPOINT_NAMES.join(", ")})`);
    }
  }

  // Two services on one port is how the scorer once shadowed Splash on 8000
  const owners = new Map<number, string>();
  for (const endpoint of ENDPOINT_NAMES) {
    const entry = endpoints[endpoint];
    if (!entry) continue;
    const claims: Array<[string, number | null]> = [
      [`endpoints.${endpoint}.port`, entry.port],
      [`endpoints.${endpoint}.https_port`, entry.httpsPort],
    ];
    for (const [label, port] of claims) {
      if (port === null || port === 0) continue;
      const owner = owners.get(port);
      if (owner) problems.push(`${owner} ${port} is also claimed by ${label}`);
      else owners.set(port, label);
    }
  }

  const res = section(raw, "resources", "", problems);
  const mlxChat = section(res, "mlx_chat", "resources.", problems);
  const mlxEmbed = section(res, "mlx_embed", "resources.", problems);
  const scorer = section(res, "scorer", "resources.", problems);
  const omlx = section(res, "omlx", "resources.", problems);
  const ollama = section(res, "ollama", "resources.", problems);
  const resources: HostResources = {
    mlxChat: {
      cacheLimitBytes: readPositive(mlxChat, "cache_limit_bytes", "resources.mlx_chat", problems),
      promptCacheBytes: readPositive(mlxChat, "prompt_cache_bytes", "resources.mlx_chat", problems),
      promptConcurrency: readPositive(mlxChat, "prompt_concurrency", "resources.mlx_chat", problems),
      decodeConcurrency: readPositive(mlxChat, "decode_concurrency", "resources.mlx_chat", problems),
    },
    mlxEmbed: { cacheLimitBytes: readPositive(mlxEmbed, "cache_limit_bytes", "resources.mlx_embed", problems) },
    scorer: { cacheLimitBytes: readPositive(scorer, "cache_limit_bytes", "resources.scorer", problems) },
    omlx: { ssdCacheMaxGb: readPositive(omlx, "ssd_cache_max_gb", "resources.omlx", problems) },
    ollama: { numParallel: readPositive(ollama, "num_parallel", "resources.ollama", problems) },
  };

  if (problems.length > 0) throw new HostConfigError(path, problems);
  return { name, address, path, endpoints: endpoints as Record<EndpointName, Endpoint>, resources };
}

export function hostConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return readEnvWithFallback(env, "HOST_CONFIG") ?? DEFAULT_PATH;
}

const cache = new Map<string, HostConfig>();

// Cached per path: the file is read once per process. Edits take effect on restart, like every
// other config file the app reads at startup.
export function loadHostConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const path = hostConfigPath(env);
  const cached = cache.get(path);
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new HostConfigError(path, [`cannot read the file: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const host = parseHostConfig(text, path);
  cache.set(path, host);
  return host;
}

export function endpointUrl(host: HostConfig, name: EndpointName): string {
  const endpoint = host.endpoints[name];
  const address = endpoint.address.includes(":") ? `[${endpoint.address}]` : endpoint.address;
  return `${endpoint.scheme}://${address}:${endpoint.port}`;
}

// The URL a consumer should call: the service's existing env override when set (blank counts as
// unset), else the host file. The file is only read when no override applies. Its location always
// comes from process.env, not from `env`: callers pass a partial env to override URLs, and that
// must not silently redirect them to the default file.
export function serviceUrl(name: EndpointName, env: NodeJS.ProcessEnv = process.env, host?: HostConfig): string {
  const overrideName = URL_OVERRIDES[name];
  const override = name === "app" ? readEnvWithFallback(env, "URL") : overrideName ? env[overrideName]?.trim() : undefined;
  if (override) return override.replace(/\/+$/, "");
  return endpointUrl(host ?? loadHostConfig(), name);
}

export function hostSummary(host: HostConfig): { name: string; config: string; resources: HostResources } {
  return { name: host.name, config: host.path, resources: host.resources };
}

// PORT / HTTPS_PORT as given: a non-blank value must be an integer 1-65535; blank counts as unset.
function envPort(env: NodeJS.ProcessEnv, name: "PORT" | "HTTPS_PORT"): number | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got ${JSON.stringify(env[name])}`);
  }
  return port;
}

// The ports the app listens on: PORT / HTTPS_PORT when set, else endpoints.app in the host
// profile, which every other consumer (scripts, MCP, Hermes) also calls. httpsPort is null when
// neither names one. The profile is read only when an env port is missing; its location comes
// from process.env, as in serviceUrl.
export function appListenPorts(env: NodeJS.ProcessEnv = process.env, host?: HostConfig): { port: number; httpsPort: number | null } {
  const port = envPort(env, "PORT");
  const httpsPort = envPort(env, "HTTPS_PORT");
  if (port !== undefined && httpsPort !== undefined) return { port, httpsPort };
  const app = (host ?? loadHostConfig()).endpoints.app;
  return { port: port ?? app.port, httpsPort: httpsPort ?? app.httpsPort };
}
