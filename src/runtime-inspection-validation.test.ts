import { describe, expect, test } from "bun:test";
import type { RuntimeInspection } from "./runtime.js";
import { matches_runtime_inspection_terminal, normalize_runtime_inspection } from "./runtime.js";

const BOX_ID = "91000000-0000-4000-8000-000000000001";
const CELL_ID = "91000000-0000-4000-8000-000000000002";

const valid_inspection = (): RuntimeInspection => ({
	schema: "runtime.inspection.v1",
	mode: "values",
	values: "recorded",
	truncated: false,
	events: [
		{
			sequence: 0,
			frame_id: 0,
			parent_frame_id: null,
			depth: 0,
			box_id: BOX_ID,
			kind: "frame.enter",
			statement_id: null,
			expression_id: null,
			cell_id: null,
			value: null,
			outcome: null,
		},
		{
			sequence: 1,
			frame_id: 0,
			parent_frame_id: null,
			depth: 0,
			box_id: BOX_ID,
			kind: "cell.input",
			statement_id: null,
			expression_id: null,
			cell_id: CELL_ID,
			value: { status: "available", value: { nested: [1, "two"] } },
			outcome: null,
		},
		{
			sequence: 2,
			frame_id: 0,
			parent_frame_id: null,
			depth: 0,
			box_id: BOX_ID,
			kind: "frame.exit",
			statement_id: null,
			expression_id: null,
			cell_id: null,
			value: null,
			outcome: "success",
		},
	],
});

describe("RuntimeInspection canonical validation", () => {
	test("detaches and deeply freezes one valid browser-safe inspection", () => {
		const input = valid_inspection();
		const parsed = normalize_runtime_inspection(input);
		expect(parsed).toEqual(input);
		expect(parsed).not.toBe(input);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.events)).toBe(true);
		const value = parsed.events[1]?.value;
		if (value?.status !== "available" || typeof value.value !== "object" || value.value === null || Array.isArray(value.value)) {
			throw new Error("Validated record value missing");
		}
		const record = value.value as Readonly<Record<string, import("./box-document.js").BoxValue>>;
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record.nested)).toBe(true);
	});

	test("a fatal event permits only matching frame unwinding afterward", () => {
		const base = valid_inspection();
		const first = base.events[0]!;
		const fatal = { ...first, sequence: 1, kind: "failure" as const, outcome: "fault" as const };
		const failed_exit = { ...base.events[2]!, outcome: "fault" as const };
		const histories = [
			[first, fatal, base.events[2]!],
			[first, fatal, { ...base.events[1]!, sequence: 2 }, { ...failed_exit, sequence: 3 }],
			[first, fatal, { ...fatal, sequence: 2 }, { ...failed_exit, sequence: 3 }],
		];
		for (const events of histories)
			for (const truncated of [false, true]) {
				const parsed = normalize_runtime_inspection({ ...base, events, truncated });
				expect(matches_runtime_inspection_terminal(parsed, BOX_ID, "fault")).toBe(false);
			}
		const honest = normalize_runtime_inspection({ ...base, events: [first, fatal, failed_exit] });
		expect(matches_runtime_inspection_terminal(honest, BOX_ID, "fault")).toBe(true);
	});

	test("terminal binding retains truncated prefixes and post-body output faults", () => {
		const complete = normalize_runtime_inspection(valid_inspection());
		expect(matches_runtime_inspection_terminal(complete, BOX_ID, "success")).toBe(true);
		expect(matches_runtime_inspection_terminal(complete, CELL_ID, "success")).toBe(false);
		expect(matches_runtime_inspection_terminal(complete, BOX_ID, "fault")).toBe(false);
		const partial = normalize_runtime_inspection({ ...complete, truncated: true, events: complete.events.slice(0, -1) });
		for (const status of ["success", "rejected", "fault"] as const) expect(matches_runtime_inspection_terminal(partial, BOX_ID, status)).toBe(true);
		// The event ceiling may be reached exactly at frame.exit, before output accounting faults.
		expect(matches_runtime_inspection_terminal({ ...complete, truncated: true }, BOX_ID, "fault")).toBe(true);
		const late_fault = normalize_runtime_inspection({
			...complete,
			events: [...complete.events, { ...complete.events[0], sequence: 3, kind: "failure", outcome: "fault" }],
		});
		expect(matches_runtime_inspection_terminal(late_fault, BOX_ID, "fault")).toBe(true);
		expect(matches_runtime_inspection_terminal(late_fault, BOX_ID, "success")).toBe(false);
		const partial_fault = normalize_runtime_inspection({
			...late_fault,
			events: [late_fault.events[0], { ...late_fault.events[3], sequence: 1 }],
			truncated: true,
		});
		expect(matches_runtime_inspection_terminal(partial_fault, BOX_ID, "fault")).toBe(true);
		expect(matches_runtime_inspection_terminal(partial_fault, BOX_ID, "success")).toBe(false);
		expect(matches_runtime_inspection_terminal(partial_fault, BOX_ID, "rejected")).toBe(false);
	});

	test("accepts every lowercase identity admitted by the owning canonical UUID rule", () => {
		const input = valid_inspection();
		input.events[0]!.box_id = "00000000-0000-0000-0000-000000000000";
		input.events[1]!.box_id = "00000000-0000-0000-0000-000000000000";
		input.events[2]!.box_id = "00000000-0000-0000-0000-000000000000";
		expect(normalize_runtime_inspection(input).events[0]?.box_id).toBe("00000000-0000-0000-0000-000000000000");
	});

	test("accepts a source-bound broker failure after an effect-suspended frame", () => {
		const input = valid_inspection();
		input.events[2]!.outcome = "effect";
		input.events.push({
			sequence: 3,
			frame_id: 0,
			parent_frame_id: null,
			depth: 0,
			box_id: BOX_ID,
			kind: "failure",
			statement_id: "91000000-0000-4000-8000-000000000003",
			expression_id: null,
			cell_id: null,
			value: null,
			outcome: "fault",
		});
		expect(matches_runtime_inspection_terminal(normalize_runtime_inspection(input), BOX_ID, "fault")).toBe(true);
		expect(matches_runtime_inspection_terminal(normalize_runtime_inspection(input), BOX_ID, "success")).toBe(false);
		expect(normalize_runtime_inspection(input).events.at(-1)).toMatchObject({
			kind: "failure",
			statement_id: "91000000-0000-4000-8000-000000000003",
			outcome: "fault",
		});
	});
});
