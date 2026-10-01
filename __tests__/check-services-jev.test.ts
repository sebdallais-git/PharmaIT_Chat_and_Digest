import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The jev scorer moved from :8000 to :8010 and :8000 became Splash's, but check-services.sh kept
// probing 8000: with Splash up and the scorer down it reported the scorer up. Both the scorer
// (run-jev.sh) and this check now take JEV_PORT from config/host.yaml through lib/host.sh.
const script = readFileSync(join(process.cwd(), "scripts", "check-services.sh"), "utf-8");
const runJev = readFileSync(join(process.cwd(), "scripts", "run-jev.sh"), "utf-8");

describe("check-services.sh jev scorer port", () => {
  it("probes the port run-jev.sh listens on, both from the host profile", () => {
    expect(script).toMatch(/source "\$SCRIPT_DIR\/lib\/host\.sh"/);
    expect(runJev).toMatch(/source "\$SCRIPT_DIR\/lib\/host\.sh"/);
    expect(script).toMatch(/check_port "\$JEV_PORT" "jev scorer"/);
    expect(runJev).toMatch(/--port "\$JEV_PORT"/);
  });

  it("no longer parses decide.yaml for a port", () => {
    expect(script).not.toContain("decide.yaml");
  });
});
