const KNOWN_FIELDS = [
  "intent",
  "confidence",
  "wants_human_agent",
  "destination_country",
  "migration_objective",
  "occupation",
  "education",
  "experience_years",
  "age",
  "language_ability",
  "family_status",
  "timeline",
];

export function extractedEntitiesFromDict(data) {
  const entities = {};
  for (const field of KNOWN_FIELDS) {
    entities[field] = field in data ? data[field] : field === "confidence" ? 0 : null;
  }
  entities.intent = data.intent ?? "other";
  entities.confidence = data.confidence ?? 0;
  entities.wants_human_agent = Boolean(data.wants_human_agent);
  return entities;
}

export async function understand(llmClient, text) {
  const raw = await llmClient.extractEntities(text);
  return extractedEntitiesFromDict(raw);
}
