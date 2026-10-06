import { Types } from "mongoose";
import { badRequest } from "./errors.js";

/** Opaque keyset cursor: the sort value and _id of the last item. */
export function encodeCursor(value: Date | null, id: Types.ObjectId): string {
  return Buffer.from(JSON.stringify([value ? value.toISOString() : null, id.toString()])).toString("base64url");
}

export function decodeCursor(cursor: string): { value: Date | null; id: Types.ObjectId } {
  try {
    const [value, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string | null, string];
    if (!Types.ObjectId.isValid(id)) throw new Error("bad id");
    const date = value ? new Date(value) : null;
    if (date && Number.isNaN(date.getTime())) throw new Error("bad date");
    return { value: date, id: new Types.ObjectId(id) };
  } catch {
    throw badRequest("invalid_cursor");
  }
}

/** Filter for items after the cursor for a `{ field: dir, _id: dir }` sort. Nulls sort last when descending. */
export function afterCursor(field: string, dir: 1 | -1, cursor: { value: Date | null; id: Types.ObjectId }) {
  const op = dir === -1 ? "$lt" : "$gt";
  if (cursor.value === null) return { [field]: null, _id: { [op]: cursor.id } };
  return {
    $or: [
      { [field]: { [op]: cursor.value } },
      { [field]: cursor.value, _id: { [op]: cursor.id } },
      ...(dir === -1 ? [{ [field]: null }] : []),
    ],
  };
}
