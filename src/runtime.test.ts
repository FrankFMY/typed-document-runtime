import { describe, expect, test } from "bun:test";
import { normalize_project_source_snapshot } from "./project-source-snapshot.js";
import type { RuntimeInspection, RuntimeInspectionEvent, RuntimeInspectionValue, RuntimePublication } from "./runtime.js";
import { execute_project_runtime } from "./runtime.js";

const PUBLICATION_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "10000000-0000-4000-8000-000000000002";
const REALM_ID = "10000000-0000-4000-8000-000000000003";
const BOX_ID = "10000000-0000-4000-8000-000000000004";
const STRING_ID = "10000000-0000-4000-8000-000000000005";
const ROOT_ID = "10000000-0000-4000-8000-000000000006";
const OUTPUT_ID = "10000000-0000-4000-8000-000000000007";
const STATEMENT_ID = "10000000-0000-4000-8000-000000000008";
const EXPRESSION_ID = "10000000-0000-4000-8000-000000000009";

const publication: RuntimePublication = {
	id: PUBLICATION_ID,
	snapshot: {
		schema: "project.source.snapshot.v1",
		project_id: PROJECT_ID,
		revision: "1",
		realms: [{ id: REALM_ID, name: "Main", is_primary: true }],
		boxes: [
			{
				id: BOX_ID,
				realm_id: REALM_ID,
				parent_id: null,
				name: "Card",
				document_version: "1",
				document: {
					schema: "box.document.v2",
					root_id: ROOT_ID,
					nodes: [
						{ id: STRING_ID, kind: "scalar", value_type: "string" },
						{
							id: ROOT_ID,
							kind: "record",
							fields: [{ id: OUTPUT_ID, name: "title", type_id: STRING_ID, required: false }],
						},
					],
					program: {
						schema: "box.program.v1",
						body: [
							{
								id: STATEMENT_ID,
								kind: "write",
								cell_id: OUTPUT_ID,
								value: { id: EXPRESSION_ID, kind: "literal", type_id: STRING_ID, value: "Product" },
							},
						],
					},
				},
			},
		],
	},
};

const budget = { max_steps: 100, max_call_depth: 8, max_value_nodes: 100, max_string_units: 10_000 };

describe("minimum deterministic runtime", () => {
	test("executes one explicit immutable publication and returns selected cells", () => {
		expect(
			execute_project_runtime({
				publication,
				entry_box_id: BOX_ID,
				input: [],
				output_cell_ids: [OUTPUT_ID],
				budget,
			}),
		).toEqual({
			status: "success",
			publication_id: PUBLICATION_ID,
			project_id: PROJECT_ID,
			source_revision: "1",
			outputs: [{ cell_id: OUTPUT_ID, value: "Product" }],
			usage: { steps: 2, calls: 1, value_nodes: 1, string_units: 14 },
			trace: [
				{ sequence: 0, kind: "box.enter", box_id: BOX_ID, depth: 0 },
				{ sequence: 1, kind: "statement", box_id: BOX_ID, statement_id: STATEMENT_ID, statement_kind: "write" },
				{ sequence: 2, kind: "cell.write", box_id: BOX_ID, statement_id: STATEMENT_ID, cell_id: OUTPUT_ID },
				{ sequence: 3, kind: "box.exit", box_id: BOX_ID, depth: 0, outcome: "success" },
			],
		});
	});

	test("captures a structure-only frame without changing the existing execution result", () => {
		const outcome = execute_project_runtime({
			publication,
			entry_box_id: BOX_ID,
			input: [],
			output_cell_ids: [OUTPUT_ID],
			budget,
			inspection: "structure",
		});
		const inspection: RuntimeInspection | undefined = outcome.inspection;
		expect(inspection).toEqual({
			schema: "runtime.inspection.v1",
			mode: "structure",
			values: "not_requested",
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
					cell_id: OUTPUT_ID,
					value: { status: "uninitialized" },
					outcome: null,
				},
				{
					sequence: 2,
					frame_id: 0,
					parent_frame_id: null,
					depth: 0,
					box_id: BOX_ID,
					kind: "statement",
					statement_id: STATEMENT_ID,
					expression_id: null,
					cell_id: null,
					value: null,
					outcome: null,
				},
				{
					sequence: 3,
					frame_id: 0,
					parent_frame_id: null,
					depth: 0,
					box_id: BOX_ID,
					kind: "expression",
					statement_id: STATEMENT_ID,
					expression_id: EXPRESSION_ID,
					cell_id: null,
					value: { status: "not_recorded" },
					outcome: null,
				},
				{
					sequence: 4,
					frame_id: 0,
					parent_frame_id: null,
					depth: 0,
					box_id: BOX_ID,
					kind: "cell.write",
					statement_id: STATEMENT_ID,
					expression_id: null,
					cell_id: OUTPUT_ID,
					value: { status: "not_recorded" },
					outcome: null,
				},
				{
					sequence: 5,
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
			] satisfies RuntimeInspectionEvent[],
		});
		const uninitialized: RuntimeInspectionValue = { status: "uninitialized" };
		expect(inspection?.events[1]?.value).toEqual(uninitialized);
		expect(Object.isFrozen(inspection)).toBe(true);
		expect(Object.isFrozen(inspection?.events)).toBe(true);
		expect(Object.isFrozen(inspection?.events[1])).toBe(true);
		expect({ ...outcome, inspection: undefined }).toEqual({
			...execute_project_runtime({ publication, entry_box_id: BOX_ID, input: [], output_cell_ids: [OUTPUT_ID], budget }),
			inspection: undefined,
		});
	});

	test("preserves an initialized business null in frame input inspection", () => {
		const nullable = structuredClone(publication);
		const box = nullable.snapshot.boxes[0];
		if (!box || box.document.schema !== "box.document.v2") throw new Error("Executable fixture missing");
		const absence_type_id = "10000000-0000-4000-8000-000000000010";
		const absence_cell_id = "10000000-0000-4000-8000-000000000011";
		box.document.nodes.push({ id: absence_type_id, kind: "scalar", value_type: "absence" });
		const root = box.document.nodes.find((node) => node.id === ROOT_ID);
		if (!root || root.kind !== "record") throw new Error("Root fixture missing");
		root.fields.push({ id: absence_cell_id, name: "nothing", type_id: absence_type_id, required: true });
		nullable.snapshot = normalize_project_source_snapshot(nullable.snapshot);
		const outcome = execute_project_runtime({
			publication: nullable,
			entry_box_id: BOX_ID,
			input: [{ cell_id: absence_cell_id, value: null }],
			output_cell_ids: [OUTPUT_ID],
			budget,
			inspection: "values",
		});
		expect(outcome).toMatchObject({ status: "success" });
		expect(outcome.inspection?.events.find((event) => event.kind === "cell.input" && event.cell_id === absence_cell_id)?.value).toEqual({
			status: "available",
			value: null,
		});
	});

	test("records a root-bound failure after a successful frame when final output is uninitialized", () => {
		const missing_output = structuredClone(publication);
		const box = missing_output.snapshot.boxes[0];
		if (!box || box.document.schema !== "box.document.v2") throw new Error("Executable fixture missing");
		box.document.program.body = [];
		const outcome = execute_project_runtime({
			publication: missing_output,
			entry_box_id: BOX_ID,
			input: [],
			output_cell_ids: [OUTPUT_ID],
			budget,
			inspection: "structure",
		});
		expect(outcome).toMatchObject({ status: "fault", fault: { code: "uninitialized_cell" } });
		expect(outcome.inspection?.events.slice(-2)).toEqual([
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
			{
				sequence: 3,
				frame_id: 0,
				parent_frame_id: null,
				depth: 0,
				box_id: BOX_ID,
				kind: "failure",
				statement_id: null,
				expression_id: null,
				cell_id: OUTPUT_ID,
				value: null,
				outcome: "fault",
			},
		]);
	});

	test("rejects a noncanonical publication identity without executing", () => {
		expect(
			execute_project_runtime({
				publication: { ...publication, id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
				entry_box_id: BOX_ID,
				input: [],
				output_cell_ids: [OUTPUT_ID],
				budget,
			}),
		).toMatchObject({
			status: "fault",
			fault: { code: "invalid_publication" },
			trace: [],
			usage: { steps: 0, calls: 0, value_nodes: 0, string_units: 0 },
		});
	});
});
