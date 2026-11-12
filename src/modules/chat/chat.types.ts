import type { AccountInstance } from '../../infrastructure/database/models';

/**
 * The shapes the chat service and its tools share.
 */

/** A verified upload attached to a chat message. */
type ChatAttachment = Express.Multer.File;

/** A download a turn offers. The client fetches it from the download endpoint. */
interface ChatDownload {
  file_id: string;
  filename: string;
  lang: string | null;
  langs: string[];
  export_format: string;
  format_name: string;
}

/**
 * What a tool sees. The actor is the authenticated account and the only
 * identity any tool trusts; `switch_namespace` may replace the namespace after
 * proving membership.
 */
interface ToolContext {
  actor: AccountInstance;
  namespace: AccountInstance;
  namespaceRole: string;
  attachment: ChatAttachment | null;
  sessionId: string;
  downloads: ChatDownload[];
}

/** What a tool hands back to the model. */
type ToolResult = { ok: boolean } & Record<string, unknown>;

export type { ChatAttachment, ChatDownload, ToolContext, ToolResult };
