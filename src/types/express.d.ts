import type { TokenClaims } from '../modules/auth/token.service';
import type {
  AccountInstance,
  AccountSessionInstance,
  FileInstance,
  ProjectInstance,
} from '../infrastructure/database/models';

/**
 * What this server's middleware attaches to a request.
 *
 * Each field is set by the middleware that runs before any handler reading it:
 * `authenticate` sets the account, claims and session, the namespace guards set
 * the namespace and role, the project and file loaders set those records. A
 * handler mounted behind the middleware can therefore read the field directly.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation identifier assigned to every request. */
      id: string;
      /** The signed in account. */
      account: AccountInstance;
      /** Claims of the session token; null for an API token. */
      tokenClaims: TokenClaims | null;
      /** The session or API token row the bearer resolved to. */
      session: AccountSessionInstance;
      /** The namespace named in the route. */
      namespace: AccountInstance;
      /** The caller's role inside that namespace. */
      namespaceRole: string;
      /** The project named in the route. */
      project: ProjectInstance;
      /** The file row named in the route, kept apart from multer's upload. */
      fileRecord: FileInstance;
      /** Query and route parameters after schema validation. */
      validated?: { query?: unknown; params?: unknown };
    }

    namespace Multer {
      interface File {
        /** Sanitised original name, set by the upload middleware. */
        safeName: string;
      }
    }
  }
}

export {};
