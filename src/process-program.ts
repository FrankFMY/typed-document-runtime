import { z } from "zod";
import type { BoxProgramStatement } from "./box-program.js";
import { box_program_identities, normalize_box_program, project_box_program_nodes } from "./box-program.js";

const MAX_PROCESS_STATEMENTS = 512;
const MAX_PROCESS_PROGRAM_NODES = 4096;
const input_uuid = z.uuid().transform((value) => value.toLowerCase());

export interface ProcessEffectStatement {
	id: string;
	kind: "effect";
	effect_id: string;
}

export type ProcessProgramStatement = BoxProgramStatement | ProcessEffectStatement;

export interface ProcessProgram {
	schema: "process.program.v1";
	body: ProcessProgramStatement[];
}

const effect_statement = z.strictObject({
	id: input_uuid,
	kind: z.literal("effect"),
	effect_id: input_uuid,
});

const input_program = z.strictObject({
	schema: z.literal("process.program.v1"),
	body: z.array(z.unknown()).max(MAX_PROCESS_STATEMENTS),
});

const is_effect_input = (value: unknown): boolean =>
	typeof value === "object" && value !== null && !Array.isArray(value) && (value as { kind?: unknown }).kind === "effect";

export const process_program_identities = (program: ProcessProgram): string[] => {
	const ordinary: BoxProgramStatement[] = [];
	const identities: string[] = [];
	for (const statement of program.body) {
		if (statement.kind === "effect") identities.push(statement.id);
		else ordinary.push(statement);
	}
	identities.push(...box_program_identities({ schema: "box.program.v1", body: ordinary }));
	return identities;
};

export const project_process_program_nodes = (program: ProcessProgram): { id: string; value: Record<string, unknown> }[] => {
	const ordinary: BoxProgramStatement[] = [];
	const projected: { id: string; value: Record<string, unknown> }[] = [];
	for (const statement of program.body) {
		if (statement.kind === "effect") {
			projected.push({ id: statement.id, value: { id: statement.id, kind: statement.kind, effect_id: statement.effect_id } });
		} else {
			ordinary.push(statement);
		}
	}
	projected.push(...project_box_program_nodes({ schema: "box.program.v1", body: ordinary }));
	return projected.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
};

export const normalize_process_program = (input: unknown): ProcessProgram => {
	const parsed = input_program.parse(input);
	const ordinary_input = parsed.body.filter((statement) => !is_effect_input(statement));
	const ordinary = normalize_box_program({ schema: "box.program.v1", body: ordinary_input }).body;
	let ordinary_index = 0;
	const body = parsed.body.map((statement): ProcessProgramStatement => {
		if (is_effect_input(statement)) return effect_statement.parse(statement);
		const normalized = ordinary[ordinary_index];
		ordinary_index += 1;
		if (!normalized) throw new Error("Process program statement is invalid");
		return normalized;
	});
	const program: ProcessProgram = { schema: parsed.schema, body };
	const identities = process_program_identities(program);
	if (new Set(identities).size !== identities.length) throw new Error("Process program contains duplicate identity");
	if (project_process_program_nodes(program).length > MAX_PROCESS_PROGRAM_NODES) throw new Error("Process program has too many nodes");
	return program;
};
