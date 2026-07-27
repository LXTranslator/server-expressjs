'use strict';

const { DataTypes } = require('sequelize');

/**
 * What a row authenticates.
 *
 * A browser session and a machine credential are the same thing to every
 * endpoint downstream, and different in exactly two ways: how long they live,
 * and how they are created. Keeping them in one table means revocation,
 * listing and the freshness check are written once rather than twice.
 */
const SESSION_KINDS = ['SESSION', 'API'];

/**
 * Defines the `account_sessions` model.
 *
 * Before this table a session was a signed token and nothing else. That is
 * enough to prove who somebody is and nothing else at all: signing out could
 * only forget the token locally, so it stayed valid for the rest of its hour on
 * whatever machine held it; a stolen token could not be cancelled; and nobody
 * could see where they were signed in. A stateless token cannot be taken back,
 * and taking one back is most of what session management is.
 *
 * So every credential now has a row, and the row is the authority. Many rows
 * per account is the ordinary case rather than a special one: a person is
 * signed in on a laptop, a phone and a second browser profile at once, and each
 * of those is a separate row that can be ended without touching the others.
 *
 * Only a SHA-256 digest of the token is stored, so reading this table yields
 * nothing usable. That is the same rule the action token ledger follows, and
 * it matters more here because these live far longer.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The AccountSession model.
 */
module.exports = (sequelize) => {
  const AccountSession = sequelize.define(
    'AccountSession',
    {
      /**
       * For a browser session this mirrors the `jti` of the issued JWT, which
       * is what lets a presented token find its row without a table scan.
       */
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      accountId: {
        type: DataTypes.UUID,
        allowNull: false,
        field: 'account_id',
        references: { model: 'accounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      kind: {
        type: DataTypes.ENUM(...SESSION_KINDS),
        allowNull: false,
        defaultValue: 'SESSION',
      },
      /** SHA-256 hex digest of the token. The token itself is never stored. */
      tokenHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
        field: 'token_hash',
      },
      /**
       * What this credential is called.
       *
       * Null for an ordinary sign in, which nobody names. An API token is
       * always named, because a list of unnamed machine credentials is a list
       * nobody can safely prune.
       */
      name: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      /**
       * The client that asked for it, truncated.
       *
       * Stored so "sign out the session I do not recognise" is answerable at
       * all. The address it came from is deliberately not stored: it locates a
       * person, changes constantly, and answers the same question worse.
       */
      userAgent: {
        type: DataTypes.STRING(200),
        allowNull: true,
        field: 'user_agent',
      },
      /** Last four characters of an API token, so a list can identify one. */
      lastFour: {
        type: DataTypes.STRING(4),
        allowNull: true,
        field: 'last_four',
      },
      /**
       * When it was last presented.
       *
       * Written at most once a minute rather than on every request: the point
       * is "is this still in use", which a minute answers, and a write per
       * request would make every read of every endpoint a write.
       */
      lastUsedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'last_used_at',
      },
      /** Null means it does not expire on its own, which only an API token may. */
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'expires_at',
      },
      /** Set once and never cleared. Revoking is not reversible. */
      revokedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'revoked_at',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'account_sessions',
      updatedAt: 'updated_at',
      indexes: [
        // The list query: this account's live credentials of one kind.
        { fields: ['account_id', 'kind', 'revoked_at'] },
        // The authentication query, on every request that presents a token.
        { unique: true, fields: ['token_hash'] },
      ],
    },
  );

  /**
   * Reports whether this credential may still authenticate.
   *
   * @param {Date} [now] Instant to judge against.
   * @returns {boolean} True when live.
   */
  AccountSession.prototype.isLive = function isLive(now = new Date()) {
    if (this.revokedAt !== null) return false;
    if (this.expiresAt !== null && this.expiresAt <= now) return false;
    return true;
  };

  /**
   * @returns {object} Client safe representation.
   *
   * The digest is absent. It is not a usable token, but it is the only stored
   * value from which one could be checked, and a list of credentials has no
   * reason to carry it.
   */
  AccountSession.prototype.toPublicJson = function toPublicJson() {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      user_agent: this.userAgent,
      masked_token: this.lastFour === null ? null : `****${this.lastFour}`,
      last_used_at: this.lastUsedAt,
      expires_at: this.expiresAt,
      revoked_at: this.revokedAt,
      created_at: this.createdAt,
    };
  };

  return AccountSession;
};

module.exports.SESSION_KINDS = SESSION_KINDS;
