// FR-09 Lead Qualification.
//
// Weighted-points scorer over the exact factors the PRD lists: migration intent,
// destination clarity, eligibility indicators, timeline, financial readiness, service need
// (document readiness as a proxy), and engagement level. Weights are a starting point for
// MigraTech to tune against real conversion data — they are business/marketing judgment
// calls, not immigration facts.

const TIMELINE_POINTS = {
  within_3_months: 15,
  "3_6_months": 10,
  "6_12_months": 5,
  more_than_12_months: 2,
};

const HOT_THRESHOLD = 70;
const WARM_THRESHOLD = 40;

export function scoreLead({
  profile,
  latestEligibility = null,
  documents = [],
  requiredDocumentCount = 0,
  messageCount = 0,
  requestedConsultation = false,
}) {
  let score = 0;
  const reasons = [];

  if (profile && profile.destination_country) {
    score += 15;
    reasons.push("Clear destination.");
  }

  if (profile && profile.migration_objective) {
    score += 15;
    reasons.push(`Clear migration goal (${profile.migration_objective}).`);
  }

  if (latestEligibility) {
    if (latestEligibility.result === "potentially_suitable") {
      score += 20;
      reasons.push("Preliminary assessment: potentially suitable.");
    } else if (latestEligibility.result === "more_information_required") {
      score += 10;
      reasons.push("Preliminary assessment: more information required.");
    }
  }

  if (profile && profile.timeline) {
    const points = TIMELINE_POINTS[profile.timeline] || 0;
    score += points;
    if (points) reasons.push(`Ready to begin within: ${profile.timeline.replaceAll("_", " ")}.`);
  }

  if (profile && profile.financial_readiness) {
    score += 10;
    reasons.push("Indicated financial readiness.");
  }

  if (documents.length && requiredDocumentCount > 0) {
    const ready = documents.filter((d) => ["uploaded", "verified"].includes(d.status)).length;
    const docPoints = Math.round(15 * Math.min(ready / requiredDocumentCount, 1.0));
    score += docPoints;
    if (ready) reasons.push(`Has ${ready}/${requiredDocumentCount} required documents.`);
  }

  if (messageCount) {
    score += Math.min(Math.floor(messageCount / 3), 10);
  }

  if (requestedConsultation) {
    score += 10;
    reasons.push("Requested consultation.");
  }

  score = Math.max(0, Math.min(score, 100));

  let classification;
  if (score >= HOT_THRESHOLD) classification = "HOT";
  else if (score >= WARM_THRESHOLD) classification = "WARM";
  else classification = "COLD";

  return { score, classification, reasons };
}
