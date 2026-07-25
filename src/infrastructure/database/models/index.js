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

const Account = defineAccount(sequelize);
const OrgMember = defineOrgMember(sequelize);
const Project = defineProject(sequelize);
const ProjectApiKey = defineProjectApiKey(sequelize);
const File = defineFile(sequelize);
const TranslationKey = defineTranslationKey(sequelize);
const Translation = defineTranslation(sequelize);
const AuthToken = defineAuthToken(sequelize);

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
};
