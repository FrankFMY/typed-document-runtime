import { validate_package_graph } from "./application-package.js";
import type { ProjectSourceSnapshot } from "./project-source-snapshot.js";
import { project_source_values_equal as equal, normalize_project_source_revision_snapshot } from "./project-source-snapshot.js";

export interface PackageConflict {
	path: string;
	base: unknown;
	local: unknown;
	incoming: unknown;
}
export interface PackageMerge {
	source: ProjectSourceSnapshot;
	conflicts: PackageConflict[];
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keyed = (value: unknown[]): value is { id: string }[] =>
	value.every((item) => record(item) && typeof item.id === "string") &&
	new Set(value.map((item) => (item as { id: string }).id)).size === value.length;

const semantic = (snapshot: ProjectSourceSnapshot): unknown => ({
	realms: snapshot.realms,
	boxes: snapshot.boxes.map(({ document_version: _version, ...box }) => box),
});

// Merge the canonical document data directly. The output is always admitted again by
// the existing snapshot/document normalizers; this is not an executable representation.
export const merge_package_source = (
	base: ProjectSourceSnapshot,
	local: ProjectSourceSnapshot,
	incoming: ProjectSourceSnapshot,
	resolutions: Record<string, "local" | "incoming"> = {},
): PackageMerge => {
	const conflicts: PackageConflict[] = [];
	const used = new Set<string>();
	const conflict = (path: string, before: unknown, current: unknown, next: unknown): unknown => {
		const item = { path, base: before ?? null, local: current ?? null, incoming: next ?? null };
		conflicts.push(item);
		if (Object.hasOwn(resolutions, path)) used.add(path);
		return resolutions[path] === "incoming" ? next : current;
	};
	const merge = (before: unknown, current: unknown, next: unknown, path: string): unknown => {
		if (equal(current, next) || equal(before, next)) return current;
		if (equal(before, current)) return next;
		if (record(before) && record(current) && record(next)) {
			const result: Record<string, unknown> = {};
			for (const key of [...new Set([...Object.keys(before), ...Object.keys(current), ...Object.keys(next)])].sort()) {
				const value = merge(before[key], current[key], next[key], `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
				if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
			}
			return result;
		}
		if (Array.isArray(before) && Array.isArray(current) && Array.isArray(next) && keyed(before) && keyed(current) && keyed(next)) {
			const maps = [before, current, next].map((items) => new Map(items.map((item) => [item.id, item])));
			const values = new Map<string, unknown>();
			for (const id of new Set([...before, ...current, ...next].map((item) => item.id))) {
				const value = merge(maps[0]!.get(id), maps[1]!.get(id), maps[2]!.get(id), `${path}/@${id}`);
				if (value !== undefined) values.set(id, value);
			}
			const common = new Set(before.filter((item) => maps[1]!.has(item.id) && maps[2]!.has(item.id)).map((item) => item.id));
			const order = (items: { id: string }[]): string[] => items.filter((item) => common.has(item.id)).map((item) => item.id);
			const before_order = order(before),
				current_order = order(current),
				next_order = order(next);
			let preferred = equal(before_order, current_order) ? next : current;
			if (!equal(current_order, next_order) && !equal(before_order, current_order) && !equal(before_order, next_order)) {
				preferred = equal(conflict(`${path}/$order`, before_order, current_order, next_order), next_order) ? next : current;
			}
			const ids = preferred.map((item) => item.id).filter((id) => values.has(id));
			for (const items of [next, current]) {
				let previous: string | undefined;
				for (const item of items) {
					if (!values.has(item.id)) continue;
					if (!ids.includes(item.id)) ids.splice(previous === undefined ? 0 : ids.indexOf(previous) + 1, 0, item.id);
					previous = item.id;
				}
			}
			return ids.map((id) => values.get(id));
		}
		return conflict(path, before, current, next);
	};

	const merged = merge(semantic(base), semantic(local), semantic(incoming), "") as {
		realms: ProjectSourceSnapshot["realms"];
		boxes: Omit<ProjectSourceSnapshot["boxes"][number], "document_version">[];
	};
	if (Object.keys(resolutions).some((key) => !used.has(key))) throw new Error("package_resolution_stale");
	const source = normalize_project_source_revision_snapshot({
		...local,
		...merged,
		boxes: merged.boxes.map((box) => ({
			id: box.id,
			realm_id: box.realm_id,
			parent_id: box.parent_id,
			name: box.name,
			document: box.document,
			document_version: local.boxes.find((item) => item.id === box.id)?.document_version ?? "0",
			presentation: box.presentation,
		})),
	});
	validate_package_graph(source);
	return { source, conflicts };
};
