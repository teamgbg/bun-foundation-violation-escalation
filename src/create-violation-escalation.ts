/**
 * @system violation-escalation
 * @status handwritten
 * @edit edit directly
 *
 * createViolationEscalation — the dedup + escalation state machine.
 *
 * Tracks consecutive failures per slug. A GATE that fails >=threshold cycles
 * (default 3) escalates exactly once: ONE deduped task upsert (keyed by slug,
 * idempotent) + ONE notify. A MONITOR (`isMonitor:true`) is observability-only
 * — it fires `onMonitorUnhealthy` but NEVER escalates (no task, no notify). On
 * recovery (a passing cycle after escalation) the deduped task is closed and
 * `onRecovered` fires; the rule can re-escalate on a fresh failure streak.
 *
 * State is in-memory (survives cycles within a process, resets on daemon
 * restart); the deduped TASK is the persistent recovery source across restarts
 * (the caller's writer upserts/recoverTask own that).
 *
 * Injected (no static storage/transport dep): the task `writer` + optional
 * `notify` + optional event hooks. The primitive owns only the state machine.
 */

import type {
	ViolationEscalation,
	ViolationEscalationConfig,
	ViolationOutcome,
} from "./types";

export function createViolationEscalation(
	config: ViolationEscalationConfig,
): ViolationEscalation {
	const defaultThreshold = config.defaultThreshold ?? 3;
	const taskKeyFor = config.taskKeyFor ?? ((slug: string) => `${config.name}:${slug}`);

	// In-memory escalation state (per-process).
	const consecutive = new Map<string, number>();
	const firstSeenAtMs = new Map<string, number>();
	const escalated = new Set<string>();

	async function handleOutcome(
		slug: string,
		outcome: ViolationOutcome,
	): Promise<{ escalated: boolean }> {
		const threshold = outcome.threshold ?? defaultThreshold;

		// --- recovery path ---
		if (!outcome.failed) {
			const wasEscalated = escalated.has(slug);
			const prev = consecutive.get(slug) ?? 0;
			consecutive.delete(slug);
			firstSeenAtMs.delete(slug);
			if (wasEscalated) {
				escalated.delete(slug);
				await config.writer.recoverTask(taskKeyFor(slug));
				config.onRecovered?.(slug, prev);
			}
			return { escalated: false };
		}

		// --- failure path ---
		const next = (consecutive.get(slug) ?? 0) + 1;
		consecutive.set(slug, next);
		if (next === 1) firstSeenAtMs.set(slug, Date.now());

		if (next < threshold || escalated.has(slug)) {
			return { escalated: false };
		}

		// Threshold crossed + not already escalated.
		const firstSeen = new Date(firstSeenAtMs.get(slug) ?? Date.now());

		// gate-vs-monitor: a MONITOR is observability-only — never escalate.
		if (outcome.isMonitor) {
			config.onMonitorUnhealthy?.(slug, next, outcome.violations, firstSeen);
			return { escalated: false };
		}

		escalated.add(slug);
		const key = taskKeyFor(slug);
		const title = `${config.name} escalation: ${slug}`;
		const description = `Rule '${slug}' has failed ${next}x consecutive cycles.\n\nViolations:\n${outcome.violations.map((v) => `  - ${v}`).join("\n")}\n\nFirst seen: ${firstSeen.toISOString()}`;
		const summary = `escalated: ${next}x consecutive failures`;
		await config.writer.upsertTask({ key, title, description, summary, firstSeenAt: firstSeen });
		await config.notify?.(slug, next, outcome.violations);
		config.onEscalated?.(slug, next, outcome.violations, firstSeen);
		return { escalated: true };
	}

	function reset(): void {
		consecutive.clear();
		firstSeenAtMs.clear();
		escalated.clear();
	}

	return { handleOutcome, reset };
}
