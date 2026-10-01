// Jest runs TypeScript tests as native ES modules (package.json has "type": "module")
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  // Same fixture host profile as the app's tests (the MCP config reads src/platform/host-config.ts)
  setupFiles: ["<rootDir>/../__tests__/setup/host-config-env.ts"],
  moduleNameMapper: {
    // Source files import siblings as "./x.js"; point Jest at the .ts file
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "tsconfig.json" }],
  },
};
