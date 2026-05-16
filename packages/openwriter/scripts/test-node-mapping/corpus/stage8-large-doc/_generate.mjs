/**
 * One-shot generator for stage8-large-doc corpus.
 *
 * Produces original.md (~250 blocks) and a set of mutations exercising:
 *   - scattered single edits
 *   - whole-section deletion
 *   - whole-section insertion
 *   - section reorder
 *   - mass split / mass merge
 *   - mass type change
 *   - mixed everything
 *
 * Each section uses DIFFERENT phrasings so blocks have unique math
 * fingerprints. This lets the matcher rely on content signals instead
 * of just position-distance disambiguation.
 *
 * Run from this directory:
 *   node _generate.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 15 themed sections. Each has its own unique paragraph phrasings.
// `intro` / `weight` / `cost` / `bullets` / `defense` / `quote` / `code` / `closer`
// — every string is bespoke per section so math fingerprints are unique.
const SECTIONS = [
  {
    theme: 'Architecture',
    intro: 'Architecture decisions outlive the people who make them. Each one casts a long shadow forward into time.',
    weight: 'Teams underestimate how much weight rests on this single foundation. They discover the lesson only after a serious incident.',
    cost: 'Designing it carefully upfront saves enormous downstream pain. Cutting corners defers the bill without erasing it.',
    bullets: [
      'Every architectural choice should record its rationale before any code lands.',
      'Recovery paths must never assume that earlier state survives a process restart.',
      'Operators need to inspect the system without altering it through observation.',
    ],
    defense: 'Documenting the architecture in code, not just prose, is the only durable defense. Comments fade; assertions remain.',
    quote: 'A system that cannot explain its own architecture during an incident will eventually be replaced.',
    code: 'function checkArchitecture(state: SystemState): boolean {\n  return state.invariants.every((inv) => inv.holds(state));\n}',
    closer: 'Section one ends with a reminder that every architectural choice echoes through every future decision downstream.',
  },
  {
    theme: 'Persistence',
    intro: 'Persistence is where optimistic code meets disappointing reality. Disks fail, networks partition, processes crash.',
    weight: 'Most engineers learn to fear persistence layer bugs only after losing real production data. The cost of that lesson is enormous.',
    cost: 'A careful storage design prevents most catastrophes outright. A careless one merely postpones the inevitable failure mode.',
    bullets: [
      'Writes should be durable on disk before any external acknowledgment ships.',
      'Reads must tolerate stale replicas without ever returning silent corruption.',
      'Recovery procedures need rehearsal, not just documentation in a wiki.',
    ],
    defense: 'Testing persistence under failure injection is the cheapest insurance any team can buy against future midnight pages.',
    quote: 'A storage layer that has never lost data is a storage layer that has never been tested honestly.',
    code: 'async function flush(buffer: Buffer): Promise<void> {\n  await fsync(buffer.fd);\n  buffer.markDurable();\n}',
    closer: 'Persistence work feels invisible when it succeeds and unforgettable when it fails publicly.',
  },
  {
    theme: 'Concurrency',
    intro: 'Concurrency turns simple problems into combinatorial nightmares. Two threads sharing a counter is harder than it looks.',
    weight: 'The bugs that matter most in concurrent systems only manifest under specific timing windows nobody anticipated.',
    cost: 'Reasoning through race conditions early prevents a long tail of mysterious incidents months later.',
    bullets: [
      'Shared mutable state should be the exception, never the comfortable default.',
      'Locks must be acquired in a consistent global order across all critical paths.',
      'Tests need to exercise interleavings, not just sequential happy paths.',
    ],
    defense: 'Single-writer designs sidestep most concurrency hazards by construction rather than by careful coding.',
    quote: 'Every concurrent bug looks obvious in hindsight and impossible in foresight.',
    code: 'function tryAcquire(mu: Mutex, timeout: Duration): boolean {\n  return mu.lockWithTimeout(timeout);\n}',
    closer: 'Concurrency rewards the cautious and punishes the optimistic without ever explaining itself.',
  },
  {
    theme: 'Observability',
    intro: 'Observability is the right to ask new questions of a running system without redeploying it first.',
    weight: 'Without observability, operators are reduced to guessing during the precise moments when guessing is most dangerous.',
    cost: 'Investing in good telemetry pays back the first time an unexpected production incident appears in the dashboard.',
    bullets: [
      'Logs, metrics, and traces should converge on the same request identifier across services.',
      'Sampling needs to preserve the rare and interesting events, never just the common ones.',
      'Dashboards must answer questions, not merely display impressive walls of numbers.',
    ],
    defense: 'Building observability before the first launch is far cheaper than retrofitting it after an outage forces the issue.',
    quote: 'You cannot improve what you refuse to measure honestly.',
    code: 'function emit(event: TraceEvent): void {\n  tracer.record(event);\n  metrics.increment(event.kind);\n}',
    closer: 'Observability turns operations from a guessing game into a disciplined investigation.',
  },
  {
    theme: 'Reliability',
    intro: 'Reliability is the property that a system keeps working even when individual parts of it stop working.',
    weight: 'Most reliability bugs come from optimistic assumptions about how often things will succeed in practice.',
    cost: 'Designing for failure from day one is uncomfortable but vastly cheaper than retrofitting reliability later.',
    bullets: [
      'Every external call should have a timeout, a retry, and a circuit breaker policy.',
      'Bulkheads must isolate failures so one component cannot drag down the rest.',
      'Graceful degradation needs explicit design, never accidental emergence under pressure.',
    ],
    defense: 'Chaos engineering surfaces hidden reliability assumptions before customers do it for you involuntarily.',
    quote: 'A reliable system is not one that never fails but one whose failures stay contained.',
    code: 'function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy): Promise<T> {\n  return policy.execute(fn);\n}',
    closer: 'Reliability work consists mostly of imagining failures vividly enough to prevent them.',
  },
  {
    theme: 'Security',
    intro: 'Security is what protects the system from people whose interests diverge from yours sharply enough to act.',
    weight: 'Most security bugs come from forgetting that adversaries are creative, patient, and cheaper than your defenses.',
    cost: 'Threat modeling at design time catches whole classes of vulnerability before they reach production code.',
    bullets: [
      'Inputs from outside the trust boundary should be validated before any structural use.',
      'Secrets must never appear in logs, error messages, or version control by accident.',
      'Least-privilege access needs enforcement at every layer, not just the outermost one.',
    ],
    defense: 'Security reviews work best when they happen continuously, not just at major release boundaries.',
    quote: 'Defense in depth means the attacker must defeat every layer, not just the weakest one.',
    code: 'function sanitize(input: string): string {\n  return validator.escape(input);\n}',
    closer: 'Security is a property of culture as much as of any specific piece of code.',
  },
  {
    theme: 'Performance',
    intro: 'Performance work means making the same correct system spend less time and memory doing the same correct things.',
    weight: 'Most performance bugs come from forgetting which operations dominate the steady-state cost profile.',
    cost: 'Measuring before optimizing prevents the most expensive engineering mistake possible: optimizing the wrong thing.',
    bullets: [
      'Profiles should drive optimization priorities, never gut feelings about hot paths.',
      'Caches must invalidate correctly, otherwise they merely launder stale data faster.',
      'Allocation patterns deserve as much attention as algorithmic complexity does.',
    ],
    defense: 'Continuous benchmarking catches performance regressions before users notice the slowdown firsthand.',
    quote: 'Premature optimization is the root of all evil but considered optimization is the heart of engineering.',
    code: 'function memoize<T>(fn: () => T): () => T {\n  let cached: T | undefined;\n  return () => cached ??= fn();\n}',
    closer: 'Performance work rewards measurement over intuition more than almost any other engineering discipline.',
  },
  {
    theme: 'Testing',
    intro: 'Testing is the practice of producing evidence that the code does what we believe it does, repeatedly.',
    weight: 'Most production bugs come from a class of input that was never represented in the test suite.',
    cost: 'Investing in good test infrastructure pays back exponentially as the codebase grows and ages.',
    bullets: [
      'Tests should describe behavior in language a domain expert could verify by reading.',
      'Flaky tests need fixing immediately, never tolerating, since they erode trust quickly.',
      'Coverage metrics indicate gaps, not goals, and should never become a target.',
    ],
    defense: 'Property-based testing finds edge cases that example-based tests would never have imagined.',
    quote: 'A test suite is a body of evidence that future you can trust past you.',
    code: 'function describe(name: string, fn: () => void): void {\n  registerSuite(name, fn);\n}',
    closer: 'Testing is the discipline that lets engineers sleep peacefully during major deployments.',
  },
  {
    theme: 'Deployment',
    intro: 'Deployment is the moment when carefully tested code meets the unpredictable production environment.',
    weight: 'Most deployment incidents come from a difference between staging and production that nobody had documented.',
    cost: 'Investing in deployment automation pays back the first time a routine release would have woken someone up.',
    bullets: [
      'Rollbacks should be as fast and as practiced as rollouts themselves are.',
      'Feature flags must decouple deployment from release whenever the change has user impact.',
      'Health checks need to verify behavior, not just process liveness in the simplest sense.',
    ],
    defense: 'Progressive rollouts catch most production issues before they touch the majority of traffic.',
    quote: 'A deployment system is only as good as its worst rollback experience under pressure.',
    code: 'function rollout(version: string, percent: number): void {\n  flagger.canary(version, percent);\n}',
    closer: 'Deployment turns engineering work into customer value or into an outage post-mortem.',
  },
  {
    theme: 'Migrations',
    intro: 'Migrations are the moments when the schema, the wire format, or the protocol must change beneath running traffic.',
    weight: 'Most migration disasters come from assuming that no clients depend on the deprecated path being removed.',
    cost: 'Planning the rollout in clear phases prevents the worst migration outcomes consistently across years of changes.',
    bullets: [
      'Backwards-compatible additions should always precede any breaking removals.',
      'Dual-writing and dual-reading must overlap so cutover is reversible without panic.',
      'Old code paths should remain until telemetry proves nobody depends on them anymore.',
    ],
    defense: 'Treating migrations as multi-week projects rather than single deploys prevents most schema-related incidents.',
    quote: 'A migration that cannot be reversed is a deployment with the safety rails removed.',
    code: 'async function migrate(from: Version, to: Version): Promise<void> {\n  await runner.applySteps(from, to);\n}',
    closer: 'Migrations are where careful engineering pays back more than almost anywhere else.',
  },
  {
    theme: 'Caching',
    intro: 'Caching is the technique of remembering expensive results so the system never recomputes them needlessly.',
    weight: 'Most cache bugs come from forgetting exactly when the cached value becomes wrong relative to the source.',
    cost: 'Designing the invalidation strategy upfront prevents the entire class of subtle staleness bugs from emerging.',
    bullets: [
      'Cache keys must encode every input that affects the cached value, never partial subsets.',
      'TTLs should match the actual update cadence of the source, not arbitrary round numbers.',
      'Cache warming needs to happen carefully so cold restarts do not cascade load downstream.',
    ],
    defense: 'Treating caches as optimization hints rather than correctness guarantees prevents most staleness incidents entirely.',
    quote: 'There are only two hard problems in computer science: cache invalidation and naming things.',
    code: 'function cached<T>(key: string, ttl: number, compute: () => T): T {\n  return store.getOrSet(key, ttl, compute);\n}',
    closer: 'Caching is the discipline of making fast feel correct without losing either property.',
  },
  {
    theme: 'Queueing',
    intro: 'Queues let producers and consumers run at independent rates without coordinating tightly.',
    weight: 'Most queue bugs come from forgetting what happens when the consumer falls behind the producer permanently.',
    cost: 'Designing queues with explicit backpressure prevents the entire class of unbounded growth incidents.',
    bullets: [
      'Every queue needs a defined maximum depth, never relying on infinite memory in practice.',
      'Consumers must signal slow-down to producers, not silently drop newer arrivals.',
      'Dead-letter queues should hold poison messages, never blocking the main flow forever.',
    ],
    defense: 'Monitoring queue depth as a leading indicator catches most consumer slowness before users notice anything.',
    quote: 'An unbounded queue is a memory leak with extra steps and worse symptoms.',
    code: 'function enqueue(q: Queue, msg: Message): EnqueueResult {\n  return q.tryPush(msg);\n}',
    closer: 'Queueing transforms peak load into smooth processing or into an unbounded memory disaster.',
  },
  {
    theme: 'Indexing',
    intro: 'Indexes are the data structures that let queries skip past data which cannot possibly match the question.',
    weight: 'Most index bugs come from forgetting to update indexes when the underlying data shape changes.',
    cost: 'Choosing index keys based on actual query patterns prevents most slow-query incidents proactively.',
    bullets: [
      'Index maintenance costs should be measured, never assumed to be negligible in writes.',
      'Composite indexes must match query predicates in the order the planner expects.',
      'Unused indexes deserve deletion, since they only slow writes without speeding any reads.',
    ],
    defense: 'Reviewing query plans periodically catches index drift before users notice latency creeping up.',
    quote: 'An index is a promise to readers paid for by writers.',
    code: 'function createIndex(table: string, cols: string[]): void {\n  db.exec(`CREATE INDEX ON ${table} (${cols.join(",")})`);\n}',
    closer: 'Indexing is the negotiation between query speed and write amplification.',
  },
  {
    theme: 'Streaming',
    intro: 'Streaming systems process data as it arrives rather than collecting it into batches first.',
    weight: 'Most streaming bugs come from forgetting that events can arrive late, out of order, or duplicated.',
    cost: 'Designing for these realities upfront prevents most production stream-processing incidents from ever occurring.',
    bullets: [
      'Watermarks should track event time, never just system processing time.',
      'Late arrivals need explicit handling, whether discarded, redirected, or merged.',
      'Exactly-once processing requires careful coordination, never just hope and good intentions.',
    ],
    defense: 'Replaying historical traffic against new pipeline versions surfaces correctness issues that synthetic tests miss.',
    quote: 'Streaming systems are batch systems that have accepted the truth about time.',
    code: 'function process(stream: Stream, op: Operator): Stream {\n  return stream.transform(op);\n}',
    closer: 'Streaming work rewards engineers who take time seriously as a first-class concept.',
  },
  {
    theme: 'Governance',
    intro: 'Governance is the discipline of recording why important technical decisions were made and by whom.',
    weight: 'Most governance failures come from undocumented decisions that need re-litigation every six months.',
    cost: 'Investing in decision records pays back every time someone new joins the project and asks why.',
    bullets: [
      'Architecture decision records should accompany every irreversible technical choice.',
      'Reviews must be inclusive enough to surface dissent before commitments harden into code.',
      'Living documents need ownership, since stale docs are worse than no docs at all.',
    ],
    defense: 'Treating documentation as code, with reviews and tests, prevents the most common rot patterns.',
    quote: 'Governance is the memory that prevents a team from solving the same problem repeatedly.',
    code: 'function recordADR(slug: string, body: string): void {\n  registry.write(`docs/adr/${slug}.md`, body);\n}',
    closer: 'Governance turns institutional learning into a durable artifact that survives team turnover.',
  },
];

function sectionMarkdown(s, idx) {
  return `## ${s.theme}

${s.intro}

${s.weight}

${s.cost}

### Core invariants of ${s.theme}

The following invariants must hold under every operating condition the runtime can reach:

- ${s.bullets[0]}
- ${s.bullets[1]}
- ${s.bullets[2]}

${s.defense}

> ${s.quote}

\`\`\`ts
${s.code}
\`\`\`

${s.closer}
`;
}

function buildOriginal() {
  const parts = [
    '# Distributed Systems Field Guide',
    '',
    'This document collects field-tested patterns for building systems that survive contact with production traffic.',
    '',
    'Each section addresses one cross-cutting concern. Sections can be read in any order, though earlier sections establish vocabulary later ones rely on.',
    '',
  ];
  SECTIONS.forEach((s, i) => {
    parts.push(sectionMarkdown(s, i));
  });
  parts.push('## Conclusion');
  parts.push('');
  parts.push('Mastery here is mostly about resisting the temptation to skip steps that look optional in calm weather.');
  parts.push('');
  return parts.join('\n');
}

// --- Mutation generators -------------------------------------------------

const ORIGINAL = buildOriginal();

function mutate(replacements) {
  let out = ORIGINAL;
  for (const [from, to] of replacements) {
    if (!out.includes(from)) throw new Error(`Substring not found: ${JSON.stringify(from.slice(0, 80))}`);
    out = out.replace(from, to);
  }
  return out;
}

// 1. Scattered edits — change one sentence in 5 different paragraphs
function mut01ScatteredEdits() {
  return mutate([
    ['Each one casts a long shadow forward into time.', 'Each one casts a very long shadow forward into the indefinite future.'],
    ['Disks fail, networks partition, processes crash.', 'Disks fail unexpectedly, networks partition without warning, and processes crash mid-transaction.'],
    ['Two threads sharing a counter is harder than it looks.', 'Two threads sharing a single counter is far harder than anyone initially expects.'],
    ['Comments fade; assertions remain.', 'Comments fade away over time; assertions remain enforced forever.'],
    ['Mastery here is mostly about resisting the temptation to skip steps that look optional in calm weather.', 'True mastery here comes down to resisting the urge to skip the steps that appear optional during calm weather.'],
  ]);
}

// 2. Whole-section deletion — remove the Caching section entirely
function mut02DeleteSection() {
  const target = sectionMarkdown(SECTIONS[10], 10);
  if (!ORIGINAL.includes(target)) throw new Error('Caching section not found');
  return ORIGINAL.replace(target, '');
}

// 3. Whole-section insertion — add a new section between Indexing and Streaming
function mut03InsertSection() {
  const newSection = sectionMarkdown(
    {
      theme: 'Replication',
      intro: 'Replication is the practice of keeping the same data in two or more places simultaneously.',
      weight: 'Most replication bugs come from underestimating how often the network becomes temporarily unreliable.',
      cost: 'Designing replication topologies with explicit conflict resolution prevents most data-divergence incidents.',
      bullets: [
        'Primary-secondary topologies must define failover behavior before the first incident happens.',
        'Multi-master setups need conflict resolution rules baked into the application layer.',
        'Read replicas should expose their lag so clients can decide whether to trust the response.',
      ],
      defense: 'Treating replication lag as a first-class observability signal prevents most stale-read incidents preemptively.',
      quote: 'A replica that has never been promoted is a replica that has never been tested honestly.',
      code: 'function replicate(primary: Node, secondary: Node): void {\n  secondary.followLogOf(primary);\n}',
      closer: 'Replication is the technique that turns single-machine fragility into distributed durability.',
    },
    99,
  );
  const anchor = sectionMarkdown(SECTIONS[13], 13); // Streaming
  return ORIGINAL.replace(anchor, newSection + '\n' + anchor);
}

// 4. Section reorder — swap Security and Performance
function mut04SectionReorder() {
  const sec5 = sectionMarkdown(SECTIONS[5], 5);
  const sec6 = sectionMarkdown(SECTIONS[6], 6);
  return ORIGINAL.replace(sec5, '__SEC5__').replace(sec6, '__SEC6__').replace('__SEC5__', sec6).replace('__SEC6__', sec5);
}

// 5. Mass split — split the intro sentence of 5 different sections into two paragraphs
function mut05MassSplit() {
  return mutate([
    [SECTIONS[0].intro, SECTIONS[0].intro.replace('. ', '.\n\n')],
    [SECTIONS[2].intro, SECTIONS[2].intro.replace('. ', '.\n\n')],
    [SECTIONS[4].intro, SECTIONS[4].intro.replace('. ', '.\n\n')],
    [SECTIONS[6].intro, SECTIONS[6].intro.replace('. ', '.\n\n')],
    [SECTIONS[8].intro, SECTIONS[8].intro.replace('. ', '.\n\n')],
  ]);
}

// 6. Mass merge — merge the `weight` and `cost` paragraphs in 5 sections
function mut06MassMerge() {
  const pairs = [0, 3, 5, 9, 12].map((i) => {
    const before = `${SECTIONS[i].weight}\n\n${SECTIONS[i].cost}`;
    const after = `${SECTIONS[i].weight} ${SECTIONS[i].cost}`;
    return [before, after];
  });
  return mutate(pairs);
}

// 7. Mass type-change — promote 5 section closers to h4 headings
function mut07MassTypeChange() {
  return mutate([
    [SECTIONS[0].closer, `#### ${SECTIONS[0].closer}`],
    [SECTIONS[3].closer, `#### ${SECTIONS[3].closer}`],
    [SECTIONS[6].closer, `#### ${SECTIONS[6].closer}`],
    [SECTIONS[9].closer, `#### ${SECTIONS[9].closer}`],
    [SECTIONS[12].closer, `#### ${SECTIONS[12].closer}`],
  ]);
}

// 8. Mixed everything — edit + delete + insert + type-change all in one mutation
function mut08MixedEverything() {
  let out = ORIGINAL;
  // delete Testing section
  out = out.replace(sectionMarkdown(SECTIONS[7], 7), '');
  // promote one closer
  out = out.replace(SECTIONS[1].closer, `#### ${SECTIONS[1].closer}`);
  // edit a sentence
  out = out.replace('Comments fade; assertions remain.', 'Comments fade away over time; assertions remain enforced forever.');
  // insert new section after Migrations
  const newSection = sectionMarkdown(
    {
      theme: 'Federation',
      intro: 'Federation is the architecture pattern of connecting independent systems that retain their own authority.',
      weight: 'Most federation bugs come from forgetting that the participant systems evolve at different speeds.',
      cost: 'Designing federation contracts carefully prevents tight coupling from sneaking back in through implementation details.',
      bullets: [
        'Each participant must remain authoritative over its own internal data shape.',
        'Cross-participant queries should compose, never require flattening into a single global model.',
        'Schema evolution needs explicit versioning at the boundary, never implicit propagation.',
      ],
      defense: 'Treating federation as a long-term commitment rather than a quick integration prevents most coordination failures.',
      quote: 'Federation lets autonomous teams collaborate without surrendering their autonomy.',
      code: 'function federate(participants: System[]): Federation {\n  return new Federation(participants);\n}',
      closer: 'Federation is the technique that lets institutional independence coexist with technical interoperability.',
    },
    99,
  );
  out = out.replace(sectionMarkdown(SECTIONS[10], 10), newSection + '\n' + sectionMarkdown(SECTIONS[10], 10));
  return out;
}

// 9. Bulk insert 10 conclusion paragraphs
function mut09BulkInsertParagraphs() {
  const additions = Array.from({ length: 10 }, (_, i) =>
    `Lesson ${i + 1} reminds the reader that humility under load remains the only durable engineering virtue worth cultivating regularly.`,
  ).join('\n\n');
  return ORIGINAL.replace(
    'Mastery here is mostly about resisting the temptation to skip steps that look optional in calm weather.',
    'Mastery here is mostly about resisting the temptation to skip steps that look optional in calm weather.\n\n' + additions,
  );
}

// 10. Scattered deletes — delete the `defense` paragraph in 8 sections
function mut10ScatteredDeletes() {
  let out = ORIGINAL;
  for (let i = 0; i < SECTIONS.length; i += 2) {
    const target = '\n\n' + SECTIONS[i].defense;
    out = out.replace(target, '');
  }
  return out;
}

// --- Write everything ----------------------------------------------------

const mutationsDir = join(__dirname, 'mutations');
if (!existsSync(mutationsDir)) mkdirSync(mutationsDir, { recursive: true });

writeFileSync(join(__dirname, 'original.md'), ORIGINAL);

writeFileSync(join(mutationsDir, '01-scattered-edits.md'), mut01ScatteredEdits());
writeFileSync(join(mutationsDir, '02-delete-section.md'), mut02DeleteSection());
writeFileSync(join(mutationsDir, '03-insert-section.md'), mut03InsertSection());
writeFileSync(join(mutationsDir, '04-section-reorder.md'), mut04SectionReorder());
writeFileSync(join(mutationsDir, '05-mass-split.md'), mut05MassSplit());
writeFileSync(join(mutationsDir, '06-mass-merge.md'), mut06MassMerge());
writeFileSync(join(mutationsDir, '07-mass-type-change.md'), mut07MassTypeChange());
writeFileSync(join(mutationsDir, '08-mixed-everything.md'), mut08MixedEverything());
writeFileSync(join(mutationsDir, '09-bulk-insert-paragraphs.md'), mut09BulkInsertParagraphs());
writeFileSync(join(mutationsDir, '10-scattered-deletes.md'), mut10ScatteredDeletes());

console.log('stage8-large-doc corpus generated.');
console.log('  original.md:', ORIGINAL.length, 'chars,', ORIGINAL.split('\n').length, 'lines');
