/**
 * @system violation-escalation
 * @status handwritten
 * @edit edit directly
 *
 * Type definitions for the violation-escalation primitive.
 *
 * Capability: persistent-violation escalation. Given a failing rule + signal,
 * ensure exactly ONE deduped task row keyed by slug + one notification; on
 * recovery, close/annotate. Owns the dedup + escalation state machine
 * (consecutive-failure tracking, the escalated set, the threshold/isMonitor
 * decision, the upsert-one-deduped-task + notify + recover coordination).
 *
 * Injected (caller-owned): the task writer (work_items / any store) + the
 * notify transport (scala-agents HTTP / any). The primitive is storage- and
 * transport-agnostic — same shape as event-log's injected-writer pattern.
 */

/** Persistent-task writer the caller injects (owns the storage shape). */
export interface ViolationEscalationTaskWriter {
	/**
	 * Upsert ONE deduped task keyed by `key`. Must be idempotent — a rule that
	 * keeps failing must NOT spawn a second task. Returns the task id (or null
	 * if the writer doesn't track one). Implementations typically:
	 *   - find an existing open task by key → update summary/status
	 *   - else insert a new one
	 */
	upsertTask(args: {
		key: string;
		title: string;
		description: string;
		summary: string;
		firstSeenAt: Date;
	}): Promise<string | null>;
	/** Close/annotate the deduped task on recovery (rule passed). */
	recoverTask(key: string): Promise<void>;
}

/** Optional event hooks — the primitive is event-log-agnostic. */
export interface ViolationEscalationHooks {
	/** Fired when a MONITOR goes unhealthy (observability only — never escalates). */
	onMonitorUnhealthy?: (
		slug: string,
		consecutiveFailures: number,
		violations: string[],
		firstSeenAt: Date,
	) => void;
	/** Fired the cycle a GATE escalates (after the task upsert + notify). */
	onEscalated?: (
		slug: string,
		consecutiveFailures: number,
		violations: string[],
		firstSeenAt: Date,
	) => void;
	/** Fired when a previously-escalated rule recovers. */
	onRecovered?: (slug: string, prevConsecutiveFailures: number) => void;
}

export interface ViolationEscalationConfig extends ViolationEscalationHooks {
	/** `<system>:<purpose>` name, used for the default task-key prefix. */
	name: string;
	/** Persistent-task writer (caller owns the storage shape). */
	writer: ViolationEscalationTaskWriter;
	/** Fired once when a rule newly escalates (caller's transport). */
	notify?: (
		slug: string,
		consecutiveFailures: number,
		violations: string[],
	) => Promise<void>;
	/** Default consecutive-failure threshold (overridable per-call). Default 3. */
	defaultThreshold?: number;
	/** Custom task-key derivation. Default `${name}:${slug}`. */
	taskKeyFor?: (slug: string) => string;
}

export interface ViolationOutcome {
	/** Did the rule fail this cycle? */
	failed: boolean;
	/** Violation lines from this cycle (capped by the caller before passing). */
	violations: string[];
	/**
	 * Live-state monitor readings NEVER escalate (observability only — no task,
	 * no notify). The caller reads this from its row's class field.
	 * Default false (gate — escalates).
	 */
	isMonitor?: boolean;
	/** Per-call threshold override (else config.defaultThreshold). */
	threshold?: number;
}

export interface ViolationEscalation {
	/**
	 * Record one cycle's outcome. Returns `{ escalated: true }` iff THIS call
	 * newly escalated a gate (crossed threshold + not already escalated).
	 */
	handleOutcome(slug: string, outcome: ViolationOutcome): Promise<{ escalated: boolean }>;
	/** Clear all in-memory state (tests, daemon reset). */
	reset(): void;
}
