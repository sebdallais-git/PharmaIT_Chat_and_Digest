// Every Jest process reads the fixture host profile, never config/host.yaml: tests must not
// depend on the machine they run on. Child processes spawned with { ...process.env } inherit it;
// tests that build their own env add hostTestEnv() from __tests__/helpers/host-env.ts.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PHARMAITCHAT_HOST_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "host.yaml");
