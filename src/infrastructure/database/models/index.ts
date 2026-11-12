import { sequelize } from '../sequelize';

import defineAccount from './account';
import defineOrgMember from './orgMember';
import defineProject from './project';
import defineFile from './file';
import defineTranslationKey from './translationKey';
import defineTranslation from './translation';
import defineAuthToken from './authToken';
import defineAccountSession from './accountSession';
import defineApiUsageLog from './apiUsageLog';
import defineExportFormat from './exportFormat';
import defineAccountApiKey from './accountApiKey';
import defineAiChatLog from './aiChatLog';
import defineAiChatSession from './aiChatSession';
import defineAccountMfa from './accountMfa';
import defineAccountRecoveryCode from './accountRecoveryCode';
import defineMfaChallenge from './mfaChallenge';
import defineOauthState from './oauthState';
import defineAccountIdentity from './accountIdentity';

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
const AccountMfa = defineAccountMfa(sequelize);
const AccountRecoveryCode = defineAccountRecoveryCode(sequelize);
const MfaChallenge = defineMfaChallenge(sequelize);
const OauthState = defineOauthState(sequelize);
const AccountIdentity = defineAccountIdentity(sequelize);

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

// Account to its second factor. At most one row, enforced by the unique index
// on the column rather than by anything declared here.
Account.hasOne(AccountMfa, {
  as: 'mfa',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
AccountMfa.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

// Account to the codes that get somebody back in when the authenticator is gone.
Account.hasMany(AccountRecoveryCode, {
  as: 'recoveryCodes',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
AccountRecoveryCode.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

// Account to sign ins waiting on a second factor.
Account.hasMany(MfaChallenge, {
  as: 'mfaChallenges',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
MfaChallenge.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

// Account to the provider accounts that may sign it in. Many per account: one
// GitHub and one GitLab is the ordinary case, and unlinking one leaves the
// other alone.
Account.hasMany(AccountIdentity, {
  as: 'identities',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
AccountIdentity.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

// Account to its in flight provider redirects. Nullable on the account side,
// because a sign in has no account until the identity resolves to one.
Account.hasMany(OauthState, {
  as: 'oauthStates',
  foreignKey: { name: 'accountId', field: 'account_id' },
  onDelete: 'CASCADE',
});
OauthState.belongsTo(Account, {
  as: 'account',
  foreignKey: { name: 'accountId', field: 'account_id' },
});

export {
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
  AccountMfa,
  AccountRecoveryCode,
  MfaChallenge,
  OauthState,
  AccountIdentity,
};

export type { AccountAttributes, AccountInstance, AccountModel, AccountPublicJson, AccountMemberJson } from './account';
export type { OrgMemberAttributes, OrgMemberInstance, OrgMemberModel, OrgMemberPublicJson } from './orgMember';
export type { ProjectAttributes, ProjectInstance, ProjectModel, ProjectPublicJson } from './project';
export type { FileAttributes, FileInstance, FileModel, FilePublicJson } from './file';
export type { TranslationKeyAttributes, TranslationKeyInstance, TranslationKeyModel, TranslationKeyPublicJson } from './translationKey';
export type { TranslationAttributes, TranslationInstance, TranslationModel, TranslationPublicJson } from './translation';
export type { AuthTokenAttributes, AuthTokenInstance, AuthTokenModel } from './authToken';
export type { AccountSessionAttributes, AccountSessionInstance, AccountSessionModel, AccountSessionPublicJson } from './accountSession';
export type { ApiUsageLogAttributes, ApiUsageLogInstance, ApiUsageLogModel, ApiUsageLogPublicJson } from './apiUsageLog';
export type { ExportFormatAttributes, ExportFormatInstance, ExportFormatModel, ExportFormatPublicJson } from './exportFormat';
export type { AccountApiKeyAttributes, AccountApiKeyInstance, AccountApiKeyModel, AccountApiKeyPublicJson } from './accountApiKey';
export type { AiChatLogAttributes, AiChatLogInstance, AiChatLogModel, AiChatLogPublicJson } from './aiChatLog';
export type { AiChatSessionAttributes, AiChatSessionInstance, AiChatSessionModel, AiChatSessionPublicJson } from './aiChatSession';
export type { AccountMfaAttributes, AccountMfaInstance, AccountMfaModel, AccountMfaPublicJson } from './accountMfa';
export type { AccountRecoveryCodeAttributes, AccountRecoveryCodeInstance, AccountRecoveryCodeModel } from './accountRecoveryCode';
export type { MfaChallengeAttributes, MfaChallengeInstance, MfaChallengeModel } from './mfaChallenge';
export type { OauthStateAttributes, OauthStateInstance, OauthStateModel } from './oauthState';
export type { AccountIdentityAttributes, AccountIdentityInstance, AccountIdentityModel, AccountIdentityPublicJson } from './accountIdentity';
