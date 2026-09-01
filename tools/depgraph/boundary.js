// Boundary classification: what a dependency you cannot read can do to you.
//
// THE POINT. When the closure reaches something it cannot read - a payment SDK, an HTTP client, a
// database driver - the honest answer is not to skip it. The dependency itself is unreadable, but
// the CALLER is right there in the repository, and how the caller behaves when that dependency
// succeeds and when it fails is fully testable.
//
// So each boundary becomes a surface with an ID, and each surface carries the OUTCOMES its role can
// produce. That list is what lets Stage 3 write
//
//     payment gateway declines -> HTTP 422 PAYMENT_FAILED, no order row
//
// instead of the useless
//
//     simulate an error from the payment provider
//
// The difference is whether a runner can execute the case.
//
// WHY ROLE AND NOT NAME. Every HTTP client fails the same four ways whatever it is called; every
// relational driver deadlocks and violates constraints. Keying the outcome list on the ROLE means an
// unrecognised package still gets useful coverage as soon as its role is identified, and a package
// nobody has ever seen still gets the generic set rather than nothing.

'use strict';

const { externalRoleOf } = require('./languages');

// ---------------------------------------------------------------------------
// Failure and success outcomes, per role
// ---------------------------------------------------------------------------

/**
 * What each kind of boundary can do, stated as testable outcomes.
 *
 * `outcomes` entries are deliberately phrased as things that HAPPEN AT THE BOUNDARY, not as
 * expected results: what the caller should do about each is a property of the caller and must be
 * read from its code by Stage 2, not assumed here. This table supplies the input axis; the
 * expected result stays evidence-backed.
 *
 * `isolation` is the strictest level a test driving this boundary can honestly claim, which is
 * what keeps the parallel plan safe: a shared sandbox account cannot run concurrently with itself.
 */
const ROLE_PROFILES = {  'http-client': {
    label: 'Outbound HTTP',
    isolation: 'exclusive:<host>',
    success: ['2xx with the expected body shape'],
    outcomes: [
      { id: 'timeout', description: 'the request exceeds the configured timeout and never completes' },
      { id: 'connection-refused', description: 'the host is unreachable or refuses the connection' },
      { id: 'http-4xx', description: 'the remote returns a 4xx with an error body' },
      { id: 'http-5xx', description: 'the remote returns a 5xx' },
      { id: 'malformed-body', description: 'the response is 2xx but the body does not match the expected shape' },
      { id: 'slow-response', description: 'the response arrives inside the timeout but late enough to matter' },
    ],
  },
  'payment': {
    label: 'Payment gateway',
    isolation: 'exclusive:payment-sandbox',
    success: ['the charge is authorised and an id is returned'],
    outcomes: [
      { id: 'declined', description: 'the card is declined - the single most important negative path' },
      { id: 'insufficient-funds', description: 'declined specifically for funds' },
      { id: 'idempotency-replay', description: 'the same idempotency key is submitted twice' },
      { id: 'timeout', description: 'no response - the charge may or may not have been taken' },
      { id: 'webhook-out-of-order', description: 'a settlement callback arrives before the charge response' },
      { id: 'currency-or-amount-rejected', description: 'the amount or currency is invalid at the gateway' },
    ],
  },
  'database': {
    label: 'Database / ORM',
    isolation: 'mutates-record:<entity>',
    success: ['the row is written or read as expected'],
    outcomes: [
      { id: 'unique-violation', description: 'a uniqueness constraint rejects the write' },
      { id: 'foreign-key-violation', description: 'a referenced row does not exist' },
      { id: 'not-null-violation', description: 'a required column is absent' },
      { id: 'deadlock-or-serialization-failure', description: 'concurrent transactions conflict' },
      { id: 'connection-pool-exhausted', description: 'no connection is available' },
      { id: 'transaction-rollback', description: 'the surrounding transaction aborts after a partial write' },
      { id: 'empty-result', description: 'a query the code assumes returns a row returns none' },
    ],
  },
  'cache': {
    label: 'Cache',
    isolation: 'shared-fixture:cache',
    success: ['the value is stored and read back'],
    outcomes: [
      { id: 'miss', description: 'the key is absent, so the code must fall through to the source of truth' },
      { id: 'stale-value', description: 'the cached value is older than the underlying record' },
      { id: 'unavailable', description: 'the cache is down and the code must degrade rather than fail' },
      { id: 'eviction-mid-flow', description: 'the key disappears between a check and a use' },
    ],
  },
  'queue': {
    label: 'Queue / broker',
    isolation: 'exclusive:<topic>',
    success: ['the message is published or consumed once'],
    outcomes: [
      { id: 'publish-failure', description: 'the broker rejects or drops the publish' },
      { id: 'duplicate-delivery', description: 'the same message is delivered twice - tests idempotency' },
      { id: 'out-of-order-delivery', description: 'messages arrive in an order the code does not expect' },
      { id: 'poison-message', description: 'a message that can never be processed successfully' },
      { id: 'consumer-lag', description: 'the backlog grows beyond what the code assumes' },
      { id: 'unacknowledged-redelivery', description: 'processing succeeds but the ack is lost' },
    ],
  },
  'email': {
    label: 'Email',
    isolation: 'exclusive:mail-sandbox',
    success: ['the message is accepted for delivery'],
    outcomes: [
      { id: 'send-rejected', description: 'the provider rejects the message' },
      { id: 'rate-limited', description: 'the provider throttles' },
      { id: 'bounce', description: 'delivery fails after acceptance' },
      { id: 'template-or-recipient-invalid', description: 'the payload is rejected as malformed' },
    ],
  },
  'notification': {
    label: 'Notification',
    isolation: 'exclusive:notification-sandbox',
    success: ['the notification is accepted'],
    outcomes: [
      { id: 'send-rejected', description: 'the provider rejects the request' },
      { id: 'rate-limited', description: 'the provider throttles' },
      { id: 'invalid-token', description: 'the device or recipient token is no longer valid' },
    ],
  },
  'cloud-sdk': {
    label: 'Cloud SDK',
    isolation: 'exclusive:<service>',
    success: ['the operation succeeds and returns the documented shape'],
    outcomes: [
      { id: 'throttled', description: 'the service returns a throttling error' },
      { id: 'access-denied', description: 'credentials or policy deny the operation' },
      { id: 'not-found', description: 'the addressed resource does not exist' },
      { id: 'eventual-consistency', description: 'a write is not yet visible to the following read' },
      { id: 'timeout', description: 'the call does not complete' },
    ],
  },
  'auth-provider': {
    label: 'Auth provider',
    isolation: 'read-only',
    success: ['a valid token or session is produced and accepted'],
    outcomes: [
      { id: 'expired-token', description: 'the token is past its expiry' },
      { id: 'invalid-signature', description: 'the token does not verify' },
      { id: 'missing-claim', description: 'a claim the code reads is absent' },
      { id: 'wrong-audience-or-issuer', description: 'the token is valid but not for this service' },
      { id: 'provider-unavailable', description: 'key discovery or introspection fails' },
    ],
  },
  'feature-flags': {
    label: 'Feature flags',
    isolation: 'global-state',
    success: ['the flag resolves to its documented value'],
    outcomes: [
      { id: 'flag-on', description: 'the non-default state - a separate behaviour needing its own coverage' },
      { id: 'flag-off', description: 'the default state' },
      { id: 'provider-unavailable', description: 'evaluation fails and the code must fall back to a default' },
    ],
  },
  'clock': {
    label: 'Clock / date',
    isolation: 'global-state',
    success: ['time-dependent logic behaves at an ordinary instant'],
    outcomes: [
      { id: 'boundary-instant', description: 'exactly at an expiry or cutoff - inclusivity is decided here' },
      { id: 'timezone-offset', description: 'the same instant read in a different zone' },
      { id: 'dst-transition', description: 'a local time that occurs twice or not at all' },
      { id: 'clock-skew', description: 'client and server disagree' },
    ],
  },
  'runtime': {
    label: 'Language runtime',
    isolation: 'exclusive:<resource>',
    success: ['the operation completes'],
    outcomes: [
      { id: 'permission-denied', description: 'the filesystem or OS refuses' },
      { id: 'not-found', description: 'the path or handle does not exist' },
      { id: 'exhausted', description: 'disk, memory or descriptors run out' },
    ],
  },
  'unclassified': {
    label: 'Third-party package',
    isolation: 'exclusive:<dependency>',
    success: ['the call returns the value the caller expects'],
    outcomes: [
      { id: 'throws', description: 'the dependency raises - assert the caller surfaces it without leaking internals' },
      { id: 'returns-null-or-empty', description: 'the caller receives nothing where it expects a value' },
      { id: 'timeout-or-hang', description: 'the call does not return' },
    ],
  },
};
// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** A stable, readable id fragment for a specifier: `@aws-sdk/client-sqs` -> `AWS-SDK-CLIENT-SQS`. */
function slugFor(specifier) {
  return String(specifier)
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
}

/**
 * Turn one external dependency from the closure into a boundary surface.
 *
 * The surface is addressed at its CALL SITES, not at the package: a test drives the caller and
 * controls the dependency, so the call-site list is the entry point and the `importedBy` list names
 * the files whose behaviour is under test at this boundary.
 *
 * A dependency with no call sites is reported with `exercised: false`. It is imported and never
 * called on any path the closure walked, so it needs no tests - and saying so explicitly is what
 * stops it being quietly counted as covered.
 */
function classifyBoundary(external, index) {
  const { role, label } = externalRoleOf(external.specifier);
  const profile = ROLE_PROFILES[role] || ROLE_PROFILES.unclassified;
  const sites = external.callSites || [];
  const callers = [...new Set(sites.map((s) => s.file).filter(Boolean))].sort();

  return {
    id: 'SF-EXT-' + String(index).padStart(3, '0'),
    kind: 'EXT',
    specifier: external.specifier,
    role,
    roleLabel: label,
    profileLabel: profile.label,
    importedBy: external.importedBy || [],
    callers,
    callSites: sites,
    exercised: sites.length > 0,
    isolation: profile.isolation,
    successOutcomes: profile.success,
    failureOutcomes: profile.outcomes,
    // One success case and one case per failure mode, for every caller that reaches it. This is
    // the number Stage 3 has to justify covering or explicitly decline, per caller.
    minimumCases: sites.length ? callers.length * (1 + profile.outcomes.length) : 0,
    evidence: sites.length ? sites.map((s) => s.ref) : (external.importedBy || []),
    resolutionReason: external.reason || null,
  };
}

/**
 * Classify every external boundary a closure reached.
 *
 * Ordered by how much they matter: boundaries actually exercised first, then by call-site count.
 * A test designer working top-down then covers the highest-traffic boundary first, and an
 * unexercised import never displaces a live one.
 */
function classifyBoundaries(closure) {
  const externals = (closure && closure.externalBoundaries) || [];
  const ordered = [...externals].sort((a, b) => {
    const ax = (a.callSites || []).length, bx = (b.callSites || []).length;
    if ((ax > 0) !== (bx > 0)) return ax > 0 ? -1 : 1;
    return bx - ax || String(a.specifier).localeCompare(String(b.specifier));
  });
  return ordered.map((e, i) => classifyBoundary(e, i + 1));
}

/**
 * Roll the boundaries up into the numbers a coverage report has to state.
 *
 * `minimumCases` is the honest size of the boundary half of the suite. It is usually larger than
 * a team expects, and that is the finding: a service with six unreadable dependencies has six
 * failure surfaces that a scope-filtered run would have shown as nothing at all.
 */
function summariseBoundaries(boundaries) {
  const byRole = {};
  for (const b of boundaries) {
    if (!byRole[b.role]) byRole[b.role] = { role: b.role, label: b.profileLabel, count: 0, exercised: 0, minimumCases: 0 };
    byRole[b.role].count += 1;
    if (b.exercised) byRole[b.role].exercised += 1;
    byRole[b.role].minimumCases += b.minimumCases;
  }
  return {
    total: boundaries.length,
    exercised: boundaries.filter((b) => b.exercised).length,
    unexercised: boundaries.filter((b) => !b.exercised).length,
    minimumCases: boundaries.reduce((n, b) => n + b.minimumCases, 0),
    byRole: Object.values(byRole).sort((a, b) => b.minimumCases - a.minimumCases),
  };
}

module.exports = { ROLE_PROFILES, classifyBoundary, classifyBoundaries, summariseBoundaries, slugFor };
