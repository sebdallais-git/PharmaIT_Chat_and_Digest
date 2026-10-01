import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHostConfig } from "../../src/platform/host-config.js";
import { bearerToken, isLoopbackAddress, isLoopbackHost, loadConfig, tokensMatch } from "../src/config.js";

describe("loadConfig", () => {
  it("uses local defaults", () => {
    expect(loadConfig({})).toEqual({
      port: 3200,
      host: "127.0.0.1",
      mcpToken: null,
      pharmaitchatUrl: "http://localhost:3000",
      pharmaitchatToken: null,
    });
  });

  it("reads overrides and trims the PharmaITChat URL", () => {
    const config = loadConfig({
      MCP_PORT: "4100",
      MCP_HOST: "0.0.0.0",
      MCP_TOKEN: " agent-secret ",
      PHARMALLM_URL: "http://model-mac.local:3000/",
      PHARMALLM_API_TOKEN: "app-secret",
    });
    expect(config).toEqual({
      port: 4100,
      host: "0.0.0.0",
      mcpToken: "agent-secret",
      pharmaitchatUrl: "http://model-mac.local:3000",
      pharmaitchatToken: "app-secret",
    });
  });

  it("prefers the renamed PHARMAITCHAT_* env vars over the legacy PHARMALLM_* ones", () => {
    const config = loadConfig({
      PHARMAITCHAT_URL: "http://new-mac.local:3000/",
      PHARMAITCHAT_API_TOKEN: "new-secret",
      PHARMALLM_URL: "http://old-mac.local:3000/",
      PHARMALLM_API_TOKEN: "old-secret",
    });
    expect(config.pharmaitchatUrl).toBe("http://new-mac.local:3000");
    expect(config.pharmaitchatToken).toBe("new-secret");
  });

  it("refuses a non-loopback host without MCP_TOKEN", () => {
    expect(() => loadConfig({ MCP_HOST: "0.0.0.0" })).toThrow(
      "MCP_TOKEN is required when MCP_HOST (0.0.0.0) is not a loopback address"
    );
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ MCP_PORT: "nope" })).toThrow('Invalid MCP_PORT "nope"');
  });
});

describe("loopback helpers", () => {
  it("recognizes loopback hosts and addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("100.69.110.112")).toBe(false);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("192.168.50.10")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("token helpers", () => {
  it("extracts a bearer token", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
    expect(bearerToken("Basic abc123")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("compares tokens of any length safely", () => {
    expect(tokensMatch("secret", "secret")).toBe(true);
    expect(tokensMatch("secret", "secreT")).toBe(false);
    expect(tokensMatch("secret", "much-longer-secret")).toBe(false);
  });
});

describe("loadConfig reads the host profile", () => {
  const fixture = readFileSync(join(process.cwd(), "..", "__tests__", "fixtures", "host.yaml"), "utf-8");

  it("takes the MCP port and the app URL from it", () => {
    const host = parseHostConfig(
      fixture.replace("mcp:       { port: 3200", "mcp:       { port: 3300").replace("app:       { port: 3000", "app:       { port: 3100"),
      "t.yaml",
    );
    const config = loadConfig({}, host);
    expect(config.port).toBe(3300);
    expect(config.host).toBe("127.0.0.1");
    expect(config.pharmaitchatUrl).toBe("http://localhost:3100");
  });
});
