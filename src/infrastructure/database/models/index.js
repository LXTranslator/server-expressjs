'use strict';

const { sequelize } = require('../sequelize');

const defineAccount = require('./account');
const defineOrgMember = require('./orgMember');
const defineProject = require('./project');
const defineProjectApiKey = require('./projectApiKey');
const defineFile = require('./file');
const defineTranslationKey = require('./translationKey');
const defineTranslation = require('./translation');
const defineAuthToken = require('./authToken');
const defineAccountApiKey = require('./accountApiKey');
const defineAiChatLog = require('./aiChatLog');

const Account = defineAccount(sequelize);
const OrgMember = defineOrgMember(sequelize);
const Project = defineProject(sequelize);
const ProjectApiKey = defineProjectApiKey(sequelize);
const File = defineFile(sequelize);
const TranslationKey = defineTranslationKey(sequelize);
const Translation = defineTranslation(sequelize);
const AuthToken = defineAuthToken(sequelize);
const AccountApiKey = defineAccountApiKey(sequelize);
const AiChatLog = defineAiChatLog(sequelize);

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

// Project to API keys.
Project.hasMany(ProjectApiKey, {
  as: 'apiKeys',
  foreignKey: { name: 'projectId', field: 'project_id' },
  onDelete: 'CASCADE',
});
ProjectApiKey.belongsTo(Project, {
  as: 'project',
  foreignKey: { name: 'projectId', field: 'project_id' },
});

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
  ProjectApiKey,
  File,
  TranslationKey,
  Translation,
  AuthToken,
  AccountApiKey,
  AiChatLog,
};
