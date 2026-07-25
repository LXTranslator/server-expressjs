# Environment

Every setting is read through `src/config/`. There is deliberately no
`.env.example` file in this repository; this document is the single source of
truth for configuration.

## The PROD switch

One variable decides how the server behaves.

| `PROD` | Database | Secrets | Built in AI key |
|---|---|---|---|
| `true` | PostgreSQL, required settings | Must be supplied, no defaults | Refused |
| `false` | SQLite | Built in development defaults | Available |
| unset | SQLite (same as `false`) | Built in development defaults | Available |

With `PROD=true` the server refuses to boot if a required secret is missing, is
shorter than 32 characters, or still contains the development placeholder
marker. That is intentional: a deployment should fail loudly rather than run on
a publicly known key.

## Running with no configuration

No variables are required for development or for the test suite. The server
boots on SQLite with built in development secrets and an offline AI provider:

```bash
npm install
npm start
npm test
```

## Development

```bash
# Nothing here is required; each line shows the default that applies when unset.

PROD=false
NODE_ENV=development

# Network
PORT=4000
HOST=0.0.0.0
CLIENT_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
TRUST_PROXY=false
LOG_LEVEL=info

# Database. Ignored unless PROD is false.
SQLITE_STORAGE=./data/lxtranslator.sqlite

# Security. Development defaults are used when these are unset.
JWT_SECRET=your_jwt_secret
JWT_ISSUER=lxtranslator
JWT_AUDIENCE=lxtranslator_client
ACCESS_TOKEN_TTL_SECONDS=3600
ENCRYPTION_PASSPHRASE=your_encryption_passphrase
BCRYPT_ROUNDS=12
MAX_FAILED_LOGINS=5
LOCKOUT_MINUTES=15

# Rate limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_GLOBAL_MAX=300
RATE_LIMIT_AUTH_MAX=10
RATE_LIMIT_AVAILABILITY_MAX=20
RATE_LIMIT_UPLOAD_MAX=20

# Uploads
UPLOAD_STORAGE_DIR=./storage/uploads
UPLOAD_MAX_BYTES=2097152
UPLOAD_MAX_JSON_DEPTH=20
UPLOAD_MAX_KEYS=5000

# AI providers
AI_DEFAULT_PROVIDER=mock
AI_DEFAULT_MODEL=mock-small
AI_DEFAULT_API_KEY=your_default_ai_key
AI_REQUEST_TIMEOUT_MS=30000
AI_MAX_ATTEMPTS_PER_KEY=2
AI_BATCH_SIZE=25

# Workers
WORKER_POOL_SIZE=2
WORKER_TASK_TIMEOUT_MS=300000

# Mail. The console transport logs the message instead of sending it.
MAIL_TRANSPORT=console
MAIL_FROM=LXTranslator <no_reply@lxtranslator.local>
```

## Production

With `PROD=true` the variables below are mandatory. The server exits at boot if
any is missing.

```bash
PROD=true
NODE_ENV=production

# Required. No defaults exist for any of these.
JWT_SECRET=your_jwt_secret
ENCRYPTION_PASSPHRASE=your_encryption_passphrase
PG_HOST=your_postgres_host
PG_PORT=5432
PG_DATABASE=your_database_name
PG_USER=your_database_user
PG_PASSWORD=your_database_password

# Recommended
PG_SSL=true
PG_POOL_MAX=10
PG_POOL_MIN=0
PG_POOL_IDLE=10000
TRUST_PROXY=true
CLIENT_URL=https://your_client_host
CORS_ORIGINS=https://your_client_host
LOG_LEVEL=info

# Real mail delivery
MAIL_TRANSPORT=smtp
MAIL_FROM=LXTranslator <no_reply@your_domain>
SMTP_HOST=your_smtp_host
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_user
SMTP_PASSWORD=your_smtp_password

# A real provider, since the mock performs no translation
AI_DEFAULT_PROVIDER=openai
AI_DEFAULT_MODEL=gpt-4o-mini
```

Generate the two secrets with a cryptographic source, never by hand:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`JWT_SECRET` signs every session and action token. `ENCRYPTION_PASSPHRASE`
derives the AES key that wraps stored provider credentials. **Changing
`ENCRYPTION_PASSPHRASE` makes every stored API key unreadable**, so rotate it
only alongside a re-encryption of the `project_api_keys` table.

Provider API keys are **not** environment variables. They are entered per
project through the interface and stored encrypted, which is what allows several
keys per project and the priority ordered fallback between them.

## Variable reference

| Variable | Default | Purpose |
|---|---|---|
| `PROD` | `false` | Selects production mode, PostgreSQL and strict secrets. |
| `PORT` | `4000` | Listening port. |
| `HOST` | `0.0.0.0` | Listening interface. |
| `CLIENT_URL` | `http://localhost:5173` | Base URL used to build password reset links. |
| `CORS_ORIGINS` | localhost origins | Comma separated origin allowlist. |
| `TRUST_PROXY` | `PROD` | Trust the forwarded client address header. |
| `LOG_LEVEL` | `info` | One of `silent`, `error`, `warn`, `info`, `debug`. |
| `SQLITE_STORAGE` | `./data/lxtranslator.sqlite` | SQLite file path when `PROD` is false. |
| `PG_HOST` | required in production | PostgreSQL host. |
| `PG_PORT` | `5432` | PostgreSQL port. |
| `PG_DATABASE` | required in production | PostgreSQL database name. |
| `PG_USER` | required in production | PostgreSQL user. |
| `PG_PASSWORD` | required in production | PostgreSQL password. |
| `PG_SSL` | `true` | Require TLS to PostgreSQL. |
| `PG_POOL_MAX` | `10` | Maximum pooled connections. |
| `PG_POOL_MIN` | `0` | Minimum pooled connections. |
| `PG_POOL_IDLE` | `10000` | Idle connection timeout in milliseconds. |
| `JWT_SECRET` | development default | Token signing secret, minimum 32 characters in production. |
| `JWT_ISSUER` | `lxtranslator` | Expected token issuer. |
| `JWT_AUDIENCE` | `lxtranslator_client` | Expected token audience. |
| `ACCESS_TOKEN_TTL_SECONDS` | `3600` | Session token lifetime. |
| `ENCRYPTION_PASSPHRASE` | development default | Derives the credential encryption key. |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost. |
| `MAX_FAILED_LOGINS` | `5` | Failures before an account is locked. |
| `LOCKOUT_MINUTES` | `15` | Lockout duration. |
| `RATE_LIMIT_ENABLED` | `true` | Master switch for rate limiting. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window. |
| `RATE_LIMIT_GLOBAL_MAX` | `300` | Requests per window per address. |
| `RATE_LIMIT_AUTH_MAX` | `10` | Credential endpoint requests per window. |
| `RATE_LIMIT_AVAILABILITY_MAX` | `20` | Availability probe requests per window. |
| `RATE_LIMIT_UPLOAD_MAX` | `20` | Uploads per window. |
| `UPLOAD_STORAGE_DIR` | `./storage/uploads` | Root for archived uploads. |
| `UPLOAD_MAX_BYTES` | `2097152` | Maximum upload size in bytes. |
| `UPLOAD_MAX_JSON_DEPTH` | `20` | Maximum nesting depth accepted. |
| `UPLOAD_MAX_KEYS` | `5000` | Maximum translatable keys per file. |
| `AI_DEFAULT_PROVIDER` | `mock` | Provider chosen for new projects. |
| `AI_DEFAULT_MODEL` | `mock-small` | Model chosen for new projects. |
| `AI_DEFAULT_API_KEY` | development default | Built in key, refused in production. |
| `AI_REQUEST_TIMEOUT_MS` | `30000` | Per provider request timeout. |
| `AI_MAX_ATTEMPTS_PER_KEY` | `2` | Retries per credential before moving on. |
| `AI_BATCH_SIZE` | `25` | Strings per provider request. |
| `WORKER_POOL_SIZE` | `2` | Translation worker threads. |
| `WORKER_TASK_TIMEOUT_MS` | `300000` | Maximum duration of one job. |
| `MAIL_TRANSPORT` | `console` outside production | `console` or `smtp`. |
| `MAIL_FROM` | local address | Sender address. |
| `SMTP_HOST` | unset | SMTP host, required when the transport is `smtp`. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_SECURE` | `false` | Use implicit TLS. |
| `SMTP_USER` | unset | SMTP username. |
| `SMTP_PASSWORD` | unset | SMTP password. |

## Docker

```bash
docker build -t lxtranslator_server .

# Development: no configuration, SQLite, offline provider.
docker run --rm -p 4000:4000 lxtranslator_server

# Production: secrets supplied from the host environment.
docker run --rm -p 4000:4000 \
  -e PROD=true \
  -e JWT_SECRET="$JWT_SECRET" \
  -e ENCRYPTION_PASSPHRASE="$ENCRYPTION_PASSPHRASE" \
  -e PG_HOST=your_postgres_host \
  -e PG_DATABASE=your_database_name \
  -e PG_USER=your_database_user \
  -e PG_PASSWORD="$PG_PASSWORD" \
  lxtranslator_server
```

## Docker Compose

```yaml
services:
  database:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: lxtranslator
      POSTGRES_USER: lxtranslator
      POSTGRES_PASSWORD: ${PG_PASSWORD:?set PG_PASSWORD in the shell environment}
    volumes:
      - database_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U lxtranslator"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  server:
    build: .
    depends_on:
      database:
        condition: service_healthy
    environment:
      PROD: "true"
      PG_HOST: database
      PG_PORT: "5432"
      PG_DATABASE: lxtranslator
      PG_USER: lxtranslator
      PG_PASSWORD: ${PG_PASSWORD:?set PG_PASSWORD in the shell environment}
      PG_SSL: "false"
      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET in the shell environment}
      ENCRYPTION_PASSPHRASE: ${ENCRYPTION_PASSPHRASE:?set ENCRYPTION_PASSPHRASE in the shell environment}
      CLIENT_URL: https://your_client_host
      CORS_ORIGINS: https://your_client_host
      TRUST_PROXY: "true"
    ports:
      - "4000:4000"
    volumes:
      - upload_storage:/app/storage
    restart: unless-stopped

volumes:
  database_data:
  upload_storage:
```

Secrets are interpolated from the shell rather than written into the file, and
the `:?` form makes Compose refuse to start when one is missing.

## Kubernetes

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: lxtranslator-server-secrets
type: Opaque
stringData:
  JWT_SECRET: your_jwt_secret
  ENCRYPTION_PASSPHRASE: your_encryption_passphrase
  PG_PASSWORD: your_database_password
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: lxtranslator-server-config
data:
  PROD: "true"
  PG_HOST: your_postgres_host
  PG_PORT: "5432"
  PG_DATABASE: your_database_name
  PG_USER: your_database_user
  PG_SSL: "true"
  CLIENT_URL: https://your_client_host
  CORS_ORIGINS: https://your_client_host
  TRUST_PROXY: "true"
  LOG_LEVEL: info
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lxtranslator-server
spec:
  replicas: 2
  selector:
    matchLabels:
      app: lxtranslator-server
  template:
    metadata:
      labels:
        app: lxtranslator-server
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: server
          image: your_registry/lxtranslator_server:your_tag
          ports:
            - containerPort: 4000
          envFrom:
            - configMapRef:
                name: lxtranslator-server-config
            - secretRef:
                name: lxtranslator-server-secrets
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /api/v1/health
              port: 4000
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /api/v1/health
              port: 4000
            initialDelaySeconds: 5
            periodSeconds: 10
          volumeMounts:
            - name: upload-storage
              mountPath: /app/storage
      volumes:
        - name: upload-storage
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: lxtranslator-server
spec:
  selector:
    app: lxtranslator-server
  ports:
    - port: 80
      targetPort: 4000
```

`readOnlyRootFilesystem` is safe because the only writable path the server needs
is the mounted upload volume.
