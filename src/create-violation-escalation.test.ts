// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { test, expect } from "bun:test";
import { createViolationEscalation } from "./create-violation-escalation";
import type { ViolationEscalationConfig } from "./types";

function makeSetup(overrides: Partial<ViolationEscalationConfig> = {}) {
	const upserts: Array<{ key: string; summary: string; firstSeenAt: Date }> = [];
	const recovered: string[] = [];
	const notified: Array<{ slug: string; failures: number }> = [];
	const unhealthy: Array<{ slug: string; failures: number }> = [];
	const escalated: Array<{ slug: string; failures: number }> = [];
	const recoveredHooks: Array<{ slug: string; prev: number }> = [];
	const esc = createViolationEscalation({
		name: "test",
		defaultThreshold: 3,
		writer: {
			upsertTask: async (a) => {
				upserts.push(a);
				return `task-${upserts.length}`;
			},
			recoverTask: async (k) => {
				recovered.push(k);
			},
		},
		notify: async (slug, failures) => {
			notified.push({ slug, failures });
		},
		onMonitorUnhealthy: (slug, failures) => {
			unhealthy.push({ slug, failures });
		},
		onEscalated: (slug, failures) => {
			escalated.push({ slug, failures });
		},
		onRecovered: (slug, prev) => {
			recoveredHooks.push({ slug, prev });
		},
		...overrides,
	});
	return { esc, upserts, recovered, notified, unhealthy, escalated, recoveredHooks };
}

test("does not escalate before threshold; escalates exactly once at threshold", async () => {
	const { esc, upserts, notified, escalated } = makeSetup();
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	expect(upserts.length).toBe(0);
	expect(notified.length).toBe(0);

	const r = await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	expect(r.escalated).toBe(true);
	expect(upserts.length).toBe(1);
	expect(notified.length).toBe(1);
	expect(escalated.length).toBe(1);
	expect(escalated[0].failures).toBe(3);
});

test("dedupes: a continued failure streak does not spawn a second task or notify", async () => {
	const { esc, upserts, notified } = makeSetup();
	for (let i = 0; i < 3; i++) await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	expect(upserts.length).toBe(1);
	expect(notified.length).toBe(1);
	// 4th, 5th consecutive failure — still one task, one notify.
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	expect(upserts.length).toBe(1);
	expect(notified.length).toBe(1);
});

test("recovery closes the task and allows re-escalation on a fresh streak", async () => {
	const { esc, upserts, recovered, recoveredHooks } = makeSetup();
	for (let i = 0; i < 3; i++) await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	expect(upserts.length).toBe(1);

	await esc.handleOutcome("r1", { failed: false, violations: [] });
	expect(recovered.length).toBe(1);
	expect(recovered.length).toBe(1);
	expect(recoveredHooks[0].prev).toBe(3);

	// A single new failure must NOT recover-or-reuse; needs a full streak again.
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	expect(upserts.length).toBe(1);
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	expect(upserts.length).toBe(2);
});

test("a passing cycle for a never-escalated rule is a no-op (no recover)", async () => {
	const { esc, recovered } = makeSetup();
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	await esc.handleOutcome("r1", { failed: false, violations: [] });
	expect(recovered.length).toBe(0);
});

test("monitor never escalates (observability only) — no task, no notify, unhealthy hook fires", async () => {
	const { esc, upserts, notified, unhealthy } = makeSetup({ defaultThreshold: 2 });
	await esc.handleOutcome("m1", { failed: true, violations: ["x"], isMonitor: true });
	expect(unhealthy.length).toBe(0);
	const r = await esc.handleOutcome("m1", { failed: true, violations: ["x"], isMonitor: true });
	expect(r.escalated).toBe(false);
	expect(upserts.length).toBe(0);
	expect(notified.length).toBe(0);
	expect(unhealthy.length).toBe(1);
	expect(unhealthy[0].failures).toBe(2);
});

test("per-call threshold override works", async () => {
	const { esc, upserts } = makeSetup({ defaultThreshold: 5 });
	const r = await esc.handleOutcome("r1", {
		failed: true,
		violations: ["a"],
		threshold: 1,
	});
	expect(r.escalated).toBe(true);
	expect(upserts.length).toBe(1);
});

test("custom taskKeyFor is used for upsert + recover", async () => {
	const upserts: string[] = [];
	const recovered: string[] = [];
	const esc = createViolationEscalation({
		name: "test",
		defaultThreshold: 1,
		taskKeyFor: (slug) => `custom::${slug}`,
		writer: {
			upsertTask: async (a) => {
				upserts.push(a.key);
				return null;
			},
			recoverTask: async (k) => {
				recovered.push(k);
			},
		},
	});
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	await esc.handleOutcome("r1", { failed: false, violations: [] });
	expect(upserts).toEqual(["custom::r1"]);
	expect(recovered).toEqual(["custom::r1"]);
});

test("rules are tracked independently", async () => {
	const { esc, upserts } = makeSetup({ defaultThreshold: 2 });
	await esc.handleOutcome("a", { failed: true, violations: ["x"] });
	await esc.handleOutcome("b", { failed: true, violations: ["y"] });
	await esc.handleOutcome("a", { failed: true, violations: ["x"] });
	await esc.handleOutcome("b", { failed: true, violations: ["y"] });
	expect(upserts.length).toBe(2);
});

test("reset clears all in-memory state", async () => {
	const { esc, upserts } = makeSetup({ defaultThreshold: 1 });
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	expect(upserts.length).toBe(1);
	esc.reset();
	// After reset, the escalated-set is empty so the same streak re-escalates.
	await esc.handleOutcome("r1", { failed: true, violations: ["a"] });
	expect(upserts.length).toBe(2);
});
