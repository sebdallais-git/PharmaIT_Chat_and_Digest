// Jest runs TypeScript tests as native ES modules (package.json has "type": "module")
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  // Points PHARMAITCHAT_HOST_CONFIG at __tests__/fixtures/host.yaml before any test module loads
  setupFiles: ["<rootDir>/__tests__/setup/host-config-env.ts"],
  // The MCP service is a separate package with its own Jest setup; data/ holds scratch installs.
  // .worktrees/ holds sibling checkouts of other branches; their own tests read the script at
  // process.cwd(), which is always THIS tree, so without this they silently assert against our
  // script instead of their own and break whenever it changes.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/mcp/", "<rootDir>/data/", "<rootDir>/.worktrees/"],
  moduleNameMapper: {
    // Source files import siblings as "./x.js"; point Jest at the .ts file
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "tsconfig.test.json" }],
  },
};
