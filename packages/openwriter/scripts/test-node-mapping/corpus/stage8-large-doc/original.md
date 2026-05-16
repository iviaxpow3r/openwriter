# Distributed Systems Field Guide

This document collects field-tested patterns for building systems that survive contact with production traffic.

Each section addresses one cross-cutting concern. Sections can be read in any order, though earlier sections establish vocabulary later ones rely on.

## Architecture

Architecture decisions outlive the people who make them. Each one casts a long shadow forward into time.

Teams underestimate how much weight rests on this single foundation. They discover the lesson only after a serious incident.

Designing it carefully upfront saves enormous downstream pain. Cutting corners defers the bill without erasing it.

### Core invariants of Architecture

The following invariants must hold under every operating condition the runtime can reach:

- Every architectural choice should record its rationale before any code lands.
- Recovery paths must never assume that earlier state survives a process restart.
- Operators need to inspect the system without altering it through observation.

Documenting the architecture in code, not just prose, is the only durable defense. Comments fade; assertions remain.

> A system that cannot explain its own architecture during an incident will eventually be replaced.

```ts
function checkArchitecture(state: SystemState): boolean {
  return state.invariants.every((inv) => inv.holds(state));
}
```

Section one ends with a reminder that every architectural choice echoes through every future decision downstream.

## Persistence

Persistence is where optimistic code meets disappointing reality. Disks fail, networks partition, processes crash.

Most engineers learn to fear persistence layer bugs only after losing real production data. The cost of that lesson is enormous.

A careful storage design prevents most catastrophes outright. A careless one merely postpones the inevitable failure mode.

### Core invariants of Persistence

The following invariants must hold under every operating condition the runtime can reach:

- Writes should be durable on disk before any external acknowledgment ships.
- Reads must tolerate stale replicas without ever returning silent corruption.
- Recovery procedures need rehearsal, not just documentation in a wiki.

Testing persistence under failure injection is the cheapest insurance any team can buy against future midnight pages.

> A storage layer that has never lost data is a storage layer that has never been tested honestly.

```ts
async function flush(buffer: Buffer): Promise<void> {
  await fsync(buffer.fd);
  buffer.markDurable();
}
```

Persistence work feels invisible when it succeeds and unforgettable when it fails publicly.

## Concurrency

Concurrency turns simple problems into combinatorial nightmares. Two threads sharing a counter is harder than it looks.

The bugs that matter most in concurrent systems only manifest under specific timing windows nobody anticipated.

Reasoning through race conditions early prevents a long tail of mysterious incidents months later.

### Core invariants of Concurrency

The following invariants must hold under every operating condition the runtime can reach:

- Shared mutable state should be the exception, never the comfortable default.
- Locks must be acquired in a consistent global order across all critical paths.
- Tests need to exercise interleavings, not just sequential happy paths.

Single-writer designs sidestep most concurrency hazards by construction rather than by careful coding.

> Every concurrent bug looks obvious in hindsight and impossible in foresight.

```ts
function tryAcquire(mu: Mutex, timeout: Duration): boolean {
  return mu.lockWithTimeout(timeout);
}
```

Concurrency rewards the cautious and punishes the optimistic without ever explaining itself.

## Observability

Observability is the right to ask new questions of a running system without redeploying it first.

Without observability, operators are reduced to guessing during the precise moments when guessing is most dangerous.

Investing in good telemetry pays back the first time an unexpected production incident appears in the dashboard.

### Core invariants of Observability

The following invariants must hold under every operating condition the runtime can reach:

- Logs, metrics, and traces should converge on the same request identifier across services.
- Sampling needs to preserve the rare and interesting events, never just the common ones.
- Dashboards must answer questions, not merely display impressive walls of numbers.

Building observability before the first launch is far cheaper than retrofitting it after an outage forces the issue.

> You cannot improve what you refuse to measure honestly.

```ts
function emit(event: TraceEvent): void {
  tracer.record(event);
  metrics.increment(event.kind);
}
```

Observability turns operations from a guessing game into a disciplined investigation.

## Reliability

Reliability is the property that a system keeps working even when individual parts of it stop working.

Most reliability bugs come from optimistic assumptions about how often things will succeed in practice.

Designing for failure from day one is uncomfortable but vastly cheaper than retrofitting reliability later.

### Core invariants of Reliability

The following invariants must hold under every operating condition the runtime can reach:

- Every external call should have a timeout, a retry, and a circuit breaker policy.
- Bulkheads must isolate failures so one component cannot drag down the rest.
- Graceful degradation needs explicit design, never accidental emergence under pressure.

Chaos engineering surfaces hidden reliability assumptions before customers do it for you involuntarily.

> A reliable system is not one that never fails but one whose failures stay contained.

```ts
function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  return policy.execute(fn);
}
```

Reliability work consists mostly of imagining failures vividly enough to prevent them.

## Security

Security is what protects the system from people whose interests diverge from yours sharply enough to act.

Most security bugs come from forgetting that adversaries are creative, patient, and cheaper than your defenses.

Threat modeling at design time catches whole classes of vulnerability before they reach production code.

### Core invariants of Security

The following invariants must hold under every operating condition the runtime can reach:

- Inputs from outside the trust boundary should be validated before any structural use.
- Secrets must never appear in logs, error messages, or version control by accident.
- Least-privilege access needs enforcement at every layer, not just the outermost one.

Security reviews work best when they happen continuously, not just at major release boundaries.

> Defense in depth means the attacker must defeat every layer, not just the weakest one.

```ts
function sanitize(input: string): string {
  return validator.escape(input);
}
```

Security is a property of culture as much as of any specific piece of code.

## Performance

Performance work means making the same correct system spend less time and memory doing the same correct things.

Most performance bugs come from forgetting which operations dominate the steady-state cost profile.

Measuring before optimizing prevents the most expensive engineering mistake possible: optimizing the wrong thing.

### Core invariants of Performance

The following invariants must hold under every operating condition the runtime can reach:

- Profiles should drive optimization priorities, never gut feelings about hot paths.
- Caches must invalidate correctly, otherwise they merely launder stale data faster.
- Allocation patterns deserve as much attention as algorithmic complexity does.

Continuous benchmarking catches performance regressions before users notice the slowdown firsthand.

> Premature optimization is the root of all evil but considered optimization is the heart of engineering.

```ts
function memoize<T>(fn: () => T): () => T {
  let cached: T | undefined;
  return () => cached ??= fn();
}
```

Performance work rewards measurement over intuition more than almost any other engineering discipline.

## Testing

Testing is the practice of producing evidence that the code does what we believe it does, repeatedly.

Most production bugs come from a class of input that was never represented in the test suite.

Investing in good test infrastructure pays back exponentially as the codebase grows and ages.

### Core invariants of Testing

The following invariants must hold under every operating condition the runtime can reach:

- Tests should describe behavior in language a domain expert could verify by reading.
- Flaky tests need fixing immediately, never tolerating, since they erode trust quickly.
- Coverage metrics indicate gaps, not goals, and should never become a target.

Property-based testing finds edge cases that example-based tests would never have imagined.

> A test suite is a body of evidence that future you can trust past you.

```ts
function describe(name: string, fn: () => void): void {
  registerSuite(name, fn);
}
```

Testing is the discipline that lets engineers sleep peacefully during major deployments.

## Deployment

Deployment is the moment when carefully tested code meets the unpredictable production environment.

Most deployment incidents come from a difference between staging and production that nobody had documented.

Investing in deployment automation pays back the first time a routine release would have woken someone up.

### Core invariants of Deployment

The following invariants must hold under every operating condition the runtime can reach:

- Rollbacks should be as fast and as practiced as rollouts themselves are.
- Feature flags must decouple deployment from release whenever the change has user impact.
- Health checks need to verify behavior, not just process liveness in the simplest sense.

Progressive rollouts catch most production issues before they touch the majority of traffic.

> A deployment system is only as good as its worst rollback experience under pressure.

```ts
function rollout(version: string, percent: number): void {
  flagger.canary(version, percent);
}
```

Deployment turns engineering work into customer value or into an outage post-mortem.

## Migrations

Migrations are the moments when the schema, the wire format, or the protocol must change beneath running traffic.

Most migration disasters come from assuming that no clients depend on the deprecated path being removed.

Planning the rollout in clear phases prevents the worst migration outcomes consistently across years of changes.

### Core invariants of Migrations

The following invariants must hold under every operating condition the runtime can reach:

- Backwards-compatible additions should always precede any breaking removals.
- Dual-writing and dual-reading must overlap so cutover is reversible without panic.
- Old code paths should remain until telemetry proves nobody depends on them anymore.

Treating migrations as multi-week projects rather than single deploys prevents most schema-related incidents.

> A migration that cannot be reversed is a deployment with the safety rails removed.

```ts
async function migrate(from: Version, to: Version): Promise<void> {
  await runner.applySteps(from, to);
}
```

Migrations are where careful engineering pays back more than almost anywhere else.

## Caching

Caching is the technique of remembering expensive results so the system never recomputes them needlessly.

Most cache bugs come from forgetting exactly when the cached value becomes wrong relative to the source.

Designing the invalidation strategy upfront prevents the entire class of subtle staleness bugs from emerging.

### Core invariants of Caching

The following invariants must hold under every operating condition the runtime can reach:

- Cache keys must encode every input that affects the cached value, never partial subsets.
- TTLs should match the actual update cadence of the source, not arbitrary round numbers.
- Cache warming needs to happen carefully so cold restarts do not cascade load downstream.

Treating caches as optimization hints rather than correctness guarantees prevents most staleness incidents entirely.

> There are only two hard problems in computer science: cache invalidation and naming things.

```ts
function cached<T>(key: string, ttl: number, compute: () => T): T {
  return store.getOrSet(key, ttl, compute);
}
```

Caching is the discipline of making fast feel correct without losing either property.

## Queueing

Queues let producers and consumers run at independent rates without coordinating tightly.

Most queue bugs come from forgetting what happens when the consumer falls behind the producer permanently.

Designing queues with explicit backpressure prevents the entire class of unbounded growth incidents.

### Core invariants of Queueing

The following invariants must hold under every operating condition the runtime can reach:

- Every queue needs a defined maximum depth, never relying on infinite memory in practice.
- Consumers must signal slow-down to producers, not silently drop newer arrivals.
- Dead-letter queues should hold poison messages, never blocking the main flow forever.

Monitoring queue depth as a leading indicator catches most consumer slowness before users notice anything.

> An unbounded queue is a memory leak with extra steps and worse symptoms.

```ts
function enqueue(q: Queue, msg: Message): EnqueueResult {
  return q.tryPush(msg);
}
```

Queueing transforms peak load into smooth processing or into an unbounded memory disaster.

## Indexing

Indexes are the data structures that let queries skip past data which cannot possibly match the question.

Most index bugs come from forgetting to update indexes when the underlying data shape changes.

Choosing index keys based on actual query patterns prevents most slow-query incidents proactively.

### Core invariants of Indexing

The following invariants must hold under every operating condition the runtime can reach:

- Index maintenance costs should be measured, never assumed to be negligible in writes.
- Composite indexes must match query predicates in the order the planner expects.
- Unused indexes deserve deletion, since they only slow writes without speeding any reads.

Reviewing query plans periodically catches index drift before users notice latency creeping up.

> An index is a promise to readers paid for by writers.

```ts
function createIndex(table: string, cols: string[]): void {
  db.exec(`CREATE INDEX ON ${table} (${cols.join(",")})`);
}
```

Indexing is the negotiation between query speed and write amplification.

## Streaming

Streaming systems process data as it arrives rather than collecting it into batches first.

Most streaming bugs come from forgetting that events can arrive late, out of order, or duplicated.

Designing for these realities upfront prevents most production stream-processing incidents from ever occurring.

### Core invariants of Streaming

The following invariants must hold under every operating condition the runtime can reach:

- Watermarks should track event time, never just system processing time.
- Late arrivals need explicit handling, whether discarded, redirected, or merged.
- Exactly-once processing requires careful coordination, never just hope and good intentions.

Replaying historical traffic against new pipeline versions surfaces correctness issues that synthetic tests miss.

> Streaming systems are batch systems that have accepted the truth about time.

```ts
function process(stream: Stream, op: Operator): Stream {
  return stream.transform(op);
}
```

Streaming work rewards engineers who take time seriously as a first-class concept.

## Governance

Governance is the discipline of recording why important technical decisions were made and by whom.

Most governance failures come from undocumented decisions that need re-litigation every six months.

Investing in decision records pays back every time someone new joins the project and asks why.

### Core invariants of Governance

The following invariants must hold under every operating condition the runtime can reach:

- Architecture decision records should accompany every irreversible technical choice.
- Reviews must be inclusive enough to surface dissent before commitments harden into code.
- Living documents need ownership, since stale docs are worse than no docs at all.

Treating documentation as code, with reviews and tests, prevents the most common rot patterns.

> Governance is the memory that prevents a team from solving the same problem repeatedly.

```ts
function recordADR(slug: string, body: string): void {
  registry.write(`docs/adr/${slug}.md`, body);
}
```

Governance turns institutional learning into a durable artifact that survives team turnover.

## Conclusion

Mastery here is mostly about resisting the temptation to skip steps that look optional in calm weather.
