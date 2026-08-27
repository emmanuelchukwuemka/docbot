// Chart data for the admin dashboard — every function here returns numbers computed from
// real rows, never fabricated placeholders. Where the underlying data can't support a
// metric honestly (e.g. we only have one lead source — WhatsApp — so a multi-channel
// breakdown would be fake), that metric simply isn't offered.

import { Op } from "sequelize";
import { Lead, Conversation, MigrationProfile } from "../db/models.js";

export const FUNNEL_ORDER = ["new", "contacted", "qualified", "consultation_booked", "converted"];
export const FUNNEL_LABELS = {
  new: "New Leads",
  contacted: "Contacted",
  qualified: "Qualified",
  consultation_booked: "Consultation",
  converted: "Converted",
};

export function bucketByDay(timestamps, days) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const buckets = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const ts of timestamps) {
    const key = new Date(ts).toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }
  const ordered = [...buckets.keys()].sort();
  return ordered.map((key) => ({
    date: key,
    label: new Date(key).toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" }),
    count: buckets.get(key),
  }));
}

/** A count + sparkline + %-change-vs-previous-period for one metric. `timestamps` is every
 * occurrence's created_at (e.g. every lead's created_at). */
export function statWithTrend(timestamps, days = 7) {
  const now = Date.now();
  const currentStart = now - days * 86400000;
  const previousStart = now - 2 * days * 86400000;
  const normalized = timestamps.filter((t) => t != null).map((t) => new Date(t).getTime());

  const current = normalized.filter((t) => t >= currentStart).length;
  const previous = normalized.filter((t) => t >= previousStart && t < currentStart).length;

  let changePct;
  if (previous) changePct = Math.round((1000 * (current - previous)) / previous) / 10;
  else if (current) changePct = null;
  else changePct = 0.0;

  const sparkline = bucketByDay(normalized, days);
  return {
    count_last_period: current,
    change_pct: changePct,
    sparkline_counts: sparkline.map((b) => b.count),
  };
}

export async function conversationsTrend(days = 14) {
  const conversations = await Conversation.findAll({ attributes: ["created_at"] });
  return bucketByDay(conversations.map((c) => c.created_at), days);
}

export async function leadsTrend(days = 14) {
  const leads = await Lead.findAll({ attributes: ["created_at"] });
  return bucketByDay(leads.map((l) => l.created_at), days);
}

/** Cumulative funnel derived from each lead's CURRENT status (we don't store stage
 * history) — a lead marked "qualified" is counted as having also passed through "new" and
 * "contacted". "lost" leads are excluded from the forward funnel entirely. */
export async function leadsFunnel() {
  const orderIndex = Object.fromEntries(FUNNEL_ORDER.map((s, i) => [s, i]));
  const countsAtStage = new Array(FUNNEL_ORDER.length).fill(0);

  const leads = await Lead.findAll({ attributes: ["status"] });
  for (const lead of leads) {
    const idx = orderIndex[lead.status];
    if (idx === undefined) continue;
    for (let i = 0; i <= idx; i++) countsAtStage[i] += 1;
  }

  const top = countsAtStage[0] || 1;
  return FUNNEL_ORDER.map((stage, i) => ({
    stage,
    label: FUNNEL_LABELS[stage],
    count: countsAtStage[i],
    pct: Math.round((1000 * countsAtStage[i]) / top) / 10,
  }));
}

export async function leadsByClassification() {
  const total = await Lead.count();
  const result = [];
  for (const classification of ["HOT", "WARM", "COLD"]) {
    const count = await Lead.count({ where: { classification } });
    const pct = total ? Math.round((1000 * count) / total) / 10 : 0.0;
    result.push({ classification, count, pct });
  }
  return result;
}

export async function topMigrationPathways(limit = 5) {
  const rows = await MigrationProfile.findAll({
    where: { destination_country: { [Op.ne]: null } },
    attributes: ["destination_country", "migration_objective"],
  });
  const counts = {};
  for (const row of rows) {
    if (!row.destination_country) continue;
    const objectiveLabel = row.migration_objective
      ? row.migration_objective.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : "Unspecified";
    const label = `${row.destination_country} — ${objectiveLabel}`;
    counts[label] = (counts[label] || 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  return top.map(([label, count]) => ({ label, count, pct: Math.round((1000 * count) / total) / 10 }));
}

/** A minimal inline-SVG-friendly polyline `points` string — no charting library, no
 * external CDN, works the same offline as in production. */
export function sparklineSvgPath(counts, width = 100, height = 32) {
  if (!counts.length) return "";
  const maxVal = Math.max(...counts) || 1;
  const n = counts.length;
  const step = width / Math.max(n - 1, 1);
  return counts
    .map((c, i) => {
      const x = Math.round(i * step * 10) / 10;
      const y = Math.round((height - (c / maxVal) * (height - 4) - 2) * 10) / 10;
      return `${x},${y}`;
    })
    .join(" ");
}
