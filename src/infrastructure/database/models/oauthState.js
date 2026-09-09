'use strict';

const { DataTypes } = require('sequelize');

/**
 * Defines the `oauth_states` model.
 *
 * One in flight provider redirect. There is no cookie and no server side
 * browser session, so this row is the entire memory of a sign in that has left
 * for github.com and not yet come back.
 *
 * It carries three things the callback cannot get anywhere else: which provider
 * the code will belong to, the PKCE verifier that proves the same client
 * started and finished the flow, and — when linking — which account is doing
 * the linking. That last one is the whole CSRF defence: without it, somebody
 * could get a signed in visitor to complete a flow started with the attacker's
 * provider account and bind that identity to the victim.
 *
 * `provider` and `mode` are STRING with validation rather than ENUM,
 * deliberately. `sequelize.sync()` in production creates missing tables and
 * never alters an existing type, so an ENUM here could never gain a value
 * later: adding a third provider would work on every fresh database and fail
 * on the first insert against a real one.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection instance.
 * @returns {import('sequelize').ModelStatic<any>} The OauthState model.
 */
module.exports = (sequelize) => {
  const OauthState = sequelize.define(
    'OauthState',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      /** Provider name, resolved through the fixed registry. */
      provider: {
        type: DataTypes.STRING(20),
        allowNull: false,
      },
      /** `LINK` binds an identity to an account; `LOGIN` signs one in. */
      mode: {
        type: DataTypes.STRING(10),
        allowNull: false,
        validate: { isIn: [['LINK', 'LOGIN']] },
      },
      /** SHA-256 hex digest of the state string. The string itself is never stored. */
      stateHash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        field: 'state_hash',
      },
      /** AES-256-GCM envelope wrapping the PKCE verifier, or null when unused. */
      codeVerifier: {
        type: DataTypes.TEXT,
        allowNull: true,
        field: 'code_verifier',
      },
      /**
       * The account doing the linking, or null for a sign in.
       *
       * Nullable on purpose: a sign in has no account until the provider
       * identity resolves to one.
       */
      accountId: {
        type: DataTypes.UUID,
        allowNull: true,
        field: 'account_id',
        references: { model: 'accounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: 'expires_at',
      },
      consumedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        field: 'consumed_at',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        field: 'created_at',
      },
    },
    {
      tableName: 'oauth_states',
      updatedAt: 'updated_at',
      /**
       * The verifier is excluded from every default query, and the exclusion
       * names the attribute rather than the column, because Sequelize matches
       * attribute names.
       */
      defaultScope: { attributes: { exclude: ['codeVerifier'] } },
      scopes: {
        withVerifier: { attributes: { include: ['codeVerifier'] } },
      },
      indexes: [
        { unique: true, fields: ['state_hash'] },
        { fields: ['expires_at'] },
        { fields: ['account_id'] },
      ],
    },
  );

  return OauthState;
};
