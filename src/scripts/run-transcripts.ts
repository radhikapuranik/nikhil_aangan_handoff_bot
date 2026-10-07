import { PHONE_FIXTURES, SPEC_SUMMARY } from "../fixtures/phone-transcripts.ts";
import { runFixture } from "../fixtures/harness.ts";

const rows = PHONE_FIXTURES.map((fx) => ({ fx, r: runFixture(fx) }));

console.log("\nT01-T20: engine verdict vs expected (expected = my reading of the spec)\n");
for (const { fx, r } of rows) {
  const flag = r.finalDecision?.flags.length ? `  FLAGS: ${r.finalDecision.flags.join("; ")}` : "";
  const open = r.questionsStillOpen.length ? `  WOULD STILL ASK: ${r.questionsStillOpen.map((q) => q.split(":")[0]).join(",")}` : "";
  const price = fx.pricingQuestions ? (r.pricingOk ? "  [pricing guard: caught]" : "  [pricing guard: MISSED]") : "";
  console.log(`${fx.id}  ${r.match ? "AGREE   " : "DISAGREE"}  expected=${fx.expected.padEnd(10)} engine=${String(r.actual).padEnd(10)}${price}${open}${flag}`);
}

const tally: Record<string, number> = {};
for (const { r } of rows) tally[r.actual] = (tally[r.actual] ?? 0) + 1;
console.log("\nEngine counts:", tally);
console.log("Spec counts  :", SPEC_SUMMARY);
const mism = rows.filter(({ r }) => !r.match);
console.log(`\n${rows.length - mism.length}/${rows.length} agree with expected.`);
process.exit(mism.length ? 1 : 0);
