'use strict';

const { sequelize } = require('../sequelize');

const defineAccount = require('./account');
const defineOrgMember = require('./orgMember');
const defineProject = require('./project');
const defineFile = require('./file');
const defineTranslationKey = require('./translationKey');
const defineTranslation = require('./translation');
const defineAuthToken = require('./authToken');
const defineAccountSession = require('./accountSession');
const defineApiUsageLog = require('./apiUsageLog');
const defineExportFormat = require('./exportFormat');
const defineAccountApiKey = require('./accountApiKey');
const defineAiChatLog = require('./aiChatLog');
const defineAiChatSession = require('./aiChatSession');

const Account = defineAccount(sequelize);
const OrgMember = defineOrgMember(sequelize);
const Project = defineProject(sequelize);
const File = defineFile(sequelize);
const TranslationKey = defineTranslationKey(sequelize);
const Translation = defineTranslation(sequelize);
const AuthToken = defineAuthToken(sequelize);
const AccountSession = defineAccountSession(sequelize);
const ApiUsageLog = defineApiUsageLog(sequelize);
const ExportFormat = defineExportFormat(sequelize);
const AccountApiKey = defineAccountApiKey(sequelize);
const AiChatLog = defineAiChatLog(sequelize);
const AiChatSession = defineAiChatSession(sequelize);

/*
 * Associations.
 *
 * Every child relation cascades on delete, so removing a namespace removes its
 * projects, their files, those files' keys and every translation underneath.
 * No orphaned financial or customer data is left behind.
 */

// An organization account has many membership rows.
Account.hasMany(OrgMember, {
  as: 'memberships',
  foreignKey: { name: 'orgAccountId', field: 'org_account_id' },
  onDelete: 'CASCADE',
});
OrgMember.belongsTo(Account, {
  as: 'organization',
  foreignKey: { name: 'orgAccountId', field: 'org_account_id' },
});

// A user account belongs to many organizations.
Account.hasMany(OrgMember, {
  as: 'organizationLinks',
  foreignKey: { name: 'userAccountId', field: 'user_account_id' },
  onDelete: 'CASCADE',
});
OrgMember.belongsTo(Account, {
  as: 'member',
  foreignKey: { name: 'userAccountId', field: 'user_account_id' },
});

// Namespace to projects.
Account.hasMany(Project, {
  as: 'projects',
  foreignKey: { name: 'namespaceAccountId', field: 'namespace_account_id' },
  onDelete: 'CASCADE',
});
Project.belongsTo(Account, {
  as: 'namespace',
  foreignKey: { name: 'namespaceAccountId', field: 'namespace_account_id' },
});

// A project has no credentials of its own. It names a platform and a model, and
// the key that pays for them is resolved from the owning namespace and then the
// acting person, both of which hang off `AccountApiKey` below.

// Project to files.
Project.hasMany(File, {
  as: 'files',
  foreignKey: { name: 'projectId', field: 'project_id' },
  onDelete: 'CASCADE',
});
File.belongsTo(Project, {
  as: 'project',
  foreignKey: { name: 'projectId', field: 'project_id' },
});

// File to translation keys.
File.hasMany(TranslationKey, {
  as: 'translationKeys',
  foreignKey: { name: 'fileId', field: 'file_id' },
  onDelete: 'CASCADE',
});
TranslationKey.belongsTo(File, {
  as: 'file',
  foreignKey: { name: 'fileId', field: 'file_id' },
});

// Translation key to per language translations.
TranslationKey.hasMany(Translation, {
  as: 'translations',
  foreignKey: { name: 'translationKeyId', field: 'translation_key_id' },
  onDelete: 'CASCADE',
});
Translation.belongsTo(TranslationKey, {
  as: 'translationKey',
  foreignKey: { name: 'translationKeyId', field: 'translation_key_id' },
});

// Namespace to export formats. A format is written once for the namespace and
// used by every project underneath it.
Account.hasMany(ExportFormat, {
  as: 'exportFormats',
  foreignKey: { name: 'namespaceAccountId', field: 'namespace_account_id' },
  onDelete: 'CASCADE',
});
ExportFormat.belongsTo(Account, {
  as: 'namespace',
  foreignKey: { name: 'namespaceAccountId', field: 'namespace_account_id' },
});

// Namespace to its own AI credentials, which pay for whatever the account does
// outside a single project.
Account.hasMany(AccountApiKey, {
  as: 'accountApiKeys',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
AccountApiKey.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

/*
 * Chat logs hang off two accounts at once: the namespace the conversation
 * happened in, and the person who typed the prompt. Both cascade, so deleting
 * either an organization or a member removes the rows that name them.
 */
Account.hasMany(AiChatLog, {
  as: 'chatLogs',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
AiChatLog.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

Account.hasMany(AiChatLog, {
  as: 'authoredChatLogs',
  foreignKey: { name: 'userAccountId', field: 'user_id' },
  onDelete: 'CASCADE',
});
AiChatLog.belongsTo(Account, {
  as: 'author',
  foreignKey: { name: 'userAccountId', field: 'user_id' },
});

// Conversations hang off the same two accounts, for the same reasons.
Account.hasMany(AiChatSession, {
  as: 'chatSessions',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
AiChatSession.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

Account.hasMany(AiChatSession, {
  as: 'authoredChatSessions',
  foreignKey: { name: 'userAccountId', field: 'user_id' },
  onDelete: 'CASCADE',
});
AiChatSession.belongsTo(Account, {
  as: 'author',
  foreignKey: { name: 'userAccountId', field: 'user_id' },
});

/*
 * A session to its turns.
 *
 * Deleting a conversation takes its turns with it, which is what makes
 * "delete this conversation" a single statement rather than a sweep over a log
 * table by an identifier that used to belong to nothing.
 */
AiChatSession.hasMany(AiChatLog, {
  as: 'turns',
  foreignKey: { name: 'sessionId', field: 'session_id' },
  onDelete: 'CASCADE',
});
AiChatLog.belongsTo(AiChatSession, {
  as: 'session',
  foreignKey: { name: 'sessionId', field: 'session_id' },
});

/*
 * Account to the credentials that authenticate it.
 *
 * Many per account by design: a laptop, a phone, a second browser profile and
 * a build script are four rows, each endable without touching the others.
 */
Account.hasMany(AccountSession, {
  as: 'sessions',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
AccountSession.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

/*
 * Account to what has been done on it.
 *
 * Cascades with the account, because a deleted account leaves nothing behind.
 * The link to the credential that made each request is a plain column rather
 * than an association: a revoked token is eventually purged, and the record of
 * what it did has to outlive it.
 */
Account.hasMany(ApiUsageLog, {
  as: 'apiUsage',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
ApiUsageLog.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

// Account to short lived tokens.
Account.hasMany(AuthToken, {
  as: 'authTokens',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
AuthToken.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

module.exports = {
  sequelize,
  Account,
  OrgMember,
  Project,
  File,
  TranslationKey,
  Translation,
  AuthToken,
  AccountSession,
  ApiUsageLog,
  ExportFormat,
  AccountApiKey,
  AiChatLog,
  AiChatSession,
};
