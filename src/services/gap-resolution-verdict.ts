// Who decides whether a re-answered gap is resolved.
//
// Since #5 the System One scorer's verdict closed gaps. The acceptance replay on
// 2026-09-27 (scripts/replay-gap-decisions.ts, 60 open gaps) found it agrees
// with the 27B on only 34.6% of committed verdicts, and every disagreement goes
// one way: 34 gaps the scorer would close that the 27B considers open. Its
// question asks for "specific, confident information", and long answers that
// say the sources lack the information, or invent details, pass it. So the 27B
// decides again, and the scorer's verdict is only recorded next to it until its
// question is tuned and the replay agrees.
//
// The 27B's check reports confident: true when its reply cannot be parsed --
// the failure #5 set out to remove, since it silently closed gaps. Here an
// unparseable reply parks the gap for review instead.

import type { Decision } from "./decide.js";
import { decide } from "./decide.js";
import type { Verdict } from "./decide-config.js";
import { loadDecideConfig } from "./decide-config.js";
import { checkConfidence } from "./gap-detector.js";
import { GAP_RESOLVED_QUESTION } from "./gap-outcome.js";

export interface ResolutionVerdictDeps {
  judge: (question: string, answer: string) => Promise<{ confident: boolean; parsed: boolean }>;
  score: (question: string, answer: string) => Promise<Pick<Decision, "verdict" | "probability">>;
  log: (message: string) => void;
}

export interface ResolutionVerdict {
  verdict: Verdict;
  // The scorer's opinion, recorded only; null when it could not answer
  scorer: Pick<Decision, "verdict" | "probability"> | null;
}

// The production wiring. The scorer key is read by the caller (src/api), so
// this service does not reach back into the API layer.
export function resolutionDeps(apiKey: string | null): ResolutionVerdictDeps {
  return {
    judge: (question, answer) => checkConfidence(question, answer),
    score: (question, answer) =>
      decide(GAP_RESOLVED_QUESTION, `Question: ${question}\nAnswer: ${answer}`, {
        config: loadDecideConfig(),
        apiKey,
        fetchImpl: fetch,
      }),
    log: (message) => console.log(message),
  };
}

export async function decideResolution(
  question: string,
  answer: string,
  deps: ResolutionVerdictDeps,
): Promise<ResolutionVerdict> {
  const judged = await deps.judge(question, answer);
  const verdict: Verdict = !judged.parsed ? "review" : judged.confident ? "resolved" : "unresolved";

  // After the 27B, not alongside it: both models share the GPU and memory
  let scorer: ResolutionVerdict["scorer"] = null;
  try {
    const decision = await deps.score(question, answer);
    scorer = { verdict: decision.verdict, probability: decision.probability };
    deps.log(
      `[Gap Resolution] 27B ${verdict}, scorer ${decision.verdict} (noul ${decision.probability.toFixed(4)}) -- the 27B decides`,
    );
  } catch (err) {
    deps.log(`[Gap Resolution] 27B ${verdict}; scorer unavailable (${err instanceof Error ? err.message : String(err)})`);
  }

  return { verdict, scorer };
}
