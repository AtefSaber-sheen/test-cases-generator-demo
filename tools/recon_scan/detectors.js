// Detection tables for the recon scanner.
//
// WHAT THESE ARE, AND WHAT THEY ARE NOT. Every entry here produces a CANDIDATE — a file and a line
// that look like a testable surface, a validation rule, an authorization check. A candidate is a
// place to read, never a fact to write into a test case. The skill that consumes this output must
// open each hit and confirm what it actually does; a regex cannot tell an active route from one
// inside a commented-out block or a fixture.
//
// The value of the table is coverage of the SEARCH, not certainty of the MATCH: a hand-driven grep
// finds the routes someone already thought of, and misses the message consumer nobody remembered
// the service had.
//
// Adding an ecosystem means adding rows here — no other file changes.

'use strict';

// ---------------------------------------------------------------------------
// Stack detection — read from manifests, which state dependencies as fact
// ---------------------------------------------------------------------------

/**
 * manifest file -> how to pull declared dependency names out of it.
 * Deliberately textual rather than a real parser for each format: a dependency NAME appearing in
 * the manifest is all that is needed, and a half-written pyproject.toml should not abort a scan.
 */
const MANIFESTS = [
  {
    file: 'package.json',
    ecosystem: 'node',
    extract: (text) => {
      try {
        const json = JSON.parse(text);
        return Object.keys({
          ...(json.dependencies || {}),
          ...(json.devDependencies || {}),
          ...(json.peerDependencies || {}),
        });
      } catch {
        return [...text.matchAll(/"([@a-z0-9][^"]*)"\s*:\s*"[^"]*"/gi)].map((m) => m[1]);
      }
    },
  },
  {
    file: 'requirements.txt',
    ecosystem: 'python',
    extract: (text) => text.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/[<>=!~[;\s]/)[0].trim())
      .filter(Boolean),
  },
  {
    file: 'pyproject.toml',
    ecosystem: 'python',
    extract: (text) => [...text.matchAll(/^\s*"?([A-Za-z0-9._-]+)"?\s*[=<>~^]/gm)].map((m) => m[1]),
  },
  {
    file: 'pom.xml',
    ecosystem: 'java',
    extract: (text) => [...text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]),
  },
  {
    file: 'build.gradle',
    ecosystem: 'java',
    extract: (text) => [...text.matchAll(/['"]([a-z0-9.-]+:[a-z0-9.-]+)(?::[^'"]*)?['"]/gi)]
      .map((m) => m[1]),
  },
  {
    file: 'build.gradle.kts',
    ecosystem: 'java',
    extract: (text) => [...text.matchAll(/['"]([a-z0-9.-]+:[a-z0-9.-]+)(?::[^'"]*)?['"]/gi)]
      .map((m) => m[1]),
  },
  {
    file: 'go.mod',
    ecosystem: 'go',
    extract: (text) => [...text.matchAll(/^\s*([a-z0-9./-]+)\s+v\d/gim)].map((m) => m[1]),
  },
  {
    file: 'Gemfile',
    ecosystem: 'ruby',
    extract: (text) => [...text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
  },
  {
    file: 'composer.json',
    ecosystem: 'php',
    extract: (text) => {
      try {
        const json = JSON.parse(text);
        return Object.keys({ ...(json.require || {}), ...(json['require-dev'] || {}) });
      } catch {
        return [];
      }
    },
  },
  {
    file: 'Cargo.toml',
    ecosystem: 'rust',
    extract: (text) => [...text.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]),
  },
];

/** Dependency name (or prefix) -> what its presence tells the test designer. */
const STACK_SIGNALS = [
  // Backend web frameworks
  { match: /^express$/, label: 'Express', role: 'http-framework' },
  { match: /^fastify$/, label: 'Fastify', role: 'http-framework' },
  { match: /^koa$/, label: 'Koa', role: 'http-framework' },
  { match: /^@nestjs\//, label: 'NestJS', role: 'http-framework' },
  { match: /^@hapi\//, label: 'hapi', role: 'http-framework' },
  { match: /^django$/i, label: 'Django', role: 'http-framework' },
  { match: /^djangorestframework$/i, label: 'Django REST Framework', role: 'http-framework' },
  { match: /^flask$/i, label: 'Flask', role: 'http-framework' },
  { match: /^fastapi$/i, label: 'FastAPI', role: 'http-framework' },
  { match: /spring-boot/i, label: 'Spring Boot', role: 'http-framework' },
  { match: /^Microsoft\.AspNetCore/i, label: 'ASP.NET Core', role: 'http-framework' },
  { match: /gin-gonic|labstack\/echo|gofiber|go-chi/i, label: 'Go HTTP framework', role: 'http-framework' },
  { match: /^rails$|^sinatra$/i, label: 'Rails / Sinatra', role: 'http-framework' },
  { match: /^laravel\/|^symfony\//i, label: 'Laravel / Symfony', role: 'http-framework' },
  { match: /^actix-web$|^axum$|^rocket$/i, label: 'Rust HTTP framework', role: 'http-framework' },

  // Frontend
  { match: /^next$/, label: 'Next.js', role: 'frontend-framework' },
  { match: /^nuxt$/, label: 'Nuxt', role: 'frontend-framework' },
  { match: /^react$/, label: 'React', role: 'frontend-framework' },
  { match: /^vue$/, label: 'Vue', role: 'frontend-framework' },
  { match: /^svelte$|^@sveltejs\//, label: 'Svelte / SvelteKit', role: 'frontend-framework' },
  { match: /^@angular\//, label: 'Angular', role: 'frontend-framework' },
  { match: /^@remix-run\//, label: 'Remix', role: 'frontend-framework' },
  { match: /^react-hook-form$|^formik$|^vee-validate$/, label: 'Form library', role: 'forms' },
  { match: /^@tanstack\/react-query$|^swr$|^@apollo\/client$/, label: 'Data-fetching layer', role: 'data-fetch' },
  { match: /^react-router|^vue-router$/, label: 'Client router', role: 'routing' },
  { match: /^i18next$|^react-intl$|^vue-i18n$/, label: 'i18n', role: 'i18n' },

  // API styles
  { match: /^graphql$|^apollo-server|^@apollo\/server$|^graphene|^strawberry-graphql$/, label: 'GraphQL', role: 'api-style' },
  { match: /^@grpc\/|^grpcio$|^grpc-java/, label: 'gRPC', role: 'api-style' },
  { match: /^socket\.io$|^ws$/, label: 'WebSocket', role: 'api-style' },
  { match: /^trpc$|^@trpc\//, label: 'tRPC', role: 'api-style' },

  // Persistence
  { match: /^prisma$|^@prisma\/client$/, label: 'Prisma', role: 'orm' },
  { match: /^typeorm$/, label: 'TypeORM', role: 'orm' },
  { match: /^sequelize$/, label: 'Sequelize', role: 'orm' },
  { match: /^mongoose$/, label: 'Mongoose', role: 'orm' },
  { match: /^drizzle-orm$/, label: 'Drizzle', role: 'orm' },
  { match: /^sqlalchemy$|^alembic$/i, label: 'SQLAlchemy / Alembic', role: 'orm' },
  { match: /hibernate|spring-data/i, label: 'Hibernate / Spring Data', role: 'orm' },
  { match: /EntityFrameworkCore/i, label: 'EF Core', role: 'orm' },
  { match: /^gorm\.io/, label: 'GORM', role: 'orm' },

  // Validation — the richest single source of negative test data
  { match: /^zod$/, label: 'Zod', role: 'validation' },
  { match: /^yup$/, label: 'Yup', role: 'validation' },
  { match: /^joi$|^@hapi\/joi$/, label: 'Joi', role: 'validation' },
  { match: /^class-validator$/, label: 'class-validator', role: 'validation' },
  { match: /^ajv$/, label: 'AJV / JSON Schema', role: 'validation' },
  { match: /^pydantic$/i, label: 'Pydantic', role: 'validation' },
  { match: /^marshmallow$/i, label: 'Marshmallow', role: 'validation' },
  { match: /validation-api|hibernate-validator/i, label: 'Bean Validation', role: 'validation' },
  { match: /FluentValidation/i, label: 'FluentValidation', role: 'validation' },
  { match: /go-playground\/validator/i, label: 'go-playground/validator', role: 'validation' },

  // AuthN / AuthZ
  { match: /^passport$|^next-auth$|^@auth\//, label: 'Passport / Auth.js', role: 'auth' },
  { match: /^jsonwebtoken$|^jose$|^pyjwt$/i, label: 'JWT', role: 'auth' },
  { match: /^casbin$|^@casl\//, label: 'Policy engine', role: 'authz' },
  { match: /spring-security|Microsoft\.AspNetCore\.Authorization/i, label: 'Framework authorization', role: 'authz' },

  // Async / scheduling / messaging
  { match: /^bullmq$|^bull$|^agenda$|^node-cron$/, label: 'Job queue / scheduler', role: 'jobs' },
  { match: /^celery$/i, label: 'Celery', role: 'jobs' },
  { match: /^kafkajs$|^kafka-python$|^spring-kafka/i, label: 'Kafka', role: 'messaging' },
  { match: /^amqplib$|^pika$|^spring-rabbit/i, label: 'RabbitMQ', role: 'messaging' },
  { match: /@aws-sdk\/client-sqs|^boto3$/i, label: 'AWS SDK (SQS/SNS/S3)', role: 'messaging' },

  // Feature flags / config
  { match: /launchdarkly|^unleash-client$|^@openfeature\//i, label: 'Feature flags', role: 'feature-flags' },

  // Existing tests — tells the designer what already exists, so cases are not duplicated
  { match: /^jest$|^vitest$|^mocha$|^ava$/, label: 'Unit test runner', role: 'tests' },
  { match: /^@playwright\/test$|^playwright$/, label: 'Playwright', role: 'tests-e2e' },
  { match: /^cypress$/, label: 'Cypress', role: 'tests-e2e' },
  { match: /^@testing-library\//, label: 'Testing Library', role: 'tests-component' },
  { match: /^supertest$|^pactum$/, label: 'HTTP integration tests', role: 'tests-api' },
  { match: /^pytest$/i, label: 'pytest', role: 'tests' },
  { match: /^junit|^org\.junit|rest-assured/i, label: 'JUnit / REST Assured', role: 'tests' },
  { match: /^xunit|^nunit|^Microsoft\.NET\.Test\.Sdk/i, label: '.NET test stack', role: 'tests' },
  { match: /^rspec/i, label: 'RSpec', role: 'tests' },
  { match: /^phpunit\/phpunit$/i, label: 'PHPUnit', role: 'tests' },
];

// ---------------------------------------------------------------------------
// Surface / rule detectors — regexes run line-by-line over source files
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = [
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.java', '.kt', '.cs', '.go', '.rb', '.php', '.rs', '.scala',
  '.vue', '.svelte', '.astro',
];

const MARKUP_EXTENSIONS = ['.html', '.htm', '.hbs', '.ejs', '.erb', '.blade.php', '.cshtml', '.jsx', '.tsx', '.vue', '.svelte'];

/**
 * Each detector: id, the surface KIND it suggests, the extensions it applies to, and the pattern.
 *
 * `kind` maps 1:1 onto the Surface Inventory's Kind column, so a hit can be promoted to a surface
 * row without a translation step in between.
 */
const DETECTORS = [
  // ---- HTTP routes -------------------------------------------------------
  {
    id: 'express-route', kind: 'API', label: 'Express/Koa-style route',
    ext: ['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx'],
    pattern: /\b(?:app|router|api|server)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`]*)/i,
  },
  {
    id: 'nest-route', kind: 'API', label: 'NestJS route decorator',
    ext: ['.ts'],
    pattern: /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(/,
  },
  {
    id: 'nest-controller', kind: 'API', label: 'NestJS controller',
    ext: ['.ts'],
    pattern: /@Controller\s*\(/,
  },
  {
    id: 'next-route-handler', kind: 'API', label: 'Next.js route handler export',
    ext: ['.ts', '.js', '.tsx', '.jsx'],
    pattern: /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/,
  },
  {
    id: 'flask-route', kind: 'API', label: 'Flask route',
    ext: ['.py'],
    pattern: /@\w+\.route\s*\(\s*['"]([^'"]*)/,
  },
  {
    id: 'fastapi-route', kind: 'API', label: 'FastAPI route',
    ext: ['.py'],
    pattern: /@\w+\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]*)/i,
  },
  {
    id: 'django-url', kind: 'API', label: 'Django URL pattern',
    ext: ['.py'],
    pattern: /\b(?:path|re_path|url)\s*\(\s*r?['"]([^'"]*)/,
  },
  {
    id: 'spring-mapping', kind: 'API', label: 'Spring request mapping',
    ext: ['.java', '.kt'],
    pattern: /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\s*\(/,
  },
  {
    id: 'aspnet-route', kind: 'API', label: 'ASP.NET route attribute',
    ext: ['.cs'],
    pattern: /\[\s*(?:Http(?:Get|Post|Put|Patch|Delete)|Route)\s*[(\]]/,
  },
  {
    id: 'go-route', kind: 'API', label: 'Go HTTP handler registration',
    ext: ['.go'],
    pattern: /\b(?:\w+\.(?:GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc)|http\.HandleFunc)\s*\(/,
  },
  {
    id: 'rails-route', kind: 'API', label: 'Rails route',
    ext: ['.rb'],
    pattern: /^\s*(?:get|post|put|patch|delete|resources?|namespace)\s+['":]/,
  },
  {
    id: 'laravel-route', kind: 'API', label: 'Laravel route',
    ext: ['.php'],
    pattern: /Route::\s*(get|post|put|patch|delete|any|match|resource)\s*\(/i,
  },

  // ---- GraphQL / RPC / realtime -----------------------------------------
  {
    id: 'graphql-schema', kind: 'API', label: 'GraphQL type/operation definition',
    ext: ['.graphql', '.gql', '.ts', '.js', '.py'],
    pattern: /\b(type\s+(Query|Mutation|Subscription)\b|@(Query|Mutation|Subscription)\s*\()/,
  },
  {
    id: 'grpc-service', kind: 'API', label: 'gRPC service definition',
    ext: ['.proto'],
    pattern: /^\s*(service|rpc)\s+\w+/,
  },
  {
    id: 'websocket-handler', kind: 'API', label: 'WebSocket / realtime handler',
    ext: CODE_EXTENSIONS,
    pattern: /\b(?:socket|io|ws)\s*\.\s*on\s*\(\s*['"`]|@(?:SubscribeMessage|WebSocketGateway)\s*\(/,
  },

  // ---- Messaging / jobs / batch -----------------------------------------
  {
    id: 'message-consumer', kind: 'MSG', label: 'Message consumer / event handler',
    ext: CODE_EXTENSIONS,
    pattern: /@(?:EventPattern|MessagePattern|KafkaListener|RabbitListener|SqsListener)\s*\(|\.\s*(?:subscribe|consume)\s*\(\s*['"`]/,
  },
  {
    id: 'scheduled-job', kind: 'JOB', label: 'Scheduled job',
    ext: CODE_EXTENSIONS,
    pattern: /@(?:Cron|Scheduled|Interval|Timeout)\s*\(|\bcron\.schedule\s*\(|\bcelery\.task\b|@(?:shared_task|periodic_task)\b/,
  },
  {
    id: 'queue-worker', kind: 'JOB', label: 'Queue worker / processor',
    ext: CODE_EXTENSIONS,
    pattern: /new\s+Worker\s*\(|@Processor\s*\(|\.\s*process\s*\(\s*['"`]/,
  },

  // ---- CLI ---------------------------------------------------------------
  {
    id: 'cli-command', kind: 'CLI', label: 'CLI command definition',
    ext: CODE_EXTENSIONS,
    pattern: /\b(?:program|yargs|cli)\s*\.\s*command\s*\(|add_parser\s*\(|@click\.command\b|cobra\.Command\{/,
  },

  // ---- UI ----------------------------------------------------------------
  {
    id: 'ui-route', kind: 'UI', label: 'Client-side route',
    ext: ['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte'],
    pattern: /<Route\b|createBrowserRouter\s*\(|\bpath:\s*['"`]\/|RouterModule\.forRoot\s*\(/,
  },
  {
    id: 'ui-form', kind: 'UI', label: 'Form / submit handler',
    ext: MARKUP_EXTENSIONS,
    pattern: /<form\b|onSubmit\s*=|handleSubmit\s*\(|useForm\s*[(<]|\[formGroup\]|v-on:submit|@submit/i,
  },
  {
    id: 'ui-input-binding', kind: 'UI', label: 'Input field binding',
    ext: MARKUP_EXTENSIONS,
    pattern: /<input\b|<select\b|<textarea\b|formControlName\s*=|v-model\s*=/i,
  },

  // ---- Validation — the primary source of boundary and negative data -----
  {
    id: 'schema-validation', kind: 'RULE', label: 'Schema validation rule',
    ext: CODE_EXTENSIONS,
    pattern: /\bz\.(?:string|number|object|array|enum|boolean|date)\s*\(|\byup\.\w+\s*\(|\bJoi\.\w+\s*\(|Schema\s*\(\s*\{|BaseModel\b|\bconstr\s*\(|\bField\s*\(/,
  },
  {
    id: 'validation-decorator', kind: 'RULE', label: 'Validation decorator/annotation',
    ext: ['.ts', '.java', '.kt', '.cs', '.py'],
    pattern: /@(?:IsString|IsInt|IsEmail|IsNotEmpty|Length|Min|Max|MinLength|MaxLength|Matches|IsOptional|NotNull|NotBlank|Size|Pattern|Range|Required|StringLength|RegularExpression)\s*[(\]]?/,
  },
  {
    id: 'inline-constraint', kind: 'RULE', label: 'Inline length/range constraint',
    ext: CODE_EXTENSIONS,
    pattern: /\.(?:min|max|minLength|maxLength|length|gte|lte|gt|lt|positive|nonnegative|regex|email|url|uuid)\s*\(\s*[^)]/,
  },
  {
    id: 'guard-clause', kind: 'RULE', label: 'Guard clause / early rejection',
    ext: CODE_EXTENSIONS,
    pattern: /\b(?:throw\s+new\s+\w*(?:Bad|Invalid|Validation|NotFound|Forbidden|Unauthorized|Conflict)\w*|raise\s+\w*(?:ValidationError|ValueError|PermissionDenied|Http404)|abort\s*\(\s*4\d\d)/,
  },
  {
    id: 'status-code', kind: 'RULE', label: 'Explicit HTTP status',
    ext: CODE_EXTENSIONS,
    pattern: /\b(?:status|StatusCode|sendStatus|HttpStatus\.\w+|res\.status)\s*[(.=]\s*['"]?(4\d\d|5\d\d|20\d|30\d)/,
  },

  // ---- Authorization -----------------------------------------------------
  {
    id: 'authz-check', kind: 'AUTH', label: 'Authorization / role check',
    ext: CODE_EXTENSIONS,
    pattern: /@(?:Roles|PreAuthorize|Secured|Authorize|RequirePermission)\s*[(\[]|\[\s*Authorize|\b(?:hasRole|hasPermission|can|authorize|checkPermission|permission_required|login_required|IsAuthenticated)\s*\(/,
  },
  {
    id: 'auth-middleware', kind: 'AUTH', label: 'Authentication middleware / guard',
    ext: CODE_EXTENSIONS,
    pattern: /@UseGuards\s*\(|\bpassport\.authenticate\s*\(|\brequireAuth\b|\bensureAuthenticated\b|\bverifyToken\b/,
  },

  // ---- State machines / workflow ----------------------------------------
  {
    id: 'state-transition', kind: 'RULE', label: 'Status/state transition',
    ext: CODE_EXTENSIONS,
    pattern: /\b(?:status|state)\s*(?:=|:|===|==)\s*['"`](?:pending|active|draft|approved|rejected|cancelled|canceled|completed|failed|expired|archived|paid|shipped)['"`]/i,
  },
  {
    id: 'enum-definition', kind: 'RULE', label: 'Enum definition',
    ext: CODE_EXTENSIONS,
    pattern: /\benum\s+\w+|\bEnum\s*\(|\bz\.enum\s*\(|\bchoices\s*=\s*[[(]/,
  },

  // ---- Configuration / feature flags ------------------------------------
  {
    id: 'config-read', kind: 'CFG', label: 'Configuration / environment read',
    ext: CODE_EXTENSIONS,
    pattern: /\b(?:process\.env\.\w+|os\.getenv\s*\(|System\.getenv\s*\(|Environment\.GetEnvironmentVariable\s*\(|configService\.get\s*[(<]|@Value\s*\(\s*["']\$\{)/,
  },
  {
    id: 'feature-flag', kind: 'CFG', label: 'Feature flag',
    ext: CODE_EXTENSIONS,
    pattern: /\b(?:featureFlag|isFeatureEnabled|useFlag|variation\s*\(|isEnabled\s*\(\s*['"`]|FEATURE_[A-Z0-9_]+)/,
  },

  // ---- Persistence -------------------------------------------------------
  {
    id: 'db-model', kind: 'DB', label: 'Data model / entity definition',
    ext: CODE_EXTENSIONS,
    pattern: /@(?:Entity|Table|Column|Document)\s*[(\]]?|\bmodels\.Model\b|\bdefineModel\s*\(|\bnew\s+Schema\s*\(|^\s*model\s+\w+\s*\{/,
  },
  {
    id: 'db-constraint', kind: 'DB', label: 'Database constraint',
    ext: ['.sql', '.prisma', '.rb', '.py', '.js', '.ts', '.cs', '.java', '.xml', '.yaml', '.yml'],
    pattern: /\b(?:NOT NULL|UNIQUE|PRIMARY KEY|FOREIGN KEY|CHECK\s*\(|@unique\b|@@unique\b|unique\s*:\s*true|nullable\s*[:=]\s*false|ON DELETE)/i,
  },
  {
    id: 'transaction', kind: 'DB', label: 'Transaction boundary',
    ext: CODE_EXTENSIONS,
    pattern: /@Transactional\b|\b(?:beginTransaction|\$transaction|transaction\.atomic|BEGIN TRANSACTION)\b/i,
  },

  // ---- Rate limiting / resilience ---------------------------------------
  {
    id: 'rate-limit', kind: 'RULE', label: 'Rate limit / throttle',
    ext: CODE_EXTENSIONS,
    pattern: /\b(?:rateLimit|RateLimiter|@Throttle|throttle\s*\(|Ratelimit|limiter)\b/,
  },
  {
    id: 'retry-timeout', kind: 'RULE', label: 'Retry / timeout policy',
    ext: CODE_EXTENSIONS,
    pattern: /\b(?:retry|retries|maxAttempts|timeout|deadline|CircuitBreaker|backoff)\s*[:=(]/i,
  },

  // ---- i18n / a11y -------------------------------------------------------
  {
    id: 'i18n-key', kind: 'UI', label: 'Translated string',
    ext: [...CODE_EXTENSIONS, '.html'],
    pattern: /\b(?:t|i18n\.t|\$t|translate|gettext|_)\s*\(\s*['"`][a-z0-9_.]+['"`]/i,
  },
  {
    id: 'a11y-attribute', kind: 'UI', label: 'Accessibility attribute',
    ext: MARKUP_EXTENSIONS,
    pattern: /\b(?:aria-[a-z]+|role)\s*=/i,
  },
];

/** Directory names never worth walking. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  '.next', '.nuxt', '.svelte-kit', '.output', 'coverage', '.nyc_output', 'vendor',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  '.gradle', '.idea', '.vs', '.vscode', 'Pods', 'DerivedData', '.terraform',
  '.cache', '.parcel-cache', '.turbo', 'bower_components', 'testgen_out',
]);

/** File names/extensions never worth reading as source. */
const IGNORED_FILE = /\.(?:min\.js|min\.css|map|lock|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf|zip|gz|tar|jar|war|dll|exe|so|dylib|class|pyc|mp4|mp3|wav)$/i;

/** Paths that are themselves tests — collected separately, never counted as product surfaces. */
const TEST_PATH = /(?:^|[\\/])(?:tests?|__tests__|spec|specs|e2e|cypress|playwright|features)[\\/]|\.(?:test|spec)\.[a-z]+$|(?:^|[\\/])test_[^\\/]+\.py$|[^\\/]+_test\.(?:go|py|rb)$|Tests?\.(?:cs|java|kt)$/i;

/** Paths that carry schema/migration truth — high-value evidence for data-shaped tests. */
const SCHEMA_PATH = /(?:^|[\\/])(?:migrations?|migrate|alembic|db[\\/]migrate|liquibase|flyway)[\\/]|\.(?:sql|prisma)$|schema\.(?:rb|prisma|graphql|sql)$|openapi|swagger/i;

module.exports = {
  MANIFESTS,
  STACK_SIGNALS,
  DETECTORS,
  CODE_EXTENSIONS,
  MARKUP_EXTENSIONS,
  IGNORED_DIRS,
  IGNORED_FILE,
  TEST_PATH,
  SCHEMA_PATH,
};
