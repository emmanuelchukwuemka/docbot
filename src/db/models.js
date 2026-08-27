import { DataTypes } from "sequelize";
import { sequelize } from "./sequelize.js";

const uuidPk = {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
};

function touchUpdatedAt(instance) {
  if (instance.changed && instance.rawAttributes?.updated_at) {
    instance.updated_at = new Date();
  }
}

// MariaDB (unlike real MySQL) implements JSON columns as TEXT-with-a-check-constraint
// under the hood, so the mysql2 driver reports them back as plain strings rather than
// pre-parsed objects/arrays — Sequelize's built-in JSON type assumes the driver already
// parsed it, so without this every JSON field would come back as a raw string (and things
// like `{...conversation.context}` would spread a string's characters instead of its keys).
// This get() is dialect-agnostic: it passes real MySQL's already-parsed values through
// untouched, and JSON.parses MariaDB's stringified ones.
function jsonColumn(fieldName, defaultValue, extra = {}) {
  return {
    type: DataTypes.JSON,
    defaultValue,
    ...extra,
    get() {
      const raw = this.getDataValue(fieldName);
      if (raw == null) return raw;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    },
  };
}

export const User = sequelize.define(
  "User",
  {
    ...uuidPk,
    whatsapp_number: { type: DataTypes.STRING(32), unique: true, allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: true },
    email: { type: DataTypes.STRING(255), allowNull: true },
    location: { type: DataTypes.STRING(255), allowNull: true },
    consent_given: { type: DataTypes.BOOLEAN, defaultValue: false },
    consent_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "users", timestamps: false }
);

export const MigrationProfile = sequelize.define(
  "MigrationProfile",
  {
    ...uuidPk,
    user_id: { type: DataTypes.UUID, allowNull: false, unique: true },
    destination_country: { type: DataTypes.STRING(120), allowNull: true },
    migration_objective: { type: DataTypes.STRING(50), allowNull: true },
    age: { type: DataTypes.INTEGER, allowNull: true },
    education: { type: DataTypes.STRING(120), allowNull: true },
    occupation: { type: DataTypes.STRING(120), allowNull: true },
    experience_years: { type: DataTypes.INTEGER, allowNull: true },
    language_ability: { type: DataTypes.STRING(255), allowNull: true },
    family_status: { type: DataTypes.STRING(255), allowNull: true },
    timeline: { type: DataTypes.STRING(50), allowNull: true },
    financial_readiness: { type: DataTypes.STRING(50), allowNull: true },
    job_offer_status: { type: DataTypes.BOOLEAN, allowNull: true },
    professional_registration: { type: DataTypes.BOOLEAN, allowNull: true },
    updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "migration_profiles", timestamps: false, hooks: { beforeUpdate: touchUpdatedAt } }
);

export const Country = sequelize.define(
  "Country",
  {
    ...uuidPk,
    name: { type: DataTypes.STRING(120), unique: true, allowNull: false },
    code: { type: DataTypes.STRING(8), unique: true, allowNull: false },
    employment_considerations: { type: DataTypes.TEXT, allowNull: true },
    study_considerations: { type: DataTypes.TEXT, allowNull: true },
    family_considerations: { type: DataTypes.TEXT, allowNull: true },
    permanent_residency_considerations: { type: DataTypes.TEXT, allowNull: true },
    official_resources: jsonColumn("official_resources", []),
  },
  { tableName: "countries", timestamps: false }
);

export const Pathway = sequelize.define(
  "Pathway",
  {
    ...uuidPk,
    country_id: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    category: { type: DataTypes.STRING(50), allowNull: false },
    eligibility_criteria: jsonColumn("eligibility_criteria", {}),
    requirements: jsonColumn("requirements", []),
    documents: jsonColumn("documents", []),
    government_fees: { type: DataTypes.STRING(255), allowNull: true },
    service_fees: { type: DataTypes.STRING(255), allowNull: true },
    typical_processing_time: { type: DataTypes.STRING(120), allowNull: true },
    language_requirements: { type: DataTypes.STRING(255), allowNull: true },
    summary: { type: DataTypes.TEXT, allowNull: true },
    source_url: { type: DataTypes.STRING(500), allowNull: true },
    last_verified_at: { type: DataTypes.DATE, allowNull: true },
    version: { type: DataTypes.STRING(20), defaultValue: "0.1-sample" },
    is_verified_content: { type: DataTypes.BOOLEAN, defaultValue: false },
  },
  { tableName: "pathways", timestamps: false }
);

export const FAQ = sequelize.define(
  "FAQ",
  {
    ...uuidPk,
    question: { type: DataTypes.STRING(500), allowNull: false },
    answer: { type: DataTypes.TEXT, allowNull: false },
    category: { type: DataTypes.STRING(120), allowNull: true },
    source_url: { type: DataTypes.STRING(500), allowNull: true },
    last_verified_at: { type: DataTypes.DATE, allowNull: true },
    is_verified_content: { type: DataTypes.BOOLEAN, defaultValue: false },
  },
  { tableName: "faqs", timestamps: false }
);

export const Lead = sequelize.define(
  "Lead",
  {
    ...uuidPk,
    user_id: { type: DataTypes.UUID, allowNull: false },
    score: { type: DataTypes.INTEGER, defaultValue: 0 },
    classification: { type: DataTypes.STRING(20), defaultValue: "COLD" },
    reasons: jsonColumn("reasons", []),
    status: { type: DataTypes.STRING(30), defaultValue: "new" },
    assigned_agent: { type: DataTypes.STRING(255), allowNull: true },
    source: { type: DataTypes.STRING(50), defaultValue: "whatsapp" },
    conversion_status: { type: DataTypes.STRING(30), defaultValue: "open" },
    last_reminder_sent_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "leads", timestamps: false, hooks: { beforeUpdate: touchUpdatedAt } }
);

export const Document = sequelize.define(
  "Document",
  {
    ...uuidPk,
    user_id: { type: DataTypes.UUID, allowNull: false },
    document_type: { type: DataTypes.STRING(120), allowNull: false },
    file_location: { type: DataTypes.STRING(500), allowNull: true },
    original_filename: { type: DataTypes.STRING(255), allowNull: true },
    mime_type: { type: DataTypes.STRING(120), allowNull: true },
    whatsapp_media_id: { type: DataTypes.STRING(255), allowNull: true },
    status: { type: DataTypes.STRING(30), defaultValue: "missing" },
    verification_status: { type: DataTypes.STRING(30), defaultValue: "unreviewed" },
    verified_by: { type: DataTypes.STRING(255), allowNull: true },
    uploaded_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "documents", timestamps: false }
);

export const Conversation = sequelize.define(
  "Conversation",
  {
    ...uuidPk,
    user_id: { type: DataTypes.UUID, allowNull: false },
    state: { type: DataTypes.STRING(50), defaultValue: "welcome" },
    intent: { type: DataTypes.STRING(50), allowNull: true },
    escalation_status: { type: DataTypes.STRING(30), defaultValue: "none" },
    escalation_reason: { type: DataTypes.STRING(255), allowNull: true },
    ai_confidence_last: { type: DataTypes.FLOAT, allowNull: true },
    fallback_count: { type: DataTypes.INTEGER, defaultValue: 0 },
    context: jsonColumn("context", {}),
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "conversations", timestamps: false, hooks: { beforeUpdate: touchUpdatedAt } }
);

export const Message = sequelize.define(
  "Message",
  {
    ...uuidPk,
    conversation_id: { type: DataTypes.UUID, allowNull: false },
    direction: { type: DataTypes.STRING(10), allowNull: false },
    sender: { type: DataTypes.STRING(20), allowNull: false },
    text: { type: DataTypes.TEXT, allowNull: false },
    raw_payload: jsonColumn("raw_payload", undefined, { allowNull: true }),
    // Baileys resolves sendMessage() as soon as WhatsApp *accepts* an outbound message —
    // actual delivery is a separate async ack that can come back with an error (e.g. the
    // recipient's client rejected it, or WhatsApp throttled the sender). whatsapp_message_id
    // lets that later ack be matched back to this row so delivery_status can be corrected
    // from an unverified default to "failed" instead of silently staying a false "sent".
    whatsapp_message_id: { type: DataTypes.STRING(64), allowNull: true },
    delivery_status: { type: DataTypes.STRING(20), allowNull: true },
    delivery_error: { type: DataTypes.STRING(255), allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "messages", timestamps: false }
);

export const Application = sequelize.define(
  "Application",
  {
    ...uuidPk,
    user_id: { type: DataTypes.UUID, allowNull: false },
    pathway_id: { type: DataTypes.UUID, allowNull: true },
    stage: { type: DataTypes.STRING(50), defaultValue: "profile_assessment" },
    status: { type: DataTypes.STRING(30), defaultValue: "in_progress" },
    assigned_specialist: { type: DataTypes.STRING(255), allowNull: true },
    milestones: jsonColumn("milestones", {}),
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "applications", timestamps: false, hooks: { beforeUpdate: touchUpdatedAt } }
);

export const EligibilityAssessment = sequelize.define(
  "EligibilityAssessment",
  {
    ...uuidPk,
    user_id: { type: DataTypes.UUID, allowNull: false },
    pathway_id: { type: DataTypes.UUID, allowNull: true },
    result: { type: DataTypes.STRING(30), allowNull: false },
    reasons: jsonColumn("reasons", []),
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "eligibility_assessments", timestamps: false }
);

export const ConsultationBooking = sequelize.define(
  "ConsultationBooking",
  {
    ...uuidPk,
    user_id: { type: DataTypes.UUID, allowNull: false },
    conversation_id: { type: DataTypes.UUID, allowNull: true },
    preferred_time_text: { type: DataTypes.STRING(255), allowNull: true },
    contact_email: { type: DataTypes.STRING(255), allowNull: true },
    status: { type: DataTypes.STRING(30), defaultValue: "requested" },
    staff_reminder_sent_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "consultation_bookings", timestamps: false, hooks: { beforeUpdate: touchUpdatedAt } }
);

export const AdminUser = sequelize.define(
  "AdminUser",
  {
    ...uuidPk,
    username: { type: DataTypes.STRING(120), unique: true, allowNull: false },
    password_hash: { type: DataTypes.STRING(255), allowNull: false },
    role: { type: DataTypes.STRING(20), defaultValue: "agent" },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "admin_users", timestamps: false }
);

export const AuditLog = sequelize.define(
  "AuditLog",
  {
    ...uuidPk,
    actor: { type: DataTypes.STRING(120), allowNull: false },
    action: { type: DataTypes.STRING(120), allowNull: false },
    target_type: { type: DataTypes.STRING(50), allowNull: false },
    target_id: { type: DataTypes.STRING(36), allowNull: true },
    details: jsonColumn("details", {}),
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "audit_logs", timestamps: false }
);

export const Task = sequelize.define(
  "Task",
  {
    ...uuidPk,
    title: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    priority: { type: DataTypes.STRING(10), defaultValue: "medium" },
    status: { type: DataTypes.STRING(20), defaultValue: "pending" },
    assigned_agent: { type: DataTypes.STRING(255), allowNull: true },
    lead_id: { type: DataTypes.UUID, allowNull: true },
    due_at: { type: DataTypes.DATE, allowNull: true },
    created_by: { type: DataTypes.STRING(120), allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    completed_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "tasks", timestamps: false }
);

/** Internal fee/payment record-keeping — a staff-maintained ledger entry, not a live
 * payment processor integration. No card/bank details are ever collected or stored here;
 * `method`/`reference` are free-text notes staff enter for their own reconciliation
 * (e.g. "Bank transfer", "REF-20260820-01"). */
export const Payment = sequelize.define(
  "Payment",
  {
    ...uuidPk,
    user_id: { type: DataTypes.UUID, allowNull: false },
    lead_id: { type: DataTypes.UUID, allowNull: true },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    currency: { type: DataTypes.STRING(6), defaultValue: "NGN" },
    purpose: { type: DataTypes.STRING(255), allowNull: false },
    status: { type: DataTypes.STRING(20), defaultValue: "pending" },
    /** pending | paid | waived | refunded */
    method: { type: DataTypes.STRING(60), allowNull: true },
    reference: { type: DataTypes.STRING(120), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    recorded_by: { type: DataTypes.STRING(120), allowNull: true },
    paid_at: { type: DataTypes.DATE, allowNull: true },
    last_reminder_sent_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "payments", timestamps: false, hooks: { beforeUpdate: touchUpdatedAt } }
);

// --------------------------------------------------------------------------- //
// Associations
// --------------------------------------------------------------------------- //

User.hasOne(MigrationProfile, { foreignKey: "user_id", as: "profile", onDelete: "CASCADE", hooks: true });
MigrationProfile.belongsTo(User, { foreignKey: "user_id", as: "user" });

User.hasMany(Lead, { foreignKey: "user_id", as: "leads", onDelete: "CASCADE", hooks: true });
Lead.belongsTo(User, { foreignKey: "user_id", as: "user" });

User.hasMany(Conversation, { foreignKey: "user_id", as: "conversations", onDelete: "CASCADE", hooks: true });
Conversation.belongsTo(User, { foreignKey: "user_id", as: "user" });

User.hasMany(Document, { foreignKey: "user_id", as: "documents", onDelete: "CASCADE", hooks: true });
Document.belongsTo(User, { foreignKey: "user_id", as: "user" });

User.hasMany(Application, { foreignKey: "user_id", as: "applications", onDelete: "CASCADE", hooks: true });
Application.belongsTo(User, { foreignKey: "user_id", as: "user" });

User.hasMany(ConsultationBooking, {
  foreignKey: "user_id",
  as: "consultation_bookings",
  onDelete: "CASCADE",
  hooks: true,
});
ConsultationBooking.belongsTo(User, { foreignKey: "user_id", as: "user" });

Country.hasMany(Pathway, { foreignKey: "country_id", as: "pathways" });
Pathway.belongsTo(Country, { foreignKey: "country_id", as: "country" });

Conversation.hasMany(Message, {
  foreignKey: "conversation_id",
  as: "messages",
  onDelete: "CASCADE",
  hooks: true,
});
Message.belongsTo(Conversation, { foreignKey: "conversation_id", as: "conversation" });

Application.belongsTo(Pathway, { foreignKey: "pathway_id", as: "pathway" });
EligibilityAssessment.belongsTo(User, { foreignKey: "user_id", as: "user" });
EligibilityAssessment.belongsTo(Pathway, { foreignKey: "pathway_id", as: "pathway" });
ConsultationBooking.belongsTo(Conversation, { foreignKey: "conversation_id", as: "conversation" });

Lead.hasMany(Task, { foreignKey: "lead_id", as: "tasks" });
Task.belongsTo(Lead, { foreignKey: "lead_id", as: "lead" });

User.hasMany(Payment, { foreignKey: "user_id", as: "payments", onDelete: "CASCADE", hooks: true });
Payment.belongsTo(User, { foreignKey: "user_id", as: "user" });
Lead.hasMany(Payment, { foreignKey: "lead_id", as: "payments" });
Payment.belongsTo(Lead, { foreignKey: "lead_id", as: "lead" });

export async function syncModels() {
  // Deliberately NOT { alter: true } — confirmed on 2026-08-22 that it silently emptied
  // countries/pathways/faqs on the production server's MariaDB 10.11 (schema-diffing
  // interacting badly with the custom JSON-column handling above), while leaving the exact
  // same tables untouched on a MariaDB 10.4 dev box. New columns need an explicit, reviewed
  // ALTER TABLE — see scripts/ for one-off migrations — not a blanket auto-alter on boot.
  await sequelize.sync();
}
