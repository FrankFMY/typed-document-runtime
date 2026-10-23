import { expect, test } from "bun:test";
import { z } from "zod";

test("oversized constrained collections reject before element validation", () => {
	let visited = 0;
	const schema = z.array(z.custom(() => {
		visited++;
		return false;
	})).max(4);
	const result = schema.safeParse(Array.from({ length: 100 }, () => 1));
	expect(result.success).toBe(false);
	expect(visited).toBe(0);
	if (!result.success) expect(result.error.issues).toHaveLength(1);
});
