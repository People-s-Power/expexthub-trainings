const mongoose = require('mongoose');

/**
 * Append-only record of who changed what, for the actions the spec requires to be
 * traceable (§23): affiliate approvals and suspensions, commission rate changes,
 * withdrawal decisions and commission reversals.
 *
 * Entries are never updated or deleted. `before`/`after` hold only the fields that
 * actually changed, so the log reads as a diff rather than a full snapshot, and
 * sensitive fields are stripped by the caller before they get here — a log is not
 * a place to leak a password hash or a full bank account number.
 */
const auditLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    actorRole: String,
    actorName: String,
    // Dotted verb form: 'affiliate.approved', 'commission.reversed',
    // 'commission_settings.updated', 'withdrawal.approved'.
    action: { type: String, required: true, index: true },
    entity: { type: String, index: true },
    entityId: { type: String, index: true },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    note: String,
    ip: String,
    userAgent: String,
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

// The two ways this is read: one entity's history, and the global feed.
auditLogSchema.index({ entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ at: -1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
