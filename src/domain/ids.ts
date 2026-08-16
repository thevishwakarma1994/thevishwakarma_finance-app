import { v7 as uuidv7 } from "uuid";

export type EntityId = string;

export function newId(): EntityId {
  return uuidv7();
}
