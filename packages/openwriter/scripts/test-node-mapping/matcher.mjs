/**
 * Matcher — given an original node graph (with IDs) and a new doc body,
 * produce an updated node graph where surviving blocks keep their IDs.
 *
 * Core principle: the slot is innocent until proven changed. Every mutation
 * rule is a deterministic detector for a specific kind of slot change. If
 * no rule fires for an orphan + unmatched pair, the slot-continuity fallback
 * pairs them by structural position (same type, between same pinned anchors).
 *
 * Rule order:
 *   Phase 1: exact fingerprint match, with position-distance tiebreaker
 *   Phase 2 rules (each math-only, deterministic):
 *     - N-way split detection (sentence-array concatenation)
 *     - N-way merge detection (sentence-array concatenation, reversed)
 *     - Edit detection (shared sentence tuples)
 *     - Slot-continuity fallback (same type, same pinned-anchor neighborhood)
 *     - Insert (any block still unmatched → fresh ID)
 *   Phase 3: orphans = previousNodes entries no rule claimed (= deletes)
 */

import {
  fingerprintAll,
  isExactMatch,
  isSameContent,
  sentenceArraysEqual,
  sentenceTuplesEqual,
} from './fingerprint.mjs';

/**
 * Run the matcher.
 *
 * @param previousNodes - frontmatter `nodes` map from the prior save
 * @param newBlocks - walker output for the new body
 * @param options.graveyard - optional array of recently-deleted entries
 *   (same shape as previousNodes). Lets paste-back/undo restore the ID.
 */
export function matchNodes(previousNodes, newBlocks, options = {}) {
  const graveyard = options.graveyard || [];
  const newFingerprints = fingerprintAll(newBlocks);

  const pinned = [];
  const claimedPrevIds = new Set();
  const claimedGraveIds = new Set();
  const unmatched = newBlocks.map((block, i) => ({
    position: newFingerprints[i].position,
    fingerprint: newFingerprints[i],
    block,
  }));

  // Phase 1 — exact-signal match with position-distance preference
  pinExactMatches(unmatched, previousNodes, claimedPrevIds, pinned);

  // Phase 2 — mutation rules (each is deterministic evidence of slot change)
  applySplitRule(unmatched, previousNodes, claimedPrevIds, pinned);
  applyMergeRule(unmatched, previousNodes, claimedPrevIds, pinned);
  applyTypeChangeRule(unmatched, previousNodes, claimedPrevIds, pinned);
  applyEditRule(unmatched, previousNodes, claimedPrevIds, pinned);

  // Slot-continuity fallback: no evidence of slot change → same slot
  applySlotContinuityRule(unmatched, previousNodes, claimedPrevIds, pinned);

  // Graveyard restore: any unmatched block whose fingerprint exactly matches
  // a recently-deleted entry is an undo / paste-back. Restore the old ID.
  applyGraveyardRestoreRule(unmatched, graveyard, claimedGraveIds, pinned);

  // Insert: anything still unmatched gets a fresh ID
  applyInsertRule(unmatched, pinned);

  const orphaned = previousNodes
    .filter((prev) => !claimedPrevIds.has(prev.id))
    .map((prev) => ({ id: prev.id, fingerprint: prev.fingerprint }));

  // Graveyard remaining = entries no one restored; they expire next cycle
  const remainingGraveyard = graveyard.filter((g) => !claimedGraveIds.has(g.id));

  return {
    pinned,
    unmatched,
    orphaned,
    graveyardRestored: pinned.filter((p) => p.mutation === 'graveyard-restore'),
    nextGraveyard: [...orphaned, ...remainingGraveyard], // fresh orphans + un-restored
    summary: {
      totalBlocks: newBlocks.length,
      pinnedCount: pinned.length,
      unmatchedCount: unmatched.length,
      orphanedCount: orphaned.length,
      coverage: newBlocks.length > 0 ? pinned.length / newBlocks.length : 1,
    },
  };
}

/**
 * Build a new previousNodes map from a matcher result. Use this to thread
 * state between sequential matcher runs (multi-step tests, real save cycles).
 */
export function rebuildPreviousFromResult(result) {
  return result.pinned.map((p) => ({ id: p.id, fingerprint: p.fingerprint }));
}

// ----------------------------------------------------------------------
// Phase 1 — exact-match pinning, two-pass
// ----------------------------------------------------------------------
/**
 * PASS A (mutual-unique): pin (prev, candidate) pairs where prev has exactly
 * one exact-match candidate AND that candidate has exactly one prev claiming
 * it. These are unambiguous identity matches — no math collision possible.
 *
 * PASS B (slot-aware position-distance): for prevs that still have multiple
 * exact-match candidates OR whose only candidate is also claimed by other
 * prevs (math collision), use position-distance — but ONLY within the prev's
 * slot region (between its previous and next pinned anchors).
 *
 * The slot-region constraint prevents math-collision damage. Example: if
 * "Core invariants of Testing" and "Core invariants of Caching" share an
 * identical math fingerprint, deleting Testing must NOT let Testing's ID
 * migrate across the doc to claim Caching's surviving h3 — the new position
 * is far outside Testing's surrounding pinned anchors.
 */
function pinExactMatches(unmatched, previousNodes, claimedPrevIds, pinned) {
  // -------- PASS A: mutual-unique pairs --------
  let changedA = true;
  while (changedA) {
    changedA = false;

    // For each unclaimed prev, list exact-match candidates
    const prevToCands = new Map();
    // For each candidate position, list prevs that exact-match it
    const candToPrevs = new Map();

    for (const prev of previousNodes) {
      if (claimedPrevIds.has(prev.id)) continue;
      const cands = unmatched.filter((u) => isExactMatch(prev.fingerprint, u.fingerprint));
      prevToCands.set(prev.id, cands);
      for (const c of cands) {
        if (!candToPrevs.has(c.position)) candToPrevs.set(c.position, []);
        candToPrevs.get(c.position).push(prev);
      }
    }

    for (const [prevId, cands] of prevToCands) {
      if (claimedPrevIds.has(prevId)) continue;
      if (cands.length !== 1) continue;
      const cand = cands[0];
      const prevs = candToPrevs.get(cand.position);
      if (!prevs || prevs.length !== 1) continue;
      if (!unmatched.includes(cand)) continue;

      const prev = previousNodes.find((p) => p.id === prevId);
      const origPos = prev.fingerprint.position;
      claimedPrevIds.add(prevId);
      pinned.push({
        id: prevId,
        position: cand.position,
        fingerprint: cand.fingerprint,
        block: cand.block,
        mutation: origPos !== cand.position ? 'moved' : 'unchanged',
      });
      const idx = unmatched.indexOf(cand);
      unmatched.splice(idx, 1);
      changedA = true;
    }
  }

  // -------- PASS B: slot-aware position-distance --------
  //
  // Three slot shapes:
  //   - Valid slot (lo + 1 < hi): use strict in-range filtering — protects
  //     against math collisions where a deleted block's ID would otherwise
  //     migrate across the doc to claim a surviving look-alike.
  //   - Empty slot (lo + 1 === hi): anchors adjacent, no room for candidate.
  //     Defer — let slot-continuity / insert handle.
  //   - Inverted slot (lo > hi): anchors got SWAPPED by a section reorder.
  //     Fall back to position-distance over all candidates — the orphan's
  //     slot is fragmented but its identity should track the closest
  //     post-reorder position.
  let changedB = true;
  while (changedB) {
    changedB = false;
    for (const prev of previousNodes) {
      if (claimedPrevIds.has(prev.id)) continue;

      const candidates = unmatched.filter((u) => isExactMatch(prev.fingerprint, u.fingerprint));
      if (candidates.length === 0) continue;

      const prevIdx = previousNodes.findIndex((p) => p.id === prev.id);
      const lo = slotLowBound(previousNodes, claimedPrevIds, pinned, prevIdx);
      const hi = slotHighBound(previousNodes, claimedPrevIds, pinned, prevIdx);

      let inRange;
      if (lo + 1 < hi) {
        inRange = candidates.filter((c) => c.position > lo && c.position < hi);
      } else if (lo > hi) {
        inRange = candidates; // inverted: anchors swapped, use full pos-distance
      } else {
        inRange = []; // empty: no room
      }
      if (inRange.length === 0) continue;

      const origPos = prev.fingerprint.position;
      let best = inRange[0];
      let bestDist = Math.abs(best.position - origPos);
      for (const c of inRange) {
        const d = Math.abs(c.position - origPos);
        if (d < bestDist) {
          best = c;
          bestDist = d;
        }
      }

      claimedPrevIds.add(prev.id);
      pinned.push({
        id: prev.id,
        position: best.position,
        fingerprint: best.fingerprint,
        block: best.block,
        mutation: origPos !== best.position ? 'moved' : 'unchanged',
      });
      const idx = unmatched.indexOf(best);
      unmatched.splice(idx, 1);
      changedB = true;
    }
  }
}

// ----------------------------------------------------------------------
// Split rule — N-way
// ----------------------------------------------------------------------
/**
 * An orphan whose sentence array equals the concatenation of K ≥ 2 adjacent
 * unmatched blocks of the same type is a K-way split. The first block
 * inherits the orphan's ID; the rest get fresh IDs.
 */
function applySplitRule(unmatched, previousNodes, claimedPrevIds, pinned) {
  let progress = true;
  while (progress) {
    progress = false;

    for (const orphan of previousNodes) {
      if (claimedPrevIds.has(orphan.id)) continue;
      const orphanSents = orphan.fingerprint.sentences;
      if (!orphanSents || orphanSents.length < 2) continue;

      let claimed = false;
      for (let startIdx = 0; startIdx < unmatched.length && !claimed; startIdx++) {
        const start = unmatched[startIdx];
        if (start.fingerprint.type !== orphan.fingerprint.type) continue;

        const group = [startIdx];
        let concatLen = start.fingerprint.sentences.length;

        // Walk forward, growing K
        for (let next = startIdx + 1; next < unmatched.length; next++) {
          const prev = unmatched[next - 1];
          const cur = unmatched[next];
          if (cur.position !== prev.position + 1) break;
          if (cur.fingerprint.type !== orphan.fingerprint.type) break;

          group.push(next);
          concatLen += cur.fingerprint.sentences.length;

          if (concatLen > orphanSents.length) break;
          if (concatLen < orphanSents.length) continue;

          // Lengths match — verify full concatenation
          const concat = [];
          for (const gi of group) concat.push(...unmatched[gi].fingerprint.sentences);
          if (!sentenceArraysEqual(concat, orphanSents)) break;

          // K-way split confirmed
          claimedPrevIds.add(orphan.id);
          for (let i = 0; i < group.length; i++) {
            const c = unmatched[group[i]];
            pinned.push({
              id: i === 0 ? orphan.id : freshId(),
              position: c.position,
              fingerprint: c.fingerprint,
              block: c.block,
              mutation: i === 0 ? 'split-first' : `split-${i + 1}`,
            });
          }
          // Remove claimed blocks from unmatched in reverse to preserve indices
          for (let i = group.length - 1; i >= 0; i--) unmatched.splice(group[i], 1);
          claimed = true;
          progress = true;
          break;
        }
      }
    }
  }
}

// ----------------------------------------------------------------------
// Merge rule — N-way
// ----------------------------------------------------------------------
/**
 * An unmatched block whose sentence array equals the concatenation of K ≥ 2
 * adjacent orphans of the same type is a K-way merge. First orphan's ID
 * survives; the rest are consumed (would go to graveyard in production).
 */
function applyMergeRule(unmatched, previousNodes, claimedPrevIds, pinned) {
  let progress = true;
  while (progress) {
    progress = false;

    for (let ui = 0; ui < unmatched.length; ui++) {
      const candidate = unmatched[ui];
      const candidateSents = candidate.fingerprint.sentences;
      if (!candidateSents || candidateSents.length < 2) continue;

      // Find a run of K adjacent unclaimed orphans of same type
      let merged = false;
      for (let startOrphIdx = 0; startOrphIdx < previousNodes.length && !merged; startOrphIdx++) {
        const start = previousNodes[startOrphIdx];
        if (claimedPrevIds.has(start.id)) continue;
        if (start.fingerprint.type !== candidate.fingerprint.type) continue;

        const group = [startOrphIdx];
        let concatLen = start.fingerprint.sentences.length;

        for (let next = startOrphIdx + 1; next < previousNodes.length; next++) {
          const prev = previousNodes[next - 1];
          const cur = previousNodes[next];
          if (claimedPrevIds.has(cur.id)) break;
          if (cur.fingerprint.type !== candidate.fingerprint.type) break;
          if (cur.fingerprint.position !== prev.fingerprint.position + 1) break;

          group.push(next);
          concatLen += cur.fingerprint.sentences.length;

          if (concatLen > candidateSents.length) break;
          if (concatLen < candidateSents.length) continue;

          const concat = [];
          for (const gi of group) concat.push(...previousNodes[gi].fingerprint.sentences);
          if (!sentenceArraysEqual(concat, candidateSents)) break;

          // K-way merge confirmed
          for (const gi of group) claimedPrevIds.add(previousNodes[gi].id);
          pinned.push({
            id: previousNodes[group[0]].id, // first orphan's ID survives
            position: candidate.position,
            fingerprint: candidate.fingerprint,
            block: candidate.block,
            mutation: `merge-${group.length}-way`,
          });
          unmatched.splice(ui, 1);
          merged = true;
          progress = true;
          ui--; // re-check this slot after splice
          break;
        }
      }
      if (merged) break;
    }
  }
}

// ----------------------------------------------------------------------
// Type-change rule — TipTap convention: content survives, type changes
// ----------------------------------------------------------------------
/**
 * An orphan and an unmatched block with IDENTICAL content but DIFFERENT
 * type → type change. Same node, type attr changed.
 *
 * Examples:
 *   - paragraph "Foo" → heading "Foo" (promotion)
 *   - heading "Foo" → paragraph "Foo" (demotion)
 *   - bulletList[3 items] → orderedList[3 items, same items]
 *
 * The candidate's new position must fall within the orphan's slot region
 * (between its previous and next pinned anchors). Without this constraint,
 * a deleted container could "type-change" to an unrelated new container
 * elsewhere in the doc just because their child structures coincidentally
 * match.
 */
function applyTypeChangeRule(unmatched, previousNodes, claimedPrevIds, pinned) {
  let progress = true;
  while (progress) {
    progress = false;

    for (let ui = 0; ui < unmatched.length; ui++) {
      const candidate = unmatched[ui];

      const candidateOrphans = previousNodes.filter((p) => {
        if (claimedPrevIds.has(p.id)) return false;
        if (p.fingerprint.type === candidate.fingerprint.type) return false;
        if (!isSameContent(p.fingerprint, candidate.fingerprint)) return false;
        // Slot-region: candidate must sit within the orphan's surrounding anchors
        const orphanIdx = previousNodes.findIndex((x) => x.id === p.id);
        const lo = slotLowBound(previousNodes, claimedPrevIds, pinned, orphanIdx);
        const hi = slotHighBound(previousNodes, claimedPrevIds, pinned, orphanIdx);
        return candidate.position > lo && candidate.position < hi;
      });

      if (candidateOrphans.length === 0) continue;

      // Position-distance tiebreaker among multiple candidates
      const origPos = candidate.position;
      let best = candidateOrphans[0];
      let bestDist = Math.abs(best.fingerprint.position - origPos);
      for (const o of candidateOrphans) {
        const d = Math.abs(o.fingerprint.position - origPos);
        if (d < bestDist) {
          best = o;
          bestDist = d;
        }
      }

      claimedPrevIds.add(best.id);
      pinned.push({
        id: best.id,
        position: candidate.position,
        fingerprint: candidate.fingerprint,
        block: candidate.block,
        mutation: `type-change-${best.fingerprint.type}-to-${candidate.fingerprint.type}`,
      });
      unmatched.splice(ui, 1);
      progress = true;
      ui--;
    }
  }
}

// ----------------------------------------------------------------------
// Edit rule — content drifted, but at least one sentence tuple still matches
// ----------------------------------------------------------------------
/**
 * An orphan and an unmatched block share enough math signals to confirm
 * "same node, internally edited": same type AND at least one sentence
 * tuple in common. If exactly one such pairing exists AND the candidate
 * sits within the orphan's slot region, the orphan's ID transfers.
 *
 * The slot-region constraint prevents content drift across the doc: e.g.
 * a deleted templated paragraph in one section should NOT inherit-edit
 * into a similarly-templated paragraph in a freshly inserted section.
 *
 * Processed in forward position order so that ties resolve toward
 * earlier-positioned blocks (matching split-first intuition).
 */
function applyEditRule(unmatched, previousNodes, claimedPrevIds, pinned) {
  const unmatchedByPos = [...unmatched].sort((a, b) => a.position - b.position);
  for (const candidate of unmatchedByPos) {
    if (!unmatched.includes(candidate)) continue;

    const candidateOrphans = previousNodes.filter((p) => {
      if (claimedPrevIds.has(p.id)) return false;
      if (p.fingerprint.type !== candidate.fingerprint.type) return false;
      if (!shareAnySentenceTuple(p.fingerprint.sentences, candidate.fingerprint.sentences)) return false;
      const orphanIdx = previousNodes.findIndex((x) => x.id === p.id);
      const lo = slotLowBound(previousNodes, claimedPrevIds, pinned, orphanIdx);
      const hi = slotHighBound(previousNodes, claimedPrevIds, pinned, orphanIdx);
      return candidate.position > lo && candidate.position < hi;
    });

    if (candidateOrphans.length !== 1) continue;

    const orphan = candidateOrphans[0];
    claimedPrevIds.add(orphan.id);
    pinned.push({
      id: orphan.id,
      position: candidate.position,
      fingerprint: candidate.fingerprint,
      block: candidate.block,
      mutation: 'edited',
    });
    const idx = unmatched.indexOf(candidate);
    unmatched.splice(idx, 1);
  }
}

// ----------------------------------------------------------------------
// Slot-continuity fallback
// ----------------------------------------------------------------------
/**
 * The "no evidence of slot change" rule.
 *
 * For each unclaimed orphan, find its surrounding pinned anchors in the
 * previous state (walk backward to the first claimed prev, walk forward
 * to the first claimed prev). Then check if those same pinned IDs are
 * adjacent in the new state, with exactly one unmatched block of the same
 * type between them.
 *
 * If so → the slot is structurally preserved. Pass the orphan's ID through.
 *
 * Catches: renames, single-letter edits, wholesale rewrites where content
 * diverged too much for any content-based rule to fire.
 */
function applySlotContinuityRule(unmatched, previousNodes, claimedPrevIds, pinned) {
  let progress = true;
  while (progress) {
    progress = false;

    // Candidate-centric: for each unmatched block, find orphans in the same
    // slot region, then score by content signal overlap so the BEST-matching
    // orphan wins — not just the first one in iteration order.
    for (let ui = 0; ui < unmatched.length; ui++) {
      const candidate = unmatched[ui];

      // Find orphans whose slot region (between their previous pinned anchors)
      // overlaps the candidate's new position.
      const matchingOrphans = previousNodes.filter((orphan) => {
        if (claimedPrevIds.has(orphan.id)) return false;
        if (orphan.fingerprint.type !== candidate.fingerprint.type) return false;

        const orphanIdx = previousNodes.findIndex((x) => x.id === orphan.id);
        const prevAnchor = findPinnedNeighbor(previousNodes, claimedPrevIds, orphanIdx, -1);
        const nextAnchor = findPinnedNeighbor(previousNodes, claimedPrevIds, orphanIdx, +1);
        const prevNewPos = prevAnchor ? findPinnedPosition(pinned, prevAnchor.id) : -1;
        const nextNewPos = nextAnchor ? findPinnedPosition(pinned, nextAnchor.id) : Infinity;

        return candidate.position > prevNewPos && candidate.position < nextNewPos;
      });

      if (matchingOrphans.length === 0) continue;

      // Score each candidate orphan by lightweight content overlap.
      // Score = number of sentence pairs that share (f, l, t) — strong evidence
      // the sentence persisted across the edit even if char count drifted.
      const scored = matchingOrphans.map((orphan) => ({
        orphan,
        score: sentenceSignalOverlapScore(orphan.fingerprint, candidate.fingerprint),
      }));
      scored.sort((a, b) => b.score - a.score);

      const topScore = scored[0].score;

      // Ambiguity check: if multiple orphans tie at the top score AND that score
      // is zero (no content signal at all), we can't reliably pick. Let candidate
      // fall through to insert; orphans remain as deletes.
      const tied = scored.filter((s) => s.score === topScore);
      if (tied.length > 1 && topScore === 0) continue;

      // Tie-break by position-distance among the top-scored orphans
      let best = tied[0].orphan;
      let bestDist = Math.abs(best.fingerprint.position - candidate.position);
      for (const t of tied) {
        const d = Math.abs(t.orphan.fingerprint.position - candidate.position);
        if (d < bestDist) {
          best = t.orphan;
          bestDist = d;
        }
      }

      claimedPrevIds.add(best.id);
      pinned.push({
        id: best.id,
        position: candidate.position,
        fingerprint: candidate.fingerprint,
        block: candidate.block,
        mutation: 'slot-preserved',
      });
      unmatched.splice(ui, 1);
      ui--;
      progress = true;
    }
  }
}

/**
 * Lightweight content overlap signal. Sums per-field matches across all
 * sentence pairs. Weaker than full tuple equality (the edit rule's bar)
 * but strong enough to disambiguate orphans when content drifted past
 * the strict-equality threshold.
 *
 * For each sentence-pair, contributes:
 *   +1 if first chars match
 *   +1 if last chars match
 *   +1 if terminators match
 *   +2 if word-length sequences match
 *   +3 × (number of shared distinct words) — word overlap is the
 *      strongest available signal short of full equality
 *   +10 if the entire word array matches exactly
 *
 * Higher score = stronger evidence the orphan and candidate are the same
 * node with edited content.
 */
function sentenceSignalOverlapScore(a, b) {
  if (!a.sentences || !b.sentences) return 0;
  let score = 0;
  for (const sa of a.sentences) {
    for (const sb of b.sentences) {
      if (sa.f === sb.f) score++;
      if (sa.l === sb.l) score++;
      if (sa.t === sb.t) score++;
      if (arraysEqual(sa.wls, sb.wls)) score += 2;
      // Word-level overlap — the disambiguator when math signals collide
      if (Array.isArray(sa.w) && Array.isArray(sb.w)) {
        const aSet = new Set(sa.w);
        let shared = 0;
        for (const w of sb.w) if (aSet.has(w)) shared++;
        score += shared * 3;
        if (arraysEqual(sa.w, sb.w)) score += 10;
      }
    }
  }
  return score;
}

// ----------------------------------------------------------------------
// Graveyard restore rule — paste-back / undo detection
// ----------------------------------------------------------------------
/**
 * Any unmatched block whose fingerprint exactly matches a graveyard entry
 * is restored (undo, paste-back). The original ID returns.
 *
 * Exact-match only (full math fingerprint). Partial-match would risk
 * confusing "user re-typed similar text" with "user restored the deleted
 * paragraph"; better to be strict and let the edit rule handle drift cases.
 */
function applyGraveyardRestoreRule(unmatched, graveyard, claimedGraveIds, pinned) {
  for (let ui = unmatched.length - 1; ui >= 0; ui--) {
    const candidate = unmatched[ui];

    const ghostMatches = graveyard.filter(
      (g) => !claimedGraveIds.has(g.id) && isExactMatch(g.fingerprint, candidate.fingerprint)
    );
    if (ghostMatches.length === 0) continue;

    // Position-distance preference (graveyard entries carry their last-known position)
    const candPos = candidate.position;
    let best = ghostMatches[0];
    let bestDist = Math.abs(best.fingerprint.position - candPos);
    for (const g of ghostMatches) {
      const d = Math.abs(g.fingerprint.position - candPos);
      if (d < bestDist) {
        best = g;
        bestDist = d;
      }
    }

    claimedGraveIds.add(best.id);
    pinned.push({
      id: best.id,
      position: candidate.position,
      fingerprint: candidate.fingerprint,
      block: candidate.block,
      mutation: 'graveyard-restore',
    });
    unmatched.splice(ui, 1);
  }
}

// ----------------------------------------------------------------------
// Insert rule (last resort) and helpers
// ----------------------------------------------------------------------
function applyInsertRule(unmatched, pinned) {
  for (let i = unmatched.length - 1; i >= 0; i--) {
    const candidate = unmatched[i];
    pinned.push({
      id: freshId(),
      position: candidate.position,
      fingerprint: candidate.fingerprint,
      block: candidate.block,
      mutation: 'inserted',
    });
    unmatched.splice(i, 1);
  }
}

function findPinnedNeighbor(previousNodes, claimedPrevIds, startIdx, direction) {
  for (let i = startIdx + direction; i >= 0 && i < previousNodes.length; i += direction) {
    if (claimedPrevIds.has(previousNodes[i].id)) return previousNodes[i];
  }
  return null;
}

function findPinnedPosition(pinned, id) {
  const entry = pinned.find((p) => p.id === id);
  return entry ? entry.position : -1;
}

/** Lowest valid new-doc position for an orphan's slot (exclusive lower bound). */
function slotLowBound(previousNodes, claimedPrevIds, pinned, orphanIdx) {
  const prev = findPinnedNeighbor(previousNodes, claimedPrevIds, orphanIdx, -1);
  return prev ? findPinnedPosition(pinned, prev.id) : -1;
}

/** Highest valid new-doc position for an orphan's slot (exclusive upper bound). */
function slotHighBound(previousNodes, claimedPrevIds, pinned, orphanIdx) {
  const next = findPinnedNeighbor(previousNodes, claimedPrevIds, orphanIdx, +1);
  return next ? findPinnedPosition(pinned, next.id) : Infinity;
}

/**
 * Returns true if any sentence in `a` is fully equal (math + words) to
 * any sentence in `b`. Word equality is required so that math-colliding
 * sentences with different actual content do not falsely register as
 * "shared" in the edit rule.
 */
function shareAnySentenceTuple(aSentences, bSentences) {
  if (!Array.isArray(aSentences) || !Array.isArray(bSentences)) return false;
  for (const sa of aSentences) {
    for (const sb of bSentences) {
      if (sentenceTuplesEqual(sa, sb)) return true;
    }
  }
  return false;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let freshIdCounter = 0;
function freshId() {
  freshIdCounter++;
  return `new${String(freshIdCounter).padStart(3, '0')}`;
}

/**
 * Build a previousNodes map from a walker output.
 */
export function bootstrapPreviousNodes(originalBlocks) {
  freshIdCounter = 0;
  const fps = fingerprintAll(originalBlocks);
  return originalBlocks.map((block, i) => ({
    id: `n${String(i).padStart(3, '0')}`,
    fingerprint: fps[i],
  }));
}
