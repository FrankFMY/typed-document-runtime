import { describe, expect, test } from "bun:test";
import type { ProcessDocument } from "./process-document.js";
import { is_canonical_process_document, normalize_process_document } from "./process-document.js";

const STRING = "71000000-0000-4000-8000-000000000001";
const ROOT = "71000000-0000-4000-8000-000000000002";
const INPUT = "71000000-0000-4000-8000-000000000003";
const OUTPUT = "71000000-0000-4000-8000-000000000004";
const EFFECT = "71000000-0000-4000-8000-000000000005";
const EFFECT_STATEMENT = "71000000-0000-4000-8000-000000000006";

const canonical: ProcessDocument = {
	schema: "process.document.v1",
	root_id: ROOT,
	nodes: [
		{ id: STRING, kind: "scalar", value_type: "string" },
		{
			id: ROOT,
			kind: "record",
			fields: [
				{ id: INPUT, name: "input", type_id: STRING, required: true },
				{ id: OUTPUT, name: "output", type_id: STRING, required: false },
			],
		},
	],
	input_cell_ids: [INPUT],
	output_cell_ids: [OUTPUT],
	effects: [],
	program: { schema: "process.program.v1", body: [] },
};

describe("canonical Process document", () => {
	test("normalizes a typed external Process contract canonically", () => {
		const normalized = normalize_process_document({
			...canonical,
			root_id: ROOT.toUpperCase(),
			nodes: [
				{
					id: ROOT.toUpperCase(),
					kind: "record",
					fields: [
						{ id: OUTPUT.toUpperCase(), name: "output", type_id: STRING.toUpperCase(), required: false },
						{ id: INPUT.toUpperCase(), name: "input", type_id: STRING.toUpperCase(), required: true },
					],
				},
				{ id: STRING.toUpperCase(), kind: "scalar", value_type: "string" },
			],
			input_cell_ids: [INPUT.toUpperCase()],
			output_cell_ids: [OUTPUT.toUpperCase()],
		});

		expect(normalized).toEqual(canonical);
		expect(is_canonical_process_document(canonical)).toBe(true);
	});

	test("binds one declared effect use to explicit structurally checked request and result types", () => {
		const document = normalize_process_document({
			...canonical,
			effects: [
				{
					id: EFFECT.toUpperCase(),
					capability: "postgres.probe.append.v1",
					request_cell_id: INPUT.toUpperCase(),
					request_type_id: STRING.toUpperCase(),
					result_cell_id: OUTPUT.toUpperCase(),
					result_type_id: STRING.toUpperCase(),
				},
			],
			program: {
				schema: "process.program.v1",
				body: [{ id: EFFECT_STATEMENT.toUpperCase(), kind: "effect", effect_id: EFFECT.toUpperCase() }],
			},
		});

		expect(document.effects).toEqual([
			{
				id: EFFECT,
				capability: "postgres.probe.append.v1",
				request_cell_id: INPUT,
				request_type_id: STRING,
				result_cell_id: OUTPUT,
				result_type_id: STRING,
			},
		]);
		expect(document.program.body).toEqual([{ id: EFFECT_STATEMENT, kind: "effect", effect_id: EFFECT }]);
	});
});
